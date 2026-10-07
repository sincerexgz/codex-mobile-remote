package com.codexremote.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RemoteAccessPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                PluginHandle handle = getBridge().getPlugin("RemoteAccess");
                if (handle != null) ((RemoteAccessPlugin) handle.getInstance()).onBackRequested();
                else finish();
            }
        });
    }
}
