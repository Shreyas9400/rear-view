package app.smartrearview.rearcam;

import android.os.Bundle;
import android.view.WindowManager;
import app.smartrearview.rearcam.detector.NativeDetectorPlugin;
import app.smartrearview.rearcam.server.LocalServerPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate() builds the bridge.
        registerPlugin(NativeDetectorPlugin.class);
        registerPlugin(LocalServerPlugin.class);
        super.onCreate(savedInstanceState);
        // The rear phone must not sleep while it films: the camera and the viewer stream stop with the screen.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
