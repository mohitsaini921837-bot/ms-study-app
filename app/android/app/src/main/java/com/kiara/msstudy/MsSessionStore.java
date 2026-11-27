package com.kiara.msstudy;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypted storage for MS Study (no-password build, v1.0.23).
 *
 * Mirrors the PW app's PwSessionStore in mechanism (same file:
 * pw-apk/app/android/app/src/main/java/com/kiara/pw/PwSessionStore.java):
 *   - AES-256/GCM key held in the Android Keystore; only the ciphertext
 *     (Base64(iv || ciphertext)) lives in SharedPreferences.
 *   - Capacitor Preferences is NOT encrypted, so it must never hold
 *     session data.
 *
 * No-password model: there is no login session and no access password
 * anymore — the old {deviceId, role} session (save/read/clear) and the
 * password store (savePassword/readPassword/clearPassword) were removed
 * with the login system. Only two things live here now:
 *   - the device identity: a UUID generated ONCE and stored encrypted
 *     (getDeviceId) — this IS the identity the server accepts.
 *   - the hidden-chat code (saveChatCode/readChatCode/clearChatCode):
 *     the chat code is separate from login and is untouched.
 */
public final class MsSessionStore {

    private static final String PREFS = "msstudy.access.session.v1";
    private static final String KEY_DEVICE_ID = "msstudy.installation.device.v1";
    private static final String KEY_ALIAS = "msstudy.access.key.v1";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";

    private static String cachedDeviceId;

    private MsSessionStore() {}

    /**
     * The hidden-chat code, AES-256/GCM encrypted (same key/mechanism
     * as before). The chat code is the pairing key, so it must
     * survive app updates — WebView localStorage is not reliable
     * enough for it. Stored here on first set; read on every chat
     * open. It is cleared only by "Change code".
     */
    private static final String KEY_CHAT_CODE = "chat_code";

    public static synchronized void saveChatCode(Context ctx, String code) {
        try {
            if (code == null || code.isEmpty()) {
                return;
            }
            String encrypted = encrypt(code);
            if (encrypted == null) {
                return;
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_CHAT_CODE, encrypted).apply();
        } catch (Exception e) {
            // Never crash the app for storage trouble.
        }
    }

    public static synchronized String readChatCode(Context ctx) {
        try {
            String encrypted = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_CHAT_CODE, null);
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

    public static synchronized void clearChatCode(Context ctx) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().remove(KEY_CHAT_CODE).apply();
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
