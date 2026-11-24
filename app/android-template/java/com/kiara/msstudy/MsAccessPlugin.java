package com.kiara.msstudy;

import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Capacitor bridge for the MS Study access-password system (Phase 1).
 *
 * Mirrors the PW app's PwAccessPlugin (pw-apk/.../PwAccessPlugin.java) in
 * structure: background-thread POST, serialized on VALIDATE_LOCK so the
 * 15s silent revalidation can never pile up while the free Render
 * service cold-starts (~30-60s), and the same result vocabulary.
 *
 * Server contract:
 *   POST https://ms-study-server.onrender.com/validate
 *   {password, deviceId, deviceLabel} ->
 *     {result: "valid", role: "admin"|"user"}
 *     {result: "incorrect"} | {result: "kicked"} |
 *     {result: "unavailable"} | {result: "rate_limited"}
 *
 * Differences from PW (deliberate, per the MS Study spec):
 *   - NO expiry anywhere: no expiresAt, no validity countdown, no pill.
 *     A valid password stays valid until the server says otherwise.
 *   - The password is NEVER stored natively. MsSessionStore holds only
 *     {deviceId, role}. The JS side keeps the password in memory only
 *     and passes it to revalidate() on every 15s/resume check — that is
 *     why revalidate() takes a password parameter, unlike PW's
 *     revalidateSaved() which reads a stored password.
 *   - Device identity is the encrypted UUID from MsSessionStore, not
 *     the Android ID. deviceLabel is "Android <model>".
 */
@CapacitorPlugin(name = "MsAccess")
public class MsAccessPlugin extends Plugin {

    // PLANNED Render URL — must match SERVER_URL in www/app.js. Update
    // both together once the real Render service is live.
    public static final String VALIDATE_URL = "https://ms-study-server.onrender.com/validate";

    private static final Object VALIDATE_LOCK = new Object();

    public static final class Validation {
        public final String result;
        public final String role; // "admin" | "user", may be null
        public final String message; // may be null

        public Validation(String result, String role, String message) {
            this.result = result;
            this.role = role;
            this.message = message;
        }
    }

    public static String deviceLabel() {
        try {
            String model = Build.MODEL;
            if (model != null && !model.trim().isEmpty()) {
                return "Android " + model.trim();
            }
        } catch (Exception e) {
            // Fall through.
        }
        return "MS Study App";
    }

    /**
     * POST /validate for the given password. Handles session save/clear
     * per the rules below. Never throws; network trouble is reported as
     * "unavailable".
     *
     * Rules (mirrors PW, minus expiry):
     *   - "valid" -> the caller saves {deviceId, role} (validate() does).
     *   - "incorrect" / "kicked" -> definite failure, clear the session.
     *   - "unavailable" -> clears the session only for a user-initiated
     *     check (silent=false); silent revalidation keeps the session.
     *   - "rate_limited" -> transient, never clears the session.
     */
    public static Validation validateNow(Context ctx, String password, boolean silent) {
        if (password == null || password.trim().isEmpty()) {
            return new Validation("incorrect", null, null);
        }
        synchronized (VALIDATE_LOCK) {
            HttpURLConnection conn = null;
            try {
                String deviceId = MsSessionStore.getDeviceId(ctx);
                JSONObject body = new JSONObject();
                body.put("password", password.trim());
                body.put("deviceId", deviceId);
                body.put("deviceLabel", deviceLabel());
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);

                URL url = new URL(VALIDATE_URL);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Accept", "application/json");
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
                int code = conn.getResponseCode();
                String text = readStream(code >= 200 && code < 300
                        ? conn.getInputStream() : conn.getErrorStream());

                String result = "unavailable";
                String role = null;
                try {
                    JSONObject json = new JSONObject(text);
                    result = json.optString("result", "unavailable");
                    if (json.has("role") && !json.isNull("role")) {
                        role = json.optString("role", null);
                    }
                } catch (Exception e) {
                    result = "unavailable";
                }
                if (code == 429) {
                    result = "rate_limited";
                }
                return handleResult(ctx, result, role, silent);
            } catch (Exception e) {
                // Network / IO failure: the server may just be waking up
                // (Render free tier cold-starts).
                if (!silent) {
                    MsSessionStore.clear(ctx);
                }
                return new Validation("unavailable", null, null);
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
    }

    private static Validation handleResult(Context ctx, String result, String role, boolean silent) {
        switch (result) {
            case "valid":
                // Do NOT save here: validate() saves after a valid result.
                // This keeps one save path per caller.
                return new Validation("valid", role != null ? role : "user", null);
            case "incorrect":
            case "kicked":
                MsSessionStore.clear(ctx);
                return new Validation(result, null, null);
            case "rate_limited":
                // Transient: keep the session, retry later.
                return new Validation(result, null, null);
            case "unavailable":
            default:
                if (!silent) {
                    MsSessionStore.clear(ctx);
                }
                return new Validation("unavailable", null, null);
        }
    }

    private static String readStream(InputStream in) {
        if (in == null) {
            return "";
        }
        try {
            StringBuilder sb = new StringBuilder();
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(in, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static JSObject toJs(Validation v) {
        JSObject ret = new JSObject();
        ret.put("result", v.result);
        if (v.role != null) {
            ret.put("role", v.role);
        }
        if (v.message != null) {
            ret.put("message", v.message);
        }
        return ret;
    }

    /** User-initiated check (login submit). Saves {deviceId, role} on valid. */
    @PluginMethod
    public void validate(PluginCall call) {
        final String password = call.getString("password", "");
        new Thread(new Runnable() {
            @Override
            public void run() {
                Validation v = validateNow(getContext(), password, false);
                if ("valid".equals(v.result)) {
                    MsSessionStore.save(getContext(),
                            MsSessionStore.getDeviceId(getContext()), v.role);
                }
                call.resolve(toJs(v));
            }
        }).start();
    }

    /**
     * Silent check (15s timer / resume). The password comes from JS
     * memory — it is never stored natively, so it must be passed in.
     * On "valid" the stored role is refreshed.
     */
    @PluginMethod
    public void revalidate(PluginCall call) {
        final String password = call.getString("password", "");
        Boolean silentBox = call.getBoolean("silent", true);
        final boolean silent = silentBox == null || silentBox;
        new Thread(new Runnable() {
            @Override
            public void run() {
                if (password == null || password.isEmpty()) {
                    call.resolve(toJs(new Validation("no_session", null, null)));
                    return;
                }
                Validation v = validateNow(getContext(), password, silent);
                if ("valid".equals(v.result)) {
                    MsSessionStore.save(getContext(),
                            MsSessionStore.getDeviceId(getContext()), v.role);
                }
                call.resolve(toJs(v));
            }
        }).start();
    }

    /** Current session state (no password is ever returned to JS). */
    @PluginMethod
    public void getSessionStatus(PluginCall call) {
        MsSessionStore.Session session = MsSessionStore.read(getContext());
        JSObject ret = new JSObject();
        ret.put("hasSession", session != null);
        if (session != null) {
            ret.put("deviceId", session.deviceId);
            ret.put("role", session.role);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        MsSessionStore.clear(getContext());
        call.resolve();
    }

    /** Device identity + label for JS (login POST fallback, admin calls). */
    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("deviceId", MsSessionStore.getDeviceId(getContext()));
        ret.put("deviceLabel", deviceLabel());
        call.resolve(ret);
    }

    @PluginMethod
    public void getDeviceId(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("deviceId", MsSessionStore.getDeviceId(getContext()));
        call.resolve(ret);
    }
}
