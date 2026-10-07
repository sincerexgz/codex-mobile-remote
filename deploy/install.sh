#!/usr/bin/env bash
set -euo pipefail
# Two stages: prepare the private relay, then enable HTTPS after ACME access.
stage=${1:-prepare}
remote_host=${2:?Provide your own domain or public IP}
[[ "$remote_host" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid hostname'; exit 1; }
[[ "$EUID" -eq 0 ]] || { echo 'Run as root'; exit 1; }
umask 022
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
app_dir=/opt/codex-mobile-remote
certbot=/opt/codex-certbot/bin/certbot

if [[ "$stage" == prepare ]]; then
  if [[ ! -f /etc/systemd/system/codex-remote-relay.service ]] && ss -ltnH 'sport = :8787' | grep -q .; then
    echo 'Port 8787 already belongs to another service. No changes made.'
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg nginx python3-venv
  node_major=$(node --version 2>/dev/null | sed 's/^v//;s/\..*//' || true)
  if [[ -z "$node_major" ]] || (( node_major < 22 )); then
    install -d -m 0755 /etc/apt/keyrings
    curl --fail --silent --show-error --location https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/codex-nodesource.asc
    gpg --batch --yes --dearmor -o /etc/apt/keyrings/codex-nodesource.gpg /tmp/codex-nodesource.asc
    chmod 0644 /etc/apt/keyrings/codex-nodesource.gpg
    echo 'deb [signed-by=/etc/apt/keyrings/codex-nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/codex-nodesource.list
    apt-get update
    apt-get install -y nodejs
  fi
  id codexremote >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin codexremote
  install -d -m 0755 "$app_dir"
  cp "$source_dir/relay.js" "$app_dir/relay.js"
  cp "$source_dir/relay-pairing.js" "$source_dir/relay-session.js" "$app_dir/"
  cp "$source_dir/deploy/package.json" "$app_dir/package.json"
  cp -a "$source_dir/public" "$app_dir/"
  install -d -m 0755 "$app_dir/node_modules"
  cp -a "$source_dir/node_modules/ws" "$app_dir/node_modules/"
  chmod -R u=rwX,go=rX "$app_dir"
  if [[ ! -f /etc/codex-mobile-remote.env ]]; then
    if [[ -f "$source_dir/deploy/server.env" ]]; then
      install -m 0600 "$source_dir/deploy/server.env" /etc/codex-mobile-remote.env
    else
      install -m 0600 /dev/null /etc/codex-mobile-remote.env
      cat > /etc/codex-mobile-remote.env <<EOF
RELAY_HOST=127.0.0.1
RELAY_PORT=8787
REGISTRATION_KEY=$(openssl rand -hex 32)
EOF
      chmod 0600 /etc/codex-mobile-remote.env
    fi
  fi
  install -m 0644 "$source_dir/deploy/codex-remote-relay.service" /etc/systemd/system/codex-remote-relay.service
  systemctl daemon-reload
  systemctl enable --now codex-remote-relay.service
  systemctl restart codex-remote-relay.service
  curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8787/api/health
  echo
  python3 -m venv /opt/codex-certbot
  /opt/codex-certbot/bin/pip install --upgrade pip certbot
  install -d -m 0755 /var/www/codex-acme/.well-known/acme-challenge
  # Only the challenge path is exposed over HTTP at this stage.
  cat > /etc/nginx/conf.d/codex-mobile-remote.conf <<EOF
server {
    listen 80;
    server_name $remote_host;
    access_log off;
    location /.well-known/acme-challenge/ { root /var/www/codex-acme; }
    location / { return 503; }
}
EOF
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  echo 'PREPARED: Relay is private on 127.0.0.1:8787. HTTPS certificate not issued yet.'
elif [[ "$stage" == https ]]; then
  args=(certonly --non-interactive --agree-tos --register-unsafely-without-email
        --webroot -w /var/www/codex-acme --cert-name codex-mobile-remote
        --preferred-challenges http --server https://acme-v02.api.letsencrypt.org/directory)
  if [[ "$remote_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    args+=(--ip-address "$remote_host" --required-profile shortlived)
  else
    args+=(-d "$remote_host")
  fi
  "$certbot" "${args[@]}"
  sed "s/REMOTE_HOST/$remote_host/g" "$source_dir/deploy/nginx.conf.template" > /etc/nginx/conf.d/codex-mobile-remote.conf
  nginx -t
  systemctl reload nginx
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/codex-nginx <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/codex-nginx
  cat > /etc/systemd/system/codex-cert-renew.service <<'EOF'
[Unit]
Description=Renew Codex HTTPS certificate
After=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/codex-certbot/bin/certbot renew --quiet
EOF
  cat > /etc/systemd/system/codex-cert-renew.timer <<'EOF'
[Unit]
Description=Check Codex HTTPS certificate renewal hourly
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now codex-cert-renew.timer
  systemctl is-active codex-remote-relay nginx
  curl --fail --silent --resolve "$remote_host:443:127.0.0.1" "https://$remote_host/api/health"
  echo
  echo "DEPLOYED: https://$remote_host/chat"
else
  echo 'Usage: bash deploy/install.sh prepare|https HOST'
  exit 1
fi
