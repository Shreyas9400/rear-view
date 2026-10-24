package app.smartrearview.rearcam.server;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Capacitor plugin "LocalServer": starts the viewer HTTP + WebSocket server (see {@link LocalServer}) on the hotspot/Wi-Fi
 * interface and lets the rear app publish frames and status to it. Docs: PROTOCOL_SPEC.md, SECURITY_AND_PRIVACY.md, D-032.
 * The viewer token is returned to the WebView so the rear screen can show it; it is never logged.
 */
@CapacitorPlugin(name = "LocalServer")
public class LocalServerPlugin extends Plugin {
    private LocalServer server;
    private String bindIp;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        if (server != null) {
            call.resolve(info());
            return;
        }
        try {
            List<String> candidates = candidateAddresses();
            String requested = call.getString("bindAddress");
            String ip = requested != null ? requested : (candidates.isEmpty() ? null : candidates.get(0));
            if (ip == null) {
                call.reject("no hotspot or Wi-Fi address available", "NO_NETWORK");
                return;
            }
            if (requested != null && !candidates.contains(requested) && !"127.0.0.1".equals(requested)) {
                call.reject("bindAddress is not an address of this device's Wi-Fi/hotspot interface", "BAD_ADDRESS");
                return;
            }
            LocalServer.Config cfg = new LocalServer.Config();
            cfg.bind = InetAddress.getByName(ip);
            cfg.port = call.getInt("port", 8080);
            cfg.streamW = call.getInt("streamW", 640);
            cfg.streamH = call.getInt("streamH", 360);
            cfg.targetFps = call.getInt("targetFps", 8);
            // The token is kept in app-private storage so the iPhone's saved session keeps working after the app restarts (D-037);
            // "Revoke viewer access" replaces it, and start({rotate:true}) forces a new one.
            if (!Boolean.TRUE.equals(call.getBoolean("rotate", false))) cfg.initialToken = prefs().getString("token", null);
            LocalServer s = new LocalServer(cfg, new AssetProvider(getContext().getAssets()));
            s.start();
            prefs().edit().putString("token", s.sessionToken()).apply();
            server = s;
            bindIp = ip;
            JSObject r = info();
            JSArray c = new JSArray();
            for (String a : candidates) c.put(a);
            r.put("candidates", c);
            call.resolve(r);
        } catch (IOException e) {
            call.reject("server start failed: " + e.getMessage(), "START_FAILED");
        }
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        if (server != null) {
            server.stop();
            server = null;
        }
        call.resolve();
    }

    @PluginMethod
    public synchronized void revoke(PluginCall call) {
        if (server == null) {
            call.reject("server not running", "NOT_RUNNING");
            return;
        }
        String t = server.revoke();
        prefs().edit().putString("token", t).apply();
        JSObject r = new JSObject();
        r.put("token", t);
        r.put("url", "http://" + bindIp + ":" + server.port() + "/#t=" + t);
        call.resolve(r);
    }

    @PluginMethod
    public synchronized void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", server != null);
        if (server != null) {
            r.put("viewers", server.viewerCount());
            r.put("framesPublished", server.framesPublished());
            r.put("port", server.port());
            r.put("ip", bindIp);
        }
        call.resolve(r);
    }

    /** Called at up to ~10 per second with a ~30-60 KB JPEG, so it does the minimum on the plugin thread. */
    @PluginMethod
    public void publishFrame(PluginCall call) {
        LocalServer s = current();
        if (s == null) {
            call.reject("server not running", "NOT_RUNNING");
            return;
        }
        String meta = call.getString("meta");
        String jpeg64 = call.getString("jpeg");
        Double seq = call.getDouble("seq");
        if (meta == null || jpeg64 == null || seq == null) {
            call.reject("meta, jpeg and seq are required", "BAD_ARGS");
            return;
        }
        if (jpeg64.length() > 700_000) {
            call.reject("jpeg too large", "TOO_LARGE");
            return;
        }
        try {
            byte[] jpeg = Base64.decode(jpeg64, Base64.DEFAULT);
            s.publishFrame(seq.longValue(), meta.getBytes(StandardCharsets.UTF_8), jpeg);
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "BAD_FRAME");
        }
    }

    @PluginMethod
    public void publishRearStatus(PluginCall call) {
        LocalServer s = current();
        if (s == null) {
            call.reject("server not running", "NOT_RUNNING");
            return;
        }
        String json = call.getString("json");
        if (json == null) {
            call.reject("json is required", "BAD_ARGS");
            return;
        }
        try {
            s.publishRearStatus(json);
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "BAD_STATUS");
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) {
            if (server != null) server.stop();
            server = null;
        }
    }

    private synchronized LocalServer current() {
        return server;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("localserver", Context.MODE_PRIVATE);
    }

    private JSObject info() {
        JSObject r = new JSObject();
        r.put("running", true);
        r.put("ip", bindIp);
        r.put("port", server.port());
        r.put("token", server.sessionToken());
        r.put("sessionId", server.sessionId());
        r.put("url", "http://" + bindIp + ":" + server.port() + "/#t=" + server.sessionToken());
        r.put("baseUrl", "http://" + bindIp + ":" + server.port() + "/");
        return r;
    }

    /** Site-local IPv4 addresses of Wi-Fi / hotspot interfaces, hotspot-looking names first. Never the cellular interface. */
    static List<String> candidateAddresses() {
        List<String> ap = new ArrayList<>();
        List<String> wifi = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName().toLowerCase(Locale.ROOT);
                boolean isAp = name.startsWith("ap") || name.startsWith("swlan") || name.startsWith("softap");
                boolean isWifi = name.startsWith("wlan") || name.startsWith("eth");
                if (!isAp && !isWifi) continue; // rmnet*/ccmni*/v4-* are cellular: excluded
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) (isAp ? ap : wifi).add(a.getHostAddress());
                }
            }
        } catch (java.net.SocketException ignored) {
            // no interfaces: empty list
        }
        ap.addAll(wifi);
        return ap;
    }

    /** Serves only viewer.html and files under assets/ from the app's bundled web assets (public/). */
    private static final class AssetProvider implements LocalServer.Assets {
        private final AssetManager am;

        AssetProvider(AssetManager am) {
            this.am = am;
        }

        @Override
        public byte[] get(String name) {
            if (!name.equals("viewer.html") && !name.startsWith("assets/")) return null;
            try (InputStream in = am.open("public/" + name)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            } catch (IOException e) {
                return null;
            }
        }
    }
}
