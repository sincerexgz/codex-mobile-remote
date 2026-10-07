package com.codexremote.mobile;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLDecoder;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import org.json.JSONObject;

@CapacitorPlugin(name = "RemoteAccess", permissions = {
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class RemoteAccessPlugin extends Plugin {
    private static final String KEY_ALIAS = "codex_remote_connection_v1";
    private static final int MAX_BODY = 2 * 1024 * 1024;
    private final ExecutorService requests = Executors.newFixedThreadPool(3);
    private final ExecutorService events = Executors.newSingleThreadExecutor();
    private volatile boolean foreground = true;
    private volatile boolean eventsEnabled = false;
    private volatile int eventGeneration = 0;
    private volatile HttpsURLConnection eventConnection;
    private Future<?> eventTask;

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("codex_connection", Context.MODE_PRIVATE);
    }

    private SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }

    private synchronized void storeConnection(JSONObject connection) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
        byte[] encrypted = cipher.doFinal(connection.toString().getBytes(StandardCharsets.UTF_8));
        if (!preferences().edit()
            .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("encrypted", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) {
            throw new Exception("手机无法保存连接信息，请重试。");
        }
    }

    private synchronized JSONObject savedConnection() throws Exception {
        String encrypted = preferences().getString("encrypted", null);
        if (encrypted == null) throw new Exception("未设置连接，请扫描二维码或粘贴访问链接。");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(),
            new GCMParameterSpec(128, Base64.decode(preferences().getString("iv", ""), Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }

    private JSONObject parseConnection(String link) throws Exception {
        URI uri;
        try { uri = new URI(link.trim()); }
        catch (Exception ignored) { throw new Exception("链接格式不正确，请复制电脑上的完整手机远程链接。"); }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
            || uri.getFragment() != null || uri.getPort() > 65535 || uri.getPort() == 0
            || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()) || "/chat".equals(uri.getPath()))) {
            throw new Exception("请使用电脑生成的完整 HTTPS 手机远程链接。");
        }
        String token = "";
        for (String parameter : (uri.getRawQuery() == null ? "" : uri.getRawQuery()).split("&")) {
            String[] pair = parameter.split("=", 2);
            if (pair.length == 2 && "token".equals(URLDecoder.decode(pair[0], "UTF-8"))) {
                token = URLDecoder.decode(pair[1], "UTF-8");
            }
        }
        if (token.length() < 32 || token.length() > 1024 || !token.matches("[\\x21-\\x7E]+")) {
            throw new Exception("链接缺少有效访问令牌，请复制包含 token 的完整链接。");
        }
        String origin = new URI("https", null, uri.getHost(), uri.getPort(), null, null, null).toASCIIString();
        return new JSONObject().put("origin", origin).put("token", token);
    }

    private JSObject publicConnection(JSONObject connection) {
        JSObject result = new JSObject();
        result.put("configured", true);
        result.put("origin", connection.optString("origin"));
        result.put("deviceName", connection.optString("deviceName"));
        result.put("deviceId", connection.optString("deviceId"));
        return result;
    }

    @PluginMethod public void getConnection(PluginCall call) {
        try { call.resolve(publicConnection(savedConnection())); }
        catch (Exception ignored) { JSObject result = new JSObject(); result.put("configured", false); call.resolve(result); }
    }

    @PluginMethod public void saveConnection(PluginCall call) {
        final String link = call.getString("link", "");
        requests.execute(() -> {
            try {
                JSONObject connection = parseConnection(link);
                JSObject response = executeRequest(connection, "/api/threads", "GET", "");
                int status = response.getInteger("status", 0);
                if (status == 401) throw new Exception("401：访问链接已失效，请使用电脑上的完整链接。");
                if (status != 200 || !(new JSONObject(response.getString("body", "{}")).opt("threads") instanceof org.json.JSONArray)) {
                    throw new Exception("服务器没有返回 Codex 对话列表，请确认使用了正确的手机远程链接。");
                }
                stopEventWorker();
                storeConnection(connection);
                call.resolve(publicConnection(connection));
            } catch (Exception error) { call.reject(readableError(error)); }
        });
    }

    @PluginMethod public void clearConnection(PluginCall call) {
        eventsEnabled = false;
        stopEventWorker();
        requests.execute(() -> {
            boolean revoked = false;
            try {
                JSONObject connection = savedConnection();
                if (!connection.optString("deviceId").isEmpty()) {
                    JSObject response = executeRequest(connection, "/api/unpair", "POST", "{}");
                    revoked = response.getInteger("status", 0) == 200 || response.getInteger("status", 0) == 401;
                }
            } catch (Exception ignored) {}
            preferences().edit().clear().commit();
            JSObject result = new JSObject(); result.put("remoteRevoked", revoked); call.resolve(result);
        });
    }

    @PluginMethod public void pairDevice(PluginCall call) {
        final String requestedServer = call.getString("server", "");
        final String code = call.getString("code", "").toUpperCase(java.util.Locale.ROOT).replaceAll("[\\s-]", "");
        requests.execute(() -> {
            try {
                URI server = new URI(requestedServer.trim());
                if (!"https".equalsIgnoreCase(server.getScheme()) || server.getHost() == null || server.getUserInfo() != null
                    || server.getQuery() != null || server.getFragment() != null || server.getPort() > 65535 || server.getPort() == 0
                    || !(server.getPath().isEmpty() || "/".equals(server.getPath()))) throw new Exception("请输入正确的 HTTPS 服务器地址。");
                if (!code.matches("[0-9]{4}")) throw new Exception("请输入电脑窗口上的四位数字配对码。");
                String origin = new URI("https", null, server.getHost(), server.getPort(), null, null, null).toASCIIString();
                JSONObject credentials = new JSONObject().put("origin", origin).put("token", "");
                JSONObject body = new JSONObject().put("code", code).put("name", "Android 手机");
                JSObject response = executeRequest(credentials, "/api/pair", "POST", body.toString());
                int status = response.getInteger("status", 0);
                JSONObject data;
                try { data = new JSONObject(response.getString("body", "{}")); }
                catch (Exception ignored) { throw new Exception("服务器未启用配对，请先升级云端服务。"); }
                if (status != 200) throw new Exception(data.optString("error", "配对失败，请在电脑重新生成配对码。"));
                String token = data.optString("token");
                JSONObject device = data.optJSONObject("device");
                if (!token.matches("[a-f0-9]{64}") || device == null || device.optString("id").isEmpty()) throw new Exception("服务器返回的配对信息无效。");
                credentials.put("token", token).put("deviceId", device.getString("id"))
                    .put("deviceName", device.optString("name", "我的电脑")).put("phoneId", data.optString("phoneId"));
                stopEventWorker();
                storeConnection(credentials);
                call.resolve(publicConnection(credentials));
            } catch (Exception error) { call.reject(readableError(error)); }
        });
    }

    private HttpsURLConnection connection(JSONObject credentials, String path) throws Exception {
        URI relative = new URI(path);
        String route = relative.getPath();
        if (relative.isAbsolute() || relative.getRawAuthority() != null || relative.getFragment() != null
            || route == null || !route.startsWith("/api/") || route.contains("..") || route.contains("\\")) {
            throw new Exception("无效的服务请求。");
        }
        HttpsURLConnection connection = (HttpsURLConnection) new URI(credentials.getString("origin") + path).toURL().openConnection();
        // Follow no redirects: bearer credentials belong to this exact server.
        // Keep Android's default HTTPS certificate and hostname validation.
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(45000);
        if (!credentials.optString("token").isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + credentials.getString("token"));
        connection.setRequestProperty("Accept", "application/json");
        connection.setUseCaches(false);
        return connection;
    }

    private JSObject executeRequest(JSONObject credentials, String path, String method, String body) throws Exception {
        if (!"GET".equals(method) && !"POST".equals(method)) throw new Exception("不支持的请求方式。");
        HttpsURLConnection connection = connection(credentials, path);
        try {
            connection.setRequestMethod(method);
            if ("POST".equals(method)) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 128 * 1024) throw new Exception("消息过长，请分段发送。");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream stream = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream content = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] buffer = new byte[8192];
                int length;
                while ((length = input.read(buffer)) != -1) {
                    if (content.size() + length > MAX_BODY) throw new Exception("对话内容过大，请选择其他会话后重试。");
                    content.write(buffer, 0, length);
                }
            }
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", content.toString("UTF-8"));
            return result;
        } finally { connection.disconnect(); }
    }

    @PluginMethod public void request(PluginCall call) {
        final String path = call.getString("path", "");
        final String method = call.getString("method", "GET");
        final String body = call.getString("body", "");
        requests.execute(() -> {
            try { call.resolve(executeRequest(savedConnection(), path, method, body)); }
            catch (Exception error) { call.reject(readableError(error)); }
        });
    }

    @PluginMethod public void startEvents(PluginCall call) {
        try { savedConnection(); }
        catch (Exception error) { call.reject(readableError(error)); return; }
        eventsEnabled = true;
        startEventWorker();
        call.resolve();
    }

    @PluginMethod public void stopEvents(PluginCall call) {
        eventsEnabled = false;
        stopEventWorker();
        call.resolve();
    }

    private synchronized void startEventWorker() {
        if (!foreground || !eventsEnabled || (eventTask != null && !eventTask.isDone())) return;
        final int generation = ++eventGeneration;
        eventTask = events.submit(() -> {
            while (foreground && eventsEnabled && eventGeneration == generation && !Thread.currentThread().isInterrupted()) {
                HttpsURLConnection connection = null;
                try {
                    connection = connection(savedConnection(), "/api/events");
                    connection.setReadTimeout(45000);
                    connection.setRequestProperty("Accept", "text/event-stream");
                    eventConnection = connection;
                    int status = connection.getResponseCode();
                    if (status != 200) {
                        if (status == 401) {
                            emitConnection("访问链接已失效，请重新连接。", true);
                            eventsEnabled = false;
                            break;
                        }
                        throw new Exception("HTTP " + status);
                    }
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                        String type = "";
                        StringBuilder data = new StringBuilder();
                        String line;
                        while (foreground && eventsEnabled && eventGeneration == generation && (line = reader.readLine()) != null) {
                            if (line.isEmpty()) {
                                if (!type.isEmpty() && data.length() > 0) {
                                    JSObject event = new JSObject();
                                    event.put("type", type);
                                    event.put("data", new JSONObject(data.toString()));
                                    notifyListeners("relayEvent", event);
                                }
                                type = "";
                                data.setLength(0);
                            } else if (line.startsWith("event:")) type = line.substring(6).trim();
                            else if (line.startsWith("data:")) {
                                if (data.length() > 0) data.append('\n');
                                data.append(line.substring(5).trim());
                                if (data.length() > MAX_BODY) throw new Exception("服务消息过大。");
                            }
                        }
                    }
                } catch (Exception error) {
                    if (foreground && eventsEnabled && eventGeneration == generation) emitConnection("同步断开，正在重连", false);
                } finally {
                    if (connection != null) connection.disconnect();
                    if (eventConnection == connection) eventConnection = null;
                }
                if (foreground && eventsEnabled && eventGeneration == generation) {
                    try { Thread.sleep(3000); }
                    catch (InterruptedException ignored) { Thread.currentThread().interrupt(); break; }
                }
            }
        });
    }

    private synchronized void stopEventWorker() {
        ++eventGeneration;
        HttpsURLConnection active = eventConnection;
        eventConnection = null;
        if (active != null) active.disconnect();
        if (eventTask != null) eventTask.cancel(true);
        eventTask = null;
    }

    private void emitConnection(String message, boolean unauthorized) {
        JSObject data = new JSObject(); data.put("message", message); data.put("unauthorized", unauthorized);
        JSObject event = new JSObject(); event.put("type", "connection"); event.put("data", data);
        notifyListeners("relayEvent", event);
    }

    @Override protected void handleOnResume() {
        foreground = true;
        startEventWorker();
        JSObject state = new JSObject(); state.put("isActive", true); notifyListeners("appStateChange", state);
    }

    @Override protected void handleOnPause() {
        foreground = false;
        stopEventWorker();
        JSObject state = new JSObject(); state.put("isActive", false); notifyListeners("appStateChange", state);
    }

    @Override protected void handleOnDestroy() {
        eventsEnabled = false;
        stopEventWorker();
        events.shutdownNow();
        requests.shutdownNow();
    }

    @PluginMethod public void scanLink(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) requestPermissionForAlias("camera", call, "cameraPermission");
        else launchScanner(call);
    }

    @PermissionCallback private void cameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) launchScanner(call);
        else call.reject("需要相机权限才能扫码。你也可以直接粘贴完整访问链接。");
    }

    private void launchScanner(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ScanOptions options = new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("扫描电脑上的 Codex 手机远程二维码")
                .setBeepEnabled(false).setOrientationLocked(false).setBarcodeImageEnabled(false);
            startActivityForResult(call, options.createScanIntent(getContext()), "scannerResult");
        });
    }

    @ActivityCallback private void scannerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ScanIntentResult scan = ScanIntentResult.parseActivityResult(result.getResultCode(), result.getData());
        JSObject response = new JSObject();
        response.put("cancelled", scan.getContents() == null);
        if (scan.getContents() != null) response.put("text", scan.getContents());
        call.resolve(response);
    }

    public void onBackRequested() { notifyListeners("backPressed", new JSObject()); }

    @PluginMethod public void closeApp(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }

    @PluginMethod public void openLink(PluginCall call) {
        try {
            Uri uri = Uri.parse(call.getString("url", ""));
            if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) throw new Exception();
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
            call.resolve();
        } catch (Exception ignored) { call.reject("手机无法打开此链接。"); }
    }

    private String readableError(Exception error) {
        if (error instanceof SSLException) return "服务器证书验证失败，请检查手机时间和服务器证书。";
        if (error instanceof SocketTimeoutException) return "连接超时，请检查手机网络后重试。";
        String message = error.getMessage();
        if (message != null && (message.contains("请") || message.contains("配对") || message.contains("无效") || message.contains("未设置") || message.contains("401"))) return message;
        return "连接失败，请确认手机可以访问云服务器后重试。";
    }
}
