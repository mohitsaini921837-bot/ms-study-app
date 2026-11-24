package com.kiara.msstudy;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Custom plugins MUST be registered before super.onCreate() builds
        // the bridge, or the web page's JS can never reach them.
        // (Same rule as the PW app's MainActivity with PwAccessPlugin.)
        registerPlugin(MsAccessPlugin.class);
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
