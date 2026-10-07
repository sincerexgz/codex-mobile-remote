import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = path.join(root, 'deploy', 'artifacts');
const bundle = path.join(artifacts, 'bundle');
fs.mkdirSync(path.join(bundle, 'deploy'), { recursive: true });
fs.mkdirSync(path.join(bundle, 'node_modules'), { recursive: true });
const includeServerEnv = process.argv.includes('--include-server-env');
const envPath = path.join(artifacts, 'server.env');
if (includeServerEnv) {
  if (!fs.existsSync(envPath)) throw new Error('Requested server.env is missing.');
  fs.copyFileSync(envPath, path.join(bundle, 'deploy', 'server.env'));
}
for (const name of ['install.sh', 'package.json', 'nginx.conf.template', 'codex-remote-relay.service']) {
  fs.copyFileSync(path.join(root, 'deploy', name), path.join(bundle, 'deploy', name));
}
for (const name of ['relay.js','relay-pairing.js','relay-session.js']) fs.copyFileSync(path.join(root,name),path.join(bundle,name));
fs.cpSync(path.join(root, 'public'), path.join(bundle, 'public'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules', 'ws'), path.join(bundle, 'node_modules', 'ws'), { recursive: true });
const archive = path.join(artifacts, 'codex-mobile-cloud.tar.gz');
const tarArgs = ['-czf', archive];
if (!includeServerEnv) tarArgs.push('--exclude=./deploy/server.env');
tarArgs.push('-C', bundle, '.');
execFileSync('tar', tarArgs, { stdio: 'pipe' });
console.log(`Bundle saved: ${archive}`);
console.log(`Size: ${fs.statSync(archive).size} bytes`);
console.log(`SHA256: ${crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`);
