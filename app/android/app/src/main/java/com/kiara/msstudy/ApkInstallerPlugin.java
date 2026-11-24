package com.kiara.msstudy;

import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Minimal Capacitor plugin for the MS Study in-app updater (Phase 1).
 *
 * JS flow (www/app.js): fetch the APK from UPDATE_URL -> save it to the
 * app cache dir with @capacitor/filesystem -> installApk({fileName})
 * fires an ACTION_VIEW intent with a FileProvider URI, which opens the
 * Android package installer.
 *
 * Requirements (already in AndroidManifest.xml / res/xml/file_paths.xml):
 *   - <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
 *   - FileProvider with authorities "${applicationId}.fileprovider" and
 *     a <cache-path> entry (the APK lives in getCacheDir()).
 *
 * The update installs OVER the old version: same package
 * (com.kiara.msstudy) + same release keystore (see app/build.gradle
 * signingConfig / GitHub workflow secrets). Android refuses the install
 * if the signing key differs — that is the safety check, not a bug.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void installApk(PluginCall call) {
        String fileName = call.getString("fileName", "");
        if (fileName == null || fileName.isEmpty()) {
            call.reject("fileName is required");
            return;
        }
        // Never allow path traversal out of the cache dir.
        if (fileName.contains("/") || fileName.contains("\\") || fileName.contains("..")) {
            call.reject("Invalid fileName");
            return;
        }
        try {
            File apkFile = new File(getContext().getCacheDir(), fileName);
            if (!apkFile.exists()) {
                call.reject("APK file not found in cache: " + fileName);
                return;
            }
            String authority = getContext().getPackageName() + ".fileprovider";
            Uri apkUri = FileProvider.getUriForFile(getContext(), authority, apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not start installer: " + e.getMessage());
        }
    }
}
