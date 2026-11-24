package com.kiara.msstudy;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypted storage for the MS Study session (Phase 1).
 *
 * Mirrors the PW app's PwSessionStore EXACTLY in mechanism (same file:
 * pw-apk/app/android/app/src/main/java/com/kiara/pw/PwSessionStore.java):
 *   - AES-256/GCM key held in the Android Keystore; only the ciphertext
 *     (Base64(iv || ciphertext)) lives in SharedPreferences.
 *   - Capacitor Preferences is NOT encrypted, so it must never hold
 *     session data.
 *
 * Differences from PW (deliberate, per the MS Study spec):
 *   - The session holds {deviceId, role} and, since v1.0.3, the access
 *     password too — stored AES-encrypted, exactly like PW stores its
 *     password. This is what keeps the user signed in across an app
 *     update: an update restarts the app and wipes JS memory, but the
 *     encrypted password survives, so boot can silently revalidate
 *     and skip the lock screen. The password is cleared on logout,
 *     kick, or an "incorrect" result.
 *   - The device identity is a UUID generated ONCE and stored encrypted
 *     here — NOT the Android ID. (PW uses the Android ID because its
 *     customers' passwords were already bound to it; MS Study has no
 *     such legacy binding, so a stable random UUID is used instead.
 *     The storage mechanism is the same one PW uses for its fallback id.)
 */
public final class MsSessionStore {

    private static final String PREFS = "msstudy.access.session.v1";
    private static final String KEY_SESSION = "session";
    private static final String KEY_PASSWORD = "password";
    private static final String KEY_DEVICE_ID = "msstudy.installation.device.v1";
    private static final String KEY_ALIAS = "msstudy.access.key.v1";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final long CACHE_TTL_MS = 5000;

    public static final class Session {
        public final String deviceId;
        public final String role;

        public Session(String deviceId, String role) {
            this.deviceId = deviceId;
            this.role = role;
        }
    }

    private static Session cachedSession;
    private static long cachedAtMs;
    private static String cachedDeviceId;

    private MsSessionStore() {}

    public static synchronized void save(Context ctx, String deviceId, String role) {
        try {
            JSONObject json = new JSONObject();
            json.put("deviceId", deviceId);
            json.put("role", role);
            String encrypted = encrypt(json.toString());
            if (encrypted == null) {
                return;
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_SESSION, encrypted).apply();
            cachedSession = new Session(deviceId, role);
            cachedAtMs = System.currentTimeMillis();
        } catch (Exception e) {
            // Never crash the app for storage trouble; the caller treats a
            // missing session as "not logged in".
            clear(ctx);
        }
    }

    public static synchronized Session read(Context ctx) {
        if (cachedSession != null && System.currentTimeMillis() - cachedAtMs < CACHE_TTL_MS) {
            return cachedSession;
        }
        cachedSession = null;
        try {
            String encrypted = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_SESSION, null);
            if (encrypted == null) {
                return null;
            }
            String plain = decrypt(encrypted);
            if (plain == null) {
                clear(ctx);
                return null;
            }
            JSONObject json = new JSONObject(plain);
            String deviceId = json.optString("deviceId", null);
            String role = json.optString("role", "user");
            if (deviceId == null || deviceId.isEmpty()) {
                clear(ctx);
                return null;
            }
            cachedSession = new Session(deviceId, role);
            cachedAtMs = System.currentTimeMillis();
            return cachedSession;
        } catch (Exception e) {
            clear(ctx);
            return null;
        }
    }

    public static synchronized void clear(Context ctx) {
        cachedSession = null;
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().remove(KEY_SESSION).remove(KEY_PASSWORD).apply();
        } catch (Exception e) {
            // Best effort only.
        }
    }

    /**
     * The access password, AES-256/GCM encrypted (same key/mechanism as
     * the session). Stored on a successful login so a fresh launch —
     * including after an app update, which wipes JS memory — can
     * silently revalidate and skip the lock screen. Cleared together
     * with the session on logout, kick, or "incorrect".
     */
    public static synchronized void savePassword(Context ctx, String password) {
        try {
            if (password == null || password.isEmpty()) {
                return;
            }
            String encrypted = encrypt(password);
            if (encrypted == null) {
                return;
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_PASSWORD, encrypted).apply();
        } catch (Exception e) {
            // Never crash the app for storage trouble.
        }
    }

    public static synchronized String readPassword(Context ctx) {
        try {
            String encrypted = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_PASSWORD, null);
            if (encrypted == null) {
                return null;
            }
            String plain = decrypt(encrypted);
            if (plain == null || plain.isEmpty()) {
                return null;
            }
            return plain;
        } catch (Exception e) {
            return null;
        }
    }

    public static synchronized void clearPassword(Context ctx) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().remove(KEY_PASSWORD).apply();
        } catch (Exception e) {
            // Best effort only.
        }
    }

    /**
     * Device identity: a UUID generated ONCE and stored AES-encrypted.
     * Same mechanism as PW's fallback id (PwSessionStore.getDeviceId),
     * but here it is the ONLY identity source — there is no Android ID.
     */
    public static synchronized String getDeviceId(Context ctx) {
        if (cachedDeviceId != null) {
            return cachedDeviceId;
        }
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String encrypted = prefs.getString(KEY_DEVICE_ID, null);
            if (encrypted != null) {
                String plain = decrypt(encrypted);
                if (plain != null && plain.length() >= 8) {
                    cachedDeviceId = plain;
                    return cachedDeviceId;
                }
            }
            String generated = "ms-" + UUID.randomUUID().toString();
            String enc = encrypt(generated);
            if (enc != null) {
                prefs.edit().putString(KEY_DEVICE_ID, enc).apply();
            }
            cachedDeviceId = generated;
            return generated;
        } catch (Exception e) {
            return "ms-" + UUID.randomUUID().toString();
        }
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return (SecretKey) ks.getKey(KEY_ALIAS, null);
        }
        KeyGenerator kg = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build();
        kg.init(spec);
        return kg.generateKey();
    }

    /** Returns Base64(iv || ciphertext), or null on failure. */
    private static String encrypt(String plain) throws Exception {
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV(); // 12 bytes for GCM
        byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(ct, 0, combined, iv.length, ct.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
    }

    /** Returns the plaintext, or null on failure. */
    private static String decrypt(String b64) throws Exception {
        byte[] combined = Base64.decode(b64, Base64.DEFAULT);
        if (combined.length <= 12) {
            return null;
        }
        byte[] iv = new byte[12];
        byte[] ct = new byte[combined.length - 12];
        System.arraycopy(combined, 0, iv, 0, 12);
        System.arraycopy(combined, 12, ct, 0, ct.length);
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
    }
}
