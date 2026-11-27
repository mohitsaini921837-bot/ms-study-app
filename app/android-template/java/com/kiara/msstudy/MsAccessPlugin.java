package com.kiara.msstudy;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Capacitor bridge for MS Study (no-password build, v1.0.23).
 *
 * There is no login, no access password, and no role anywhere: the
 * device id IS the identity — a UUID generated once and stored
 * AES-encrypted in MsSessionStore — and the server accepts
 * deviceId-only calls. The old password machinery (validate /
 * revalidate / revalidateSaved / VALIDATE_URL) was removed with the
 * login system; nothing in JS calls it anymore.
 *
 * This plugin now exposes only two things:
 *   - device identity: getDeviceInfo / getDeviceId
 *   - hidden-chat code storage: getChatCode / setChatCode /
 *     clearChatCode (the chat code is separate from login and is
 *     untouched by the no-password change)
 *
 * Device identity is the encrypted UUID from MsSessionStore, not
 * the Android ID. deviceLabel is "Android <model>".
 *
 * WEB-BUNDLE AUTO-UPDATE (v1.0.23, silent, web-only):
 * installWebBundle() verifies a downloaded www ZIP (SHA-256), extracts
 * it to internal storage, validates the required files, and ONLY then
 * persists the path in the SAME SharedPreferences the Capacitor Bridge
 * reads on every launch ("CapWebViewSettings" / "serverBasePath",
 * Bridge.java:278-285 — if the path exists, the WebView's local server
 * serves the downloaded bundle instead of the APK's bundled www from
 * the NEXT cold launch; WebViewLocalServer.hostFiles() serves it on the
 * same https://localhost origin). On ANY failure the stored path is
 * untouched, so the app keeps running its current bundle — a bad bundle
 * can never brick the app. When a new APK is installed, the Bridge's
 * isNewBinary() (Bridge.java:414-441) clears the stored path itself, so
 * a new APK always starts from its own bundled www.
 */
@CapacitorPlugin(name = "MsAccess")
public class MsAccessPlugin extends Plugin {

    /** Same keys the Capacitor Bridge uses (com.getcapacitor.plugin.WebView). */
    private static final String WEBVIEW_PREFS_NAME = "CapWebViewSettings";
    private static final String CAP_SERVER_PATH = "serverBasePath";
    /** Installed www build, mirrored in JS localStorage (ms_www_build). */
    private static final String WWW_BUILD_KEY = "msWwwBuild";
    private static final String WWW_DIR_NAME = "www-bundle";
    /** Files a bundle must contain to be accepted as a runnable www. */
    private static final String[] REQUIRED_WWW_FILES = {
        "index.html", "app.js", "styles.css", "drive.js"
    };

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String sha256Hex(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        InputStream in = new BufferedInputStream(new FileInputStream(file));
        try {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) {
                digest.update(buf, 0, n);
            }
        } finally {
            in.close();
        }
        return bytesToHex(digest.digest());
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        f.delete();
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

    /** Hidden-chat code: read the stored code (null if none set). */
    @PluginMethod
    public void getChatCode(PluginCall call) {
        String code = MsSessionStore.readChatCode(getContext());
        JSObject ret = new JSObject();
        if (code != null) {
            ret.put("code", code);
        }
        call.resolve(ret);
    }

    /** Hidden-chat code: store a new code (encrypted natively). */
    @PluginMethod
    public void setChatCode(PluginCall call) {
        String code = call.getString("code", "");
        if (code != null && !code.isEmpty()) {
            MsSessionStore.saveChatCode(getContext(), code);
        }
        call.resolve();
    }

    /** Hidden-chat code: clear it (used by "Change code"). */
    @PluginMethod
    public void clearChatCode(PluginCall call) {
        MsSessionStore.clearChatCode(getContext());
        call.resolve();
    }

    /** Device identity + label for JS. */
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

    /* ================= Web-bundle auto-update (v1.0.23) ================= */

    /** Which www bundle (if any) is installed: { wwwBuild, path }. */
    @PluginMethod
    public void getWebBundleInfo(PluginCall call) {
        SharedPreferences prefs = getContext()
                .getSharedPreferences(WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("wwwBuild", prefs.getInt(WWW_BUILD_KEY, 0));
        String path = prefs.getString(CAP_SERVER_PATH, "");
        if (path != null && !path.isEmpty()) {
            ret.put("path", path);
        }
        call.resolve(ret);
    }

    /**
     * Install a downloaded www ZIP as the app's web bundle.
     * Args: fileName (in getCacheDir(), written by JS via Filesystem
     * CACHE — same dir the APK updater uses), wwwBuild (integer, must be
     * newer than the installed one — JS checks first), sha256 (hex of
     * the ZIP as published in update/version.json).
     *
     * Steps, in order — the stored path is written ONLY at the end:
     *  1. SHA-256 of the ZIP must match sha256 (else reject).
     *  2. Unzip to www-bundle/.tmp-<build> (zip-slip guarded: every
     *     entry must resolve inside the target dir).
     *  3. index.html + app.js + styles.css + drive.js must exist.
     *  4. Delete older www-bundle/<build> dirs, rename tmp dir into
     *     place, persist serverBasePath + wwwBuild, delete the ZIP.
     * Any failure rejects and leaves the previous bundle (or the APK's
     * bundled www) exactly as it was.
     */
    @PluginMethod
    public void installWebBundle(PluginCall call) {
        String fileName = call.getString("fileName", "");
        String sha256 = call.getString("sha256", "");
        int wwwBuild = call.getInt("wwwBuild", 0);
        if (fileName == null || fileName.isEmpty() || fileName.contains("/")
                || fileName.contains("\\") || fileName.contains("..")) {
            call.reject("Invalid fileName");
            return;
        }
        if (wwwBuild <= 0 || sha256 == null || !sha256.matches("(?i)[0-9a-f]{64}")) {
            call.reject("Invalid wwwBuild or sha256");
            return;
        }
        File zipFile = new File(getContext().getCacheDir(), fileName);
        if (!zipFile.exists()) {
            call.reject("Bundle ZIP not found in cache: " + fileName);
            return;
        }
        File root = new File(getContext().getFilesDir(), WWW_DIR_NAME);
        File tmpDir = new File(root, ".tmp-" + wwwBuild);
        File finalDir = new File(root, String.valueOf(wwwBuild));
        try {
            String actual = sha256Hex(zipFile);
            if (!actual.equalsIgnoreCase(sha256)) {
                call.reject("SHA-256 mismatch");
                return;
            }
            deleteRecursive(tmpDir);
            deleteRecursive(finalDir);
            if (!tmpDir.mkdirs()) {
                call.reject("Could not create staging dir");
                return;
            }
            // Unzip with zip-slip guard.
            ZipInputStream zin = new ZipInputStream(
                    new BufferedInputStream(new FileInputStream(zipFile)));
            try {
                ZipEntry entry;
                byte[] buf = new byte[8192];
                String tmpCanonical = tmpDir.getCanonicalPath() + File.separator;
                while ((entry = zin.getNextEntry()) != null) {
                    File out = new File(tmpDir, entry.getName());
                    if (!out.getCanonicalPath().startsWith(tmpCanonical)) {
                        throw new IOException("Unsafe ZIP entry: " + entry.getName());
                    }
                    if (entry.isDirectory()) {
                        out.mkdirs();
                    } else {
                        File parent = out.getParentFile();
                        if (parent != null) {
                            parent.mkdirs();
                        }
                        FileOutputStream fout = new FileOutputStream(out);
                        try {
                            int n;
                            while ((n = zin.read(buf)) != -1) {
                                fout.write(buf, 0, n);
                            }
                        } finally {
                            fout.close();
                        }
                    }
                    zin.closeEntry();
                }
            } finally {
                zin.close();
            }
            for (String required : REQUIRED_WWW_FILES) {
                if (!new File(tmpDir, required).isFile()) {
                    deleteRecursive(tmpDir);
                    call.reject("Bundle missing required file: " + required);
                    return;
                }
            }
            // Validation passed: retire older builds, publish this one.
            File[] old = root.listFiles();
            if (old != null) {
                for (File child : old) {
                    if (!child.equals(tmpDir)) {
                        deleteRecursive(child);
                    }
                }
            }
            if (!tmpDir.renameTo(finalDir)) {
                deleteRecursive(tmpDir);
                call.reject("Could not publish bundle");
                return;
            }
            SharedPreferences prefs = getContext()
                    .getSharedPreferences(WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(CAP_SERVER_PATH, finalDir.getAbsolutePath());
            editor.putInt(WWW_BUILD_KEY, wwwBuild);
            editor.apply();
            zipFile.delete();
            JSObject ret = new JSObject();
            ret.put("wwwBuild", wwwBuild);
            ret.put("path", finalDir.getAbsolutePath());
            call.resolve(ret);
        } catch (Exception e) {
            deleteRecursive(tmpDir);
            call.reject("Could not install web bundle: " + e.getMessage());
        }
    }

    /** Remove any downloaded bundle; the next launch serves bundled www. */
    @PluginMethod
    public void clearWebBundle(PluginCall call) {
        SharedPreferences prefs = getContext()
                .getSharedPreferences(WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString(CAP_SERVER_PATH, "");
        editor.putInt(WWW_BUILD_KEY, 0);
        editor.apply();
        deleteRecursive(new File(getContext().getFilesDir(), WWW_DIR_NAME));
        call.resolve();
    }
}
