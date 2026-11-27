package com.kiara.msstudy;

import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
 */
@CapacitorPlugin(name = "MsAccess")
public class MsAccessPlugin extends Plugin {

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
}
