package app.smartrearview.rearcam.server;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class LocalServerTest {
    private LocalServer server;
    private String origin;

    @Before
    public void up() throws Exception {
        LocalServer.Config cfg = new LocalServer.Config();
        cfg.bind = InetAddress.getByName("127.0.0.1");
        cfg.port = 0;
        server = new LocalServer(cfg, name -> name.equals("viewer.html") ? "<html>viewer</html>".getBytes(StandardCharsets.UTF_8) : name.equals("assets/a.js") ? "var a=1;".getBytes(StandardCharsets.UTF_8) : null);
        server.start();
        origin = server.origin();
    }

    @After
    public void down() {
        server.stop();
    }

    // ---- test client --------------------------------------------------------------------------------------------------

    static final class Client implements AutoCloseable {
        final Socket s;
        final InputStream in;
        final OutputStream out;

        Client(int port) throws IOException {
            s = new Socket(InetAddress.getByName("127.0.0.1"), port);
            s.setSoTimeout(4000);
            in = s.getInputStream();
            out = s.getOutputStream();
        }

        void raw(String text) throws IOException {
            out.write(text.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        }

        String readHead() throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            while (!b.toString("ISO-8859-1").endsWith("\r\n\r\n")) {
                int c = in.read();
                if (c < 0) break;
                b.write(c);
            }
            return b.toString("ISO-8859-1");
        }

        String upgrade(String originHeader) throws IOException {
            raw("GET /ws/view HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
                    + (originHeader == null ? "" : "Origin: " + originHeader + "\r\n") + "\r\n");
            return readHead();
        }

        void send(int opcode, byte[] payload) throws IOException {
            ByteArrayOutputStream f = new ByteArrayOutputStream();
            f.write(0x80 | opcode);
            if (payload.length < 126) f.write(0x80 | payload.length);
            else {
                f.write(0x80 | 126);
                f.write(payload.length >> 8);
                f.write(payload.length);
            }
            byte[] mask = {1, 2, 3, 4};
            f.write(mask);
            for (int i = 0; i < payload.length; i++) f.write(payload[i] ^ mask[i & 3]);
            out.write(f.toByteArray());
            out.flush();
        }

        void text(String t) throws IOException {
            send(WebSocketProtocol.OP_TEXT, t.getBytes(StandardCharsets.UTF_8));
        }

        /** Reads one server frame: [opcode, payload]. */
        Object[] read() throws IOException {
            int b0 = in.read();
            if (b0 < 0) throw new EOFException();
            int b1 = in.read();
            long len = b1 & 0x7F;
            if (len == 126) len = (in.read() << 8) | in.read();
            else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | in.read();
            }
            byte[] p = new byte[(int) len];
            int off = 0;
            while (off < p.length) {
                int r = in.read(p, off, p.length - off);
                if (r < 0) throw new EOFException();
                off += r;
            }
            return new Object[] {b0 & 0x0F, p};
        }

        /** Reads frames until a text of the given type arrives (skips status etc.); returns the JSON text. */
        String readText(String type) throws IOException {
            while (true) {
                Object[] f = read();
                if ((Integer) f[0] == WebSocketProtocol.OP_TEXT) {
                    String t = new String((byte[]) f[1], StandardCharsets.UTF_8);
                    if (t.contains("\"type\":\"" + type + "\"")) return t;
                }
                if ((Integer) f[0] == WebSocketProtocol.OP_CLOSE) fail("closed while waiting for " + type);
            }
        }

        /** Reads until a close frame; returns its code. Text frames before it are ignored. */
        int readCloseCode() throws IOException {
            while (true) {
                Object[] f = read();
                if ((Integer) f[0] == WebSocketProtocol.OP_CLOSE) {
                    byte[] p = (byte[]) f[1];
                    return ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
                }
            }
        }

        byte[] readBinary() throws IOException {
            while (true) {
                Object[] f = read();
                if ((Integer) f[0] == WebSocketProtocol.OP_BINARY) return (byte[]) f[1];
                if ((Integer) f[0] == WebSocketProtocol.OP_CLOSE) fail("closed while waiting for a frame");
            }
        }

        @Override
        public void close() throws IOException {
            s.close();
        }
    }

    private Client viewer() throws Exception {
        Client c = new Client(server.port());
        assertTrue(c.upgrade(origin).startsWith("HTTP/1.1 101"));
        c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"" + server.sessionToken() + "\",\"clientId\":\"c-1\"}");
        c.readText("welcome");
        return c;
    }

    private static byte[] jpeg(int n) {
        byte[] b = new byte[n];
        b[0] = (byte) 0xFF;
        b[1] = (byte) 0xD8;
        return b;
    }

    private static byte[] meta(int seq) {
        return ("{\"v\":1,\"seq\":" + seq + "}").getBytes(StandardCharsets.UTF_8);
    }

    // ---- protocol pieces --------------------------------------------------------------------------------------------

    @Test
    public void acceptKeyMatchesRfcExample() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", WebSocketProtocol.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="));
    }

    @Test
    public void base64UrlHasNoPaddingAndNoUnsafeChars() {
        String t = Base64Util.encode(new byte[] {(byte) 0xFB, (byte) 0xFF, (byte) 0xFE, 1}, true);
        assertFalse(t.contains("=") || t.contains("+") || t.contains("/"));
        assertEquals("+//+AQ==", Base64Util.encode(new byte[] {(byte) 0xFB, (byte) 0xFF, (byte) 0xFE, 1}, false));
        assertEquals("-__-AQ", t);
    }

    @Test
    public void readsMaskedFramesAndRejectsBadOnes() throws Exception {
        byte[] masked = {(byte) 0x81, (byte) 0x82, 1, 2, 3, 4, (byte) ('h' ^ 1), (byte) ('i' ^ 2)};
        WebSocketProtocol.Frame f = WebSocketProtocol.readClientFrame(new ByteArrayInputStream(masked), 100);
        assertEquals(WebSocketProtocol.OP_TEXT, f.opcode);
        assertEquals("hi", new String(f.payload, StandardCharsets.UTF_8));
        assertWsCode(1002, new byte[] {(byte) 0x81, 0x01, 'x'}, 100); // unmasked
        assertWsCode(1003, new byte[] {0x01, (byte) 0x81, 1, 2, 3, 4, 0}, 100); // not FIN (fragment)
        assertWsCode(1009, new byte[] {(byte) 0x81, (byte) 0xFE, 0x10, 0x00, 1, 2, 3, 4}, 100); // 4096 > max
        assertWsCode(1002, new byte[] {(byte) 0xC1, (byte) 0x80, 1, 2, 3, 4}, 100); // RSV1
        assertWsCode(1002, new byte[] {(byte) 0x89, (byte) 0xFE, 0, 126, 1, 2, 3, 4}, 1000); // control frame > 125
    }

    private static void assertWsCode(int code, byte[] in, int max) throws IOException {
        try {
            WebSocketProtocol.readClientFrame(new ByteArrayInputStream(in), max);
            fail("expected WsException " + code);
        } catch (WebSocketProtocol.WsException e) {
            assertEquals(code, e.code);
        }
    }

    @Test
    public void writesServerFramesWithAllLengthForms() throws Exception {
        for (int n : new int[] {0, 125, 126, 70000}) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            WebSocketProtocol.writeServerFrame(o, WebSocketProtocol.OP_BINARY, new byte[n]);
            assertEquals(n + (n < 126 ? 2 : n <= 0xFFFF ? 4 : 10), o.size());
            assertEquals((byte) 0x82, o.toByteArray()[0]);
        }
    }

    @Test
    public void miniJsonParsesAndRejects() throws Exception {
        Map<String, Object> m = MiniJson.parseObject("{\"v\":1,\"a\":[1,2,{\"b\":null}],\"s\":\"x\\u0041\\n\",\"t\":true}", 1000);
        assertEquals(1.0, (Double) m.get("v"), 0);
        assertEquals("xA\n", m.get("s"));
        for (String bad : new String[] {"", "{", "{\"a\":}", "[1,]", "{\"a\":1} x", "{'a':1}", "{\"a\":NaN}", "{\"a\":\"\u0001\"}", "[[[[[[[[[[1]]]]]]]]]]"}) {
            try {
                MiniJson.parse(bad, 1000);
                fail("accepted: " + bad);
            } catch (MiniJson.JsonException expected) {
                // ok
            }
        }
        try {
            MiniJson.parse("[1,2,3]", 3);
            fail("length limit");
        } catch (MiniJson.JsonException expected) {
            // ok
        }
    }

    @Test
    public void authGuardLocksOutAfterFiveFailuresAndLimitsConnects() {
        AuthGuard g = new AuthGuard();
        for (int i = 0; i < 4; i++) assertFalse(g.recordFailure("1.2.3.4", 1000L + i));
        assertFalse(g.isLockedOut("1.2.3.4", 1010));
        assertTrue(g.recordFailure("1.2.3.4", 1020));
        assertTrue(g.isLockedOut("1.2.3.4", 1030));
        assertFalse(g.isLockedOut("5.6.7.8", 1030));
        assertFalse(g.isLockedOut("1.2.3.4", 1020 + AuthGuard.LOCKOUT_MS));
        for (int i = 0; i < AuthGuard.MAX_CONNECTS; i++) assertTrue(g.allowConnect("9.9.9.9", 5000));
        assertFalse(g.allowConnect("9.9.9.9", 5001));
        assertTrue(g.allowConnect("9.9.9.9", 5000 + AuthGuard.CONNECT_WINDOW_MS + 1));
    }

    // ---- HTTP ---------------------------------------------------------------------------------------------------------

    private String http(String request) throws Exception {
        try (Client c = new Client(server.port())) {
            c.raw(request);
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            int x;
            try {
                while ((x = c.in.read()) >= 0) b.write(x);
            } catch (SocketTimeoutException ignored) {
                // server keeps nothing open; fall through
            }
            return b.toString("ISO-8859-1");
        }
    }

    @Test
    public void servesViewerHealthzAndAllowListedAssetsOnly() throws Exception {
        String root = http("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        assertTrue(root.startsWith("HTTP/1.1 200"));
        assertTrue(root.contains("Cache-Control: no-store"));
        assertTrue(root.contains("<html>viewer</html>"));
        assertTrue(http("GET /healthz HTTP/1.1\r\n\r\n").contains("{\"ok\":true,\"v\":1}"));
        assertTrue(http("GET /assets/a.js HTTP/1.1\r\n\r\n").contains("var a=1;"));
        assertTrue(http("GET /assets/b.js HTTP/1.1\r\n\r\n").startsWith("HTTP/1.1 404"));
        assertTrue(http("GET /../etc/passwd HTTP/1.1\r\n\r\n").startsWith("HTTP/1.1 404"));
        assertTrue(http("GET /assets/%2e%2e/x HTTP/1.1\r\n\r\n").startsWith("HTTP/1.1 404"));
        assertTrue(http("POST / HTTP/1.1\r\nContent-Length: 0\r\n\r\n").startsWith("HTTP/1.1 405"));
        assertTrue(http("garbage\r\n\r\n").startsWith("HTTP/1.1 400"));
        assertFalse(http("HEAD / HTTP/1.1\r\n\r\n").contains("<html>"));
    }

    @Test
    public void viewerPageContainsNoToken() throws Exception {
        assertFalse(http("GET / HTTP/1.1\r\n\r\n").contains(server.sessionToken()));
        assertFalse(http("GET /healthz HTTP/1.1\r\n\r\n").contains(server.sessionToken()));
    }

    // ---- WebSocket: auth ----------------------------------------------------------------------------------------------

    @Test
    public void helloWithValidTokenGetsWelcomeThenStatus() throws Exception {
        try (Client c = viewer()) {
            String status = c.readText("status");
            assertTrue(status.contains("\"ingest\":\"disconnected\""));
            assertTrue(status.contains("\"viewers\":1"));
            assertTrue(status.contains("\"rear\":null"));
        }
    }

    @Test
    public void wrongTokenIsRejectedWith4401() throws Exception {
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"nope\",\"clientId\":\"c\"}");
            assertEquals(4401, c.readCloseCode());
        }
    }

    @Test
    public void foreignOriginAndMissingOriginAreRejectedWith4403() throws Exception {
        for (String o : new String[] {"http://evil.example", null, "http://127.0.0.1:1"}) {
            try (Client c = new Client(server.port())) {
                c.upgrade(o);
                c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"" + server.sessionToken() + "\",\"clientId\":\"c\"}");
                assertEquals("origin " + o, 4403, c.readCloseCode());
            }
        }
    }

    @Test
    public void binaryBeforeAuthIsRejectedWith4401() throws Exception {
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.send(WebSocketProtocol.OP_BINARY, new byte[] {1, 2, 3});
            assertEquals(4401, c.readCloseCode());
        }
    }

    @Test
    public void silentSocketGetsHelloTimeout4408() throws Exception {
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            assertEquals(4408, c.readCloseCode());
        }
    }

    @Test
    public void unsupportedVersionAndMalformedHelloAreRejected() throws Exception {
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("{\"v\":2,\"type\":\"hello\",\"token\":\"x\",\"clientId\":\"c\"}");
            assertEquals(4426, c.readCloseCode());
        }
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("not json");
            assertEquals(4400, c.readCloseCode());
        }
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("{\"v\":1,\"type\":\"hello\",\"clientId\":\"c\"}");
            assertEquals(4400, c.readCloseCode());
        }
    }

    @Test
    public void fiveWrongTokensLockTheAddressOutEvenForTheRightToken() throws Exception {
        for (int i = 0; i < 5; i++) {
            try (Client c = new Client(server.port())) {
                c.upgrade(origin);
                c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"bad" + i + "\",\"clientId\":\"c\"}");
                assertEquals(4401, c.readCloseCode());
            }
        }
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"" + server.sessionToken() + "\",\"clientId\":\"c\"}");
            assertEquals(4429, c.readCloseCode());
        }
    }

    @Test
    public void thirdViewerIsRejectedWith4430() throws Exception {
        try (Client a = viewer(); Client b = viewer(); Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"" + server.sessionToken() + "\",\"clientId\":\"c\"}");
            assertEquals(4430, c.readCloseCode());
            assertEquals(2, server.viewerCount());
        }
    }

    @Test
    public void revokeClosesViewersWith4410AndOldTokenStopsWorking() throws Exception {
        String old = server.sessionToken();
        try (Client c = viewer()) {
            String fresh = server.revoke();
            assertFalse(old.equals(fresh));
            assertEquals(4410, c.readCloseCode());
        }
        try (Client c = new Client(server.port())) {
            c.upgrade(origin);
            c.text("{\"v\":1,\"type\":\"hello\",\"token\":\"" + old + "\",\"clientId\":\"c\"}");
            assertEquals(4401, c.readCloseCode());
        }
    }

    @Test
    public void tokenIsSixteenRandomBytesInBase64Url() {
        String t = server.sessionToken();
        assertEquals(22, t.length());
        assertTrue(t.matches("[A-Za-z0-9_-]{22}"));
    }

    // ---- WebSocket: relay ----------------------------------------------------------------------------------------------

    @Test
    public void framesArriveByteForByteAndStatusReflectsIngest() throws Exception {
        try (Client c = viewer()) {
            byte[] j = jpeg(1000);
            for (int i = 2; i < j.length; i++) j[i] = (byte) i;
            byte[] m = meta(7);
            server.publishFrame(7, m, j);
            byte[] msg = c.readBinary();
            assertEquals('R', msg[0]);
            assertEquals('1', msg[3]);
            int metaLen = ((msg[4] & 0xFF) << 24) | ((msg[5] & 0xFF) << 16) | ((msg[6] & 0xFF) << 8) | (msg[7] & 0xFF);
            assertEquals(m.length, metaLen);
            byte[] gotMeta = new byte[metaLen];
            System.arraycopy(msg, 8, gotMeta, 0, metaLen);
            assertArrayEquals(m, gotMeta);
            byte[] gotJpeg = new byte[msg.length - 8 - metaLen];
            System.arraycopy(msg, 8 + metaLen, gotJpeg, 0, gotJpeg.length);
            assertArrayEquals(j, gotJpeg);
            server.publishRearStatus("{\"alert\":{\"level\":\"NORMAL\"}}");
            String st;
            do {
                st = c.readText("status");
            } while (!st.contains("\"ingest\":\"connected\""));
            assertTrue(st.contains("\"rear\":{\"alert\":{\"level\":\"NORMAL\"}}"));
        }
    }

    @Test
    public void slowViewerGetsOnlyTwoFramesThenTheNewestAfterAck() throws Exception {
        try (Client c = viewer()) {
            server.publishFrame(1, meta(1), jpeg(100));
            assertEquals(1, seqOf(c.readBinary()));
            server.publishFrame(2, meta(2), jpeg(100));
            assertEquals(2, seqOf(c.readBinary())); // two frames in flight, none acknowledged
            for (int s = 3; s <= 10; s++) server.publishFrame(s, meta(s), jpeg(100));
            c.s.setSoTimeout(400);
            try {
                c.readBinary();
                fail("third frame sent without credit");
            } catch (SocketTimeoutException expected) {
                // credit window of 2 holds the rest back
            }
            c.s.setSoTimeout(4000);
            c.text("{\"v\":1,\"type\":\"ack\",\"seq\":2}");
            assertEquals(10, seqOf(c.readBinary())); // the intermediate frames were replaced; only the newest is sent
        }
    }

    private static int seqOf(byte[] msg) {
        String meta = new String(msg, 8, msg.length - 8 - 100, StandardCharsets.UTF_8);
        int i = meta.indexOf("\"seq\":") + 6;
        int j = i;
        while (Character.isDigit(meta.charAt(j))) j++;
        return Integer.parseInt(meta.substring(i, j));
    }

    @Test
    public void viewerThatNeverAcksIsClosedWith4440() throws Exception {
        try (Client c = viewer()) {
            server.publishFrame(1, meta(1), jpeg(100));
            c.readBinary();
            assertEquals(4440, c.readCloseCode());
        }
    }

    @Test
    public void pingGetsPongAndRateLimitCloses4429() throws Exception {
        try (Client c = viewer()) {
            c.text("{\"v\":1,\"type\":\"ping\",\"tClientMs\":12345}");
            String pong = c.readText("pong");
            assertTrue(pong.contains("\"tClientMs\":12345"));
            assertTrue(pong.contains("serverTimeMs"));
            for (int i = 0; i < 40; i++) c.text("{\"v\":1,\"type\":\"ack\",\"seq\":0}");
            assertEquals(4429, c.readCloseCode());
        }
    }

    @Test
    public void unknownMessageTypeAndBinaryFromViewerClose4400() throws Exception {
        try (Client c = viewer()) {
            c.text("{\"v\":1,\"type\":\"rear_status\"}");
            assertEquals(4400, c.readCloseCode());
        }
        try (Client c = viewer()) {
            c.send(WebSocketProtocol.OP_BINARY, new byte[] {1});
            assertEquals(4400, c.readCloseCode());
        }
    }

    @Test
    public void publishValidatesFramesAndStatus() {
        expectIllegal(() -> server.publishFrame(1, meta(1), new byte[] {1, 2, 3, 4})); // not a JPEG
        expectIllegal(() -> server.publishFrame(1, "{\"v\":2}".getBytes(StandardCharsets.UTF_8), jpeg(10)));
        expectIllegal(() -> server.publishFrame(1, "nope".getBytes(StandardCharsets.UTF_8), jpeg(10)));
        expectIllegal(() -> server.publishFrame(1, meta(1), jpeg(600 * 1024)));
        expectIllegal(() -> server.publishFrame(-1, meta(1), jpeg(10)));
        expectIllegal(() -> server.publishRearStatus("[1]"));
        expectIllegal(() -> server.publishRearStatus("garbage"));
        assertEquals(0, server.framesPublished());
    }

    private interface Thrower {
        void run();
    }

    private static void expectIllegal(Thrower t) {
        try {
            t.run();
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertNotNull(expected.getMessage());
        }
    }

    @Test
    public void staleRearStatusIsDroppedFromStatusAfterTwoSeconds() throws Exception {
        try (Client c = viewer()) {
            server.publishRearStatus("{\"x\":1}");
            Thread.sleep(2300);
            String st;
            do {
                st = c.readText("status");
            } while (st.contains("{\"x\":1}") && !st.contains("\"rear\":null"));
            assertTrue(st.contains("\"rear\":null"));
            assertNull(null);
        }
    }

    @Test
    public void stopDisconnectsViewersAndClosesThePort() throws Exception {
        Client c = viewer();
        int port = server.port();
        server.stop();
        assertEquals(1001, c.readCloseCode());
        c.close();
        try (Socket s = new Socket()) {
            s.connect(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 500);
            fail("port still open");
        } catch (IOException expected) {
            // closed
        }
    }
}
