package app.smartrearview.rearcam.server;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The viewer-facing HTTP + WebSocket server (docs/PROTOCOL_SPEC.md, D-032). Binds one address (never 0.0.0.0 unless the caller
 * passes it). Routes: GET / (viewer page), GET /healthz, allow-listed static assets, GET /ws/view (WebSocket). The rear app feeds
 * it through {@link #publishFrame} and {@link #publishRearStatus} (plugin calls, not a loopback socket). Token auth, Origin
 * check, per-IP lockout and rate limits, viewer limit, newest-frame-wins relay with ack credit, 1 Hz status.
 */
public final class LocalServer {
    public static final int PROTOCOL_VERSION = 1;
    static final int MAX_HEAD_BYTES = 8192;
    static final int MAX_TEXT_BYTES = 16 * 1024;
    static final int MAX_META_BYTES = 16 * 1024;
    static final int MAX_JPEG_BYTES = 512 * 1024;
    static final int MAX_VIEWERS = 2;
    static final int MAX_CONNECTIONS = 12;
    static final int ACK_CREDIT = 2;
    static final long HELLO_TIMEOUT_MS = 3000;
    /** The viewer pings every 2 s; a viewer silent for this long (screen off, Wi-Fi gone) is dropped so it cannot hold a slot. */
    static final long IDLE_TIMEOUT_MS = 8000;
    /** A full server replaces a viewer that has been silent this long when a new, authenticated viewer arrives. */
    static final long EVICT_IDLE_MS = 3000;
    static final long STATUS_EVERY_MS = 1000;
    static final long REAR_STALE_MS = 2000;
    static final int MSGS_PER_SECOND = 20;

    public interface Assets {
        /** Returns the bytes for an allow-listed asset name (no leading slash), or null if it is not served. */
        byte[] get(String name);
    }

    public static final class Config {
        public InetAddress bind;
        public int port = 8080;
        public int streamW = 640;
        public int streamH = 360;
        public int targetFps = 8;
        /** The token stays valid this long after the server starts (D-037: 30 days, so the link can stay constant). */
        public long tokenTtlMs = 30L * 24 * 3600_000L;
        /** A token saved by the plugin from an earlier run (22 base64url characters); null or malformed -> a new random one. */
        public String initialToken;
        /** Test hook: extra Origin values accepted (empty in production). */
        public List<String> extraOrigins = new ArrayList<>();
    }

    private final Config cfg;
    private final Assets assets;
    private final SecureRandom rng = new SecureRandom();
    private final AuthGuard guard = new AuthGuard();
    private final Object state = new Object();
    private final List<ViewerConn> viewers = new ArrayList<>();
    private final AtomicInteger connections = new AtomicInteger();
    private final String sessionId;
    private ServerSocket server;
    private Thread acceptThread;
    private Thread tickThread;
    private volatile boolean running;
    private String token;
    private long tokenIssuedAtMs;
    private String allowedOrigin;
    private long lastFrameAtMs = -1;
    private String rearJson;
    private long rearAtMs = -1;
    private long framesPublished;

    public LocalServer(Config cfg, Assets assets) {
        this.cfg = cfg;
        this.assets = assets;
        this.sessionId = "s-" + randomToken(6);
    }

    // ---- lifecycle -------------------------------------------------------------------------------------------------

    public void start() throws IOException {
        if (running) return;
        if (cfg.bind == null) throw new IOException("no bind address");
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(cfg.bind, cfg.port), 16);
        allowedOrigin = "http://" + cfg.bind.getHostAddress() + ":" + server.getLocalPort();
        synchronized (state) {
            token = validToken(cfg.initialToken) ? cfg.initialToken : randomToken(16);
            tokenIssuedAtMs = mono();
        }
        running = true;
        acceptThread = daemon("viewer-accept", this::acceptLoop);
        tickThread = daemon("viewer-tick", this::tickLoop);
    }

    public void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // closing
        }
        List<ViewerConn> copy;
        synchronized (state) {
            copy = new ArrayList<>(viewers);
        }
        for (ViewerConn v : copy) {
            v.close(1001, "server stopping", mono());
        }
        long deadline = mono() + 300;
        while (mono() < deadline) {
            synchronized (state) {
                if (viewers.isEmpty()) break;
            }
            sleep(10);
        }
        for (ViewerConn v : copy) v.kill();
    }

    public int port() {
        return server == null ? -1 : server.getLocalPort();
    }

    public String origin() {
        return allowedOrigin;
    }

    /** The viewer token. Callers must show it only on the rear screen (QR or URL) and never log it. */
    public String sessionToken() {
        synchronized (state) {
            return token;
        }
    }

    public String sessionId() {
        return sessionId;
    }

    /** New token; every viewer is closed with 4410. */
    public String revoke() {
        List<ViewerConn> copy;
        String t;
        synchronized (state) {
            token = randomToken(16);
            tokenIssuedAtMs = mono();
            t = token;
            copy = new ArrayList<>(viewers);
        }
        for (ViewerConn v : copy) {
            v.sendText(errorJson(4410, "session revoked"));
            v.close(4410, "session revoked", mono());
        }
        return t;
    }

    public int viewerCount() {
        synchronized (state) {
            return viewers.size();
        }
    }

    public long framesPublished() {
        synchronized (state) {
            return framesPublished;
        }
    }

    // ---- rear side input (called from the plugin) --------------------------------------------------------------------

    /** Builds the RVF1 message and offers it to every viewer. Throws IllegalArgumentException for an invalid frame. */
    public void publishFrame(long seq, byte[] metaJson, byte[] jpeg) {
        if (metaJson == null || metaJson.length == 0 || metaJson.length > MAX_META_BYTES) throw new IllegalArgumentException("bad meta size");
        if (jpeg == null || jpeg.length < 4 || jpeg.length > MAX_JPEG_BYTES) throw new IllegalArgumentException("bad jpeg size");
        if ((jpeg[0] & 0xFF) != 0xFF || (jpeg[1] & 0xFF) != 0xD8) throw new IllegalArgumentException("payload is not a JPEG");
        if (seq < 0 || seq > 0xFFFFFFFFL) throw new IllegalArgumentException("bad seq");
        try {
            Map<String, Object> m = MiniJson.parseObject(new String(metaJson, StandardCharsets.UTF_8), MAX_META_BYTES);
            Object v = m.get("v");
            if (!(v instanceof Double) || ((Double) v).intValue() != PROTOCOL_VERSION) throw new IllegalArgumentException("meta.v");
        } catch (MiniJson.JsonException e) {
            throw new IllegalArgumentException("meta is not valid JSON");
        }
        byte[] msg = new byte[8 + metaJson.length + jpeg.length];
        msg[0] = 'R';
        msg[1] = 'V';
        msg[2] = 'F';
        msg[3] = '1';
        msg[4] = (byte) (metaJson.length >>> 24);
        msg[5] = (byte) (metaJson.length >>> 16);
        msg[6] = (byte) (metaJson.length >>> 8);
        msg[7] = (byte) metaJson.length;
        System.arraycopy(metaJson, 0, msg, 8, metaJson.length);
        System.arraycopy(jpeg, 0, msg, 8 + metaJson.length, jpeg.length);
        long now = mono();
        List<ViewerConn> copy;
        synchronized (state) {
            lastFrameAtMs = now;
            framesPublished++;
            copy = new ArrayList<>(viewers);
        }
        for (ViewerConn c : copy) c.offerFrame(msg, seq, now);
    }

    /** {@code json} must be a JSON object; it is relayed to viewers as {@code rear} in the 1 Hz status. */
    public void publishRearStatus(String json) {
        try {
            MiniJson.parseObject(json, MAX_TEXT_BYTES - 1024);
        } catch (MiniJson.JsonException e) {
            throw new IllegalArgumentException("rear status is not a JSON object");
        }
        synchronized (state) {
            rearJson = json;
            rearAtMs = mono();
        }
    }

    // ---- accept and per-connection handling ---------------------------------------------------------------------------

    private void acceptLoop() {
        while (running) {
            Socket s;
            try {
                s = server.accept();
            } catch (IOException e) {
                return;
            }
            if (connections.incrementAndGet() > MAX_CONNECTIONS) {
                connections.decrementAndGet();
                closeQuietly(s);
                continue;
            }
            daemon("viewer-conn", () -> {
                try {
                    handle(s);
                } catch (IOException | RuntimeException ignored) {
                    // connection ended or misbehaved; nothing to report beyond closing
                } finally {
                    closeQuietly(s);
                    connections.decrementAndGet();
                }
            });
        }
    }

    private void handle(Socket s) throws IOException {
        s.setTcpNoDelay(true);
        s.setSoTimeout((int) HELLO_TIMEOUT_MS);
        String ip = s.getInetAddress().getHostAddress();
        InputStream in = new BufferedInputStream(s.getInputStream(), 4096);
        OutputStream out = s.getOutputStream();
        Map<String, String> h = new HashMap<>();
        String[] req;
        try {
            req = readHead(in, h);
        } catch (SocketTimeoutException | EOFException e) {
            return;
        } catch (IOException e) {
            httpSimple(out, 400, "Bad Request");
            return;
        }
        String method = req[0];
        String rawPath = req[1];
        int q = rawPath.indexOf('?');
        String path = q >= 0 ? rawPath.substring(0, q) : rawPath;
        boolean upgrade = "websocket".equalsIgnoreCase(h.get("upgrade"));

        if (upgrade && path.equals("/ws/view")) {
            if (!method.equals("GET")) {
                httpSimple(out, 405, "Method Not Allowed");
                return;
            }
            handleViewerSocket(s, in, out, h, ip);
            return;
        }
        if (!method.equals("GET") && !method.equals("HEAD")) {
            httpSimple(out, 405, "Method Not Allowed");
            return;
        }
        boolean head = method.equals("HEAD");
        if (path.equals("/healthz")) {
            httpBody(out, 200, "application/json", ("{\"ok\":true,\"v\":" + PROTOCOL_VERSION + "}").getBytes(StandardCharsets.US_ASCII), head);
            return;
        }
        String name = path.equals("/") ? "viewer.html" : path.substring(1);
        byte[] body = isSafeAssetName(name) ? assets.get(name) : null;
        if (body == null) {
            httpSimple(out, 404, "Not Found");
            return;
        }
        httpBody(out, 200, contentType(name), body, head);
    }

    private void handleViewerSocket(Socket s, InputStream in, OutputStream out, Map<String, String> h, String ip) throws IOException {
        String key = h.get("sec-websocket-key");
        if (key == null || !"13".equals(h.get("sec-websocket-version")) || key.length() > 64) {
            httpSimple(out, 400, "Bad Request");
            return;
        }
        String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + WebSocketProtocol.acceptKey(key) + "\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        long now = mono();

        // hello within HELLO_TIMEOUT_MS (socket timeout is already that)
        WebSocketProtocol.Frame f;
        try {
            f = WebSocketProtocol.readClientFrame(in, MAX_TEXT_BYTES);
        } catch (SocketTimeoutException e) {
            rejectSocket(out, 4408, "hello timeout");
            return;
        } catch (WebSocketProtocol.WsException e) {
            rejectSocket(out, e.code == 1009 ? 1009 : 4400, "malformed");
            return;
        }
        // Rejections are sent as a WebSocket close with the protocol's code so the viewer can tell why. They come after the
        // hello was read, so closing the socket cannot reset the connection before the close frame is delivered.
        if (guard.isLockedOut(ip, now) || !guard.allowConnect(ip, now)) {
            rejectSocket(out, 4429, "rate limited");
            return;
        }
        String origin = h.get("origin");
        if (!originAllowed(origin)) {
            rejectSocket(out, 4403, "origin not allowed");
            return;
        }

        if (f.opcode == WebSocketProtocol.OP_BINARY) {
            rejectSocket(out, 4401, "binary before auth");
            return;
        }
        if (f.opcode != WebSocketProtocol.OP_TEXT) {
            rejectSocket(out, 4400, "expected hello");
            return;
        }
        Map<String, Object> hello;
        try {
            hello = MiniJson.parseObject(new String(f.payload, StandardCharsets.UTF_8), MAX_TEXT_BYTES);
        } catch (MiniJson.JsonException e) {
            rejectSocket(out, 4400, "malformed");
            return;
        }
        Object ver = hello.get("v");
        if (!(ver instanceof Double)) {
            rejectSocket(out, 4400, "missing version");
            return;
        }
        if (((Double) ver).intValue() != PROTOCOL_VERSION) {
            rejectSocket(out, 4426, "unsupported version");
            return;
        }
        Object type = hello.get("type");
        Object tok = hello.get("token");
        Object cid = hello.get("clientId");
        if (!"hello".equals(type) || !(tok instanceof String) || ((String) tok).isEmpty() || ((String) tok).length() > 64
                || !(cid instanceof String) || ((String) cid).isEmpty() || ((String) cid).length() > 64) {
            rejectSocket(out, 4400, "malformed hello");
            return;
        }
        String expected;
        long issued;
        synchronized (state) {
            expected = token;
            issued = tokenIssuedAtMs;
        }
        if (now - issued > cfg.tokenTtlMs) {
            rejectSocket(out, 4411, "session expired");
            return;
        }
        if (!constantTimeEquals((String) tok, expected)) {
            guard.recordFailure(ip, now);
            rejectSocket(out, 4401, "invalid token");
            return;
        }

        ViewerConn conn = new ViewerConn(s, out, ip, ACK_CREDIT, c -> {
            synchronized (state) {
                viewers.remove(c);
            }
        });
        ViewerConn evict = null;
        synchronized (state) {
            if (viewers.size() >= MAX_VIEWERS) {
                // Replace a viewer that has gone silent (a phone whose screen turned off) rather than refusing the newcomer.
                for (ViewerConn v : viewers) if (v.idleMs(mono()) > EVICT_IDLE_MS && (evict == null || v.idleMs(mono()) > evict.idleMs(mono()))) evict = v;
                if (evict != null) {
                    viewers.remove(evict);
                    viewers.add(conn);
                } else {
                    conn = null;
                }
            } else {
                viewers.add(conn);
            }
        }
        if (evict != null) {
            evict.sendText(errorJson(4430, "replaced by a newer viewer"));
            evict.close(4430, "replaced", mono());
        }
        if (conn == null) {
            rejectSocket(out, 4430, "viewer limit reached");
            return;
        }
        conn.sendText(welcomeJson());
        conn.start();
        s.setSoTimeout((int) IDLE_TIMEOUT_MS);
        readViewerMessages(in, conn);
        // Let the writer flush queued messages and the close frame, then drain what the peer still sends so that closing the
        // socket does not reset the connection and discard the close frame.
        conn.awaitCloseSent(2000);
        drainQuietly(s, in);
    }

    private static void drainQuietly(Socket s, InputStream in) {
        try {
            s.setSoTimeout(300);
            byte[] buf = new byte[1024];
            int total = 0;
            while (total < 64 * 1024) {
                int n = in.read(buf);
                if (n < 0) return;
                total += n;
            }
        } catch (IOException ignored) {
            // timeout or reset: done
        }
    }

    private void readViewerMessages(InputStream in, ViewerConn conn) {
        long windowStart = mono();
        int inWindow = 0;
        try {
            while (running) {
                WebSocketProtocol.Frame f = WebSocketProtocol.readClientFrame(in, MAX_TEXT_BYTES);
                long now = mono();
                conn.touch(now);
                if (now - windowStart >= 1000) {
                    windowStart = now;
                    inWindow = 0;
                }
                if (++inWindow > MSGS_PER_SECOND) {
                    conn.sendText(errorJson(4429, "rate limited"));
                    conn.close(4429, "rate limited", now);
                    return;
                }
                if (f.opcode == WebSocketProtocol.OP_CLOSE) {
                    conn.close(1000, "bye", now);
                    return;
                }
                if (f.opcode == WebSocketProtocol.OP_PING || f.opcode == WebSocketProtocol.OP_PONG) continue;
                if (f.opcode != WebSocketProtocol.OP_TEXT) {
                    conn.sendText(errorJson(4400, "text only"));
                    conn.close(4400, "text only", now);
                    return;
                }
                Map<String, Object> m = MiniJson.parseObject(new String(f.payload, StandardCharsets.UTF_8), MAX_TEXT_BYTES);
                Object v = m.get("v");
                if (!(v instanceof Double) || ((Double) v).intValue() != PROTOCOL_VERSION) throw new MiniJson.JsonException("version");
                Object type = m.get("type");
                if ("ack".equals(type)) {
                    Object seq = m.get("seq");
                    if (!(seq instanceof Double)) throw new MiniJson.JsonException("seq");
                    double d = (Double) seq;
                    if (d < 0 || d > 4294967295.0 || d != Math.floor(d)) throw new MiniJson.JsonException("seq");
                    conn.ack((long) d, now);
                } else if ("ping".equals(type)) {
                    Object t = m.get("tClientMs");
                    if (!(t instanceof Double)) throw new MiniJson.JsonException("tClientMs");
                    conn.sendText(("{\"v\":1,\"type\":\"pong\",\"tClientMs\":" + numberText((Double) t) + ",\"serverTimeMs\":" + System.currentTimeMillis() + "}").getBytes(StandardCharsets.UTF_8));
                } else {
                    throw new MiniJson.JsonException("unknown type");
                }
            }
        } catch (WebSocketProtocol.WsException e) {
            conn.sendText(errorJson(e.code == 1009 ? 1009 : 4400, "protocol error"));
            conn.close(e.code == 1009 ? 1009 : 4400, "protocol error", mono());
        } catch (MiniJson.JsonException e) {
            conn.sendText(errorJson(4400, "malformed message"));
            conn.close(4400, "malformed message", mono());
        } catch (IOException e) {
            conn.close(1001, "gone", mono()); // includes idle timeout and peer disconnect
        }
    }

    // ---- 1 Hz status, stall and expiry ----------------------------------------------------------------------------------

    private void tickLoop() {
        long nextStatus = mono();
        while (running) {
            sleep(100);
            long now = mono();
            List<ViewerConn> copy;
            long issued;
            String rear;
            long rearAt;
            long lastFrame;
            synchronized (state) {
                copy = new ArrayList<>(viewers);
                issued = tokenIssuedAtMs;
                rear = rearJson;
                rearAt = rearAtMs;
                lastFrame = lastFrameAtMs;
            }
            boolean expired = now - issued > cfg.tokenTtlMs;
            for (ViewerConn c : copy) {
                if (expired) {
                    c.sendText(errorJson(4411, "session expired"));
                    c.close(4411, "session expired", now);
                } else if (c.isStalled(now)) {
                    c.sendText(errorJson(4440, "ack timeout"));
                    c.close(4440, "ack timeout", now);
                }
                if (c.closeOverdue(now)) c.kill();
            }
            if (now >= nextStatus) {
                nextStatus = now + STATUS_EVERY_MS;
                byte[] status = statusJson(copy.size(), lastFrame, now, rear != null && now - rearAt <= REAR_STALE_MS ? rear : null);
                for (ViewerConn c : copy) c.sendText(status);
            }
        }
    }

    private byte[] statusJson(int viewerCount, long lastFrame, long now, String rear) {
        boolean ingest = lastFrame >= 0 && now - lastFrame <= REAR_STALE_MS;
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"v\":1,\"type\":\"status\",\"serverTimeMs\":").append(System.currentTimeMillis());
        sb.append(",\"ingest\":\"").append(ingest ? "connected" : "disconnected").append('"');
        sb.append(",\"lastFrameAgeMs\":").append(lastFrame >= 0 ? Long.toString(now - lastFrame) : "null");
        sb.append(",\"viewers\":").append(viewerCount);
        sb.append(",\"rear\":").append(rear == null ? "null" : rear).append('}');
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    private byte[] welcomeJson() {
        return ("{\"v\":1,\"type\":\"welcome\",\"sessionId\":\"" + sessionId + "\",\"serverTimeMs\":" + System.currentTimeMillis()
                + ",\"stream\":{\"w\":" + cfg.streamW + ",\"h\":" + cfg.streamH + ",\"targetFps\":" + cfg.targetFps
                + "},\"limits\":{\"maxFrameBytes\":" + MAX_JPEG_BYTES + "},\"statusEveryMs\":" + STATUS_EVERY_MS + "}").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] errorJson(int code, String msg) {
        return ("{\"v\":1,\"type\":\"error\",\"code\":" + code + ",\"msg\":\"" + msg.replace("\"", "'") + "\"}").getBytes(StandardCharsets.UTF_8);
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------------

    private boolean originAllowed(String origin) {
        if (origin == null) return false;
        if (origin.equals(allowedOrigin)) return true;
        return cfg.extraOrigins.contains(origin);
    }

    static boolean validToken(String t) {
        if (t == null || t.length() != 22) return false;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
        }
        return true;
    }

    static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    static boolean isSafeAssetName(String name) {
        if (name.isEmpty() || name.length() > 120 || name.startsWith("/") || name.contains("..") || name.contains("//")) return false;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' || c == '/';
            if (!ok) return false;
        }
        return true;
    }

    private static String contentType(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /** Reads the request line and headers (names lower-cased). Throws IOException for anything malformed or too large. */
    private static String[] readHead(InputStream in, Map<String, String> headers) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(512);
        int state = 0;
        while (state < 4) {
            int b = in.read();
            if (b < 0) throw new EOFException();
            buf.write(b);
            if (buf.size() > MAX_HEAD_BYTES) throw new IOException("request head too large");
            if ((b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3))) state++;
            else state = b == '\r' ? 1 : 0;
        }
        String head = new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
        String[] lines = head.split("\r\n");
        String[] parts = lines[0].split(" ");
        if (parts.length != 3 || !parts[2].startsWith("HTTP/1.") || !parts[1].startsWith("/")) throw new IOException("bad request line");
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
        }
        return new String[] {parts[0], parts[1]};
    }

    private static void httpSimple(OutputStream out, int status, String reason) throws IOException {
        httpBody(out, status, "text/plain; charset=utf-8", (reason + "\n").getBytes(StandardCharsets.US_ASCII), false);
    }

    private static void httpBody(OutputStream out, int status, String type, byte[] body, boolean headOnly) throws IOException {
        String reason = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Bad Request";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n"
                + "Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly) out.write(body);
        out.flush();
    }

    private static void rejectSocket(OutputStream out, int code, String reason) {
        try {
            WebSocketProtocol.writeServerFrame(out, WebSocketProtocol.OP_TEXT, errorJson(code, reason));
            WebSocketProtocol.writeServerFrame(out, WebSocketProtocol.OP_CLOSE, WebSocketProtocol.closePayload(code, reason));
        } catch (IOException ignored) {
            // peer already gone
        }
    }

    private String randomToken(int bytes) {
        byte[] b = new byte[bytes];
        rng.nextBytes(b);
        return Base64Util.encode(b, true);
    }

    private static String numberText(double d) {
        return d == Math.floor(d) && Math.abs(d) < 1e15 ? Long.toString((long) d) : Double.toString(d);
    }

    private static long mono() {
        return System.nanoTime() / 1_000_000L;
    }

    private static Thread daemon(String name, Runnable r) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (IOException ignored) {
            // closing
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
