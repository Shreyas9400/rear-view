package app.smartrearview.rearcam.server;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Minimal RFC 6455 server side: handshake accept key, frame read (client frames must be masked, no fragmentation, bounded
 * length) and frame write (unmasked). No dependencies, so it runs in plain JVM unit tests. docs/TECHNICAL_DECISIONS.md D-032.
 */
public final class WebSocketProtocol {
    public static final int OP_CONT = 0x0;
    public static final int OP_TEXT = 0x1;
    public static final int OP_BINARY = 0x2;
    public static final int OP_CLOSE = 0x8;
    public static final int OP_PING = 0x9;
    public static final int OP_PONG = 0xA;

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private WebSocketProtocol() {}

    /** A protocol violation; {@code code} is the WebSocket close code to answer with. */
    public static final class WsException extends IOException {
        public final int code;

        public WsException(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    public static final class Frame {
        public final int opcode;
        public final byte[] payload;

        Frame(int opcode, byte[] payload) {
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    public static String acceptKey(String clientKey) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] d = sha1.digest((clientKey + GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64Util.encode(d, false);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Reads one client frame. Throws {@link WsException} for: unmasked frame (1002), reserved bits (1002), fragmentation (1003),
     * oversize payload (1009), oversize or fragmented control frame (1002). Throws EOFException at end of stream.
     */
    public static Frame readClientFrame(InputStream in, int maxPayload) throws IOException {
        int b0 = readByte(in);
        int b1 = readByte(in);
        boolean fin = (b0 & 0x80) != 0;
        if ((b0 & 0x70) != 0) throw new WsException(1002, "reserved bits set");
        int opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7F;
        if (!masked) throw new WsException(1002, "client frame not masked");
        if (len == 126) {
            len = (readByte(in) << 8) | readByte(in);
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
            if (len < 0) throw new WsException(1009, "frame too large");
        }
        boolean control = (opcode & 0x8) != 0;
        if (control && (!fin || len > 125)) throw new WsException(1002, "bad control frame");
        if (!fin || opcode == OP_CONT) throw new WsException(1003, "fragmented messages not supported");
        if (opcode != OP_TEXT && opcode != OP_BINARY && !control) throw new WsException(1003, "unsupported opcode");
        if (len > maxPayload) throw new WsException(1009, "frame too large");
        byte[] mask = new byte[4];
        readFully(in, mask, 4);
        byte[] payload = new byte[(int) len];
        readFully(in, payload, payload.length);
        for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        return new Frame(opcode, payload);
    }

    /** Writes one unmasked server frame (FIN set). The caller serialises access to {@code out}. */
    public static void writeServerFrame(OutputStream out, int opcode, byte[] payload) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream(10);
        head.write(0x80 | opcode);
        if (payload.length < 126) {
            head.write(payload.length);
        } else if (payload.length <= 0xFFFF) {
            head.write(126);
            head.write(payload.length >> 8);
            head.write(payload.length);
        } else {
            head.write(127);
            long l = payload.length;
            for (int i = 7; i >= 0; i--) head.write((int) (l >> (8 * i)));
        }
        out.write(head.toByteArray());
        out.write(payload);
        out.flush();
    }

    public static byte[] closePayload(int code, String reason) {
        byte[] r = reason == null ? new byte[0] : reason.getBytes(StandardCharsets.UTF_8);
        int n = Math.min(r.length, 120);
        byte[] out = new byte[2 + n];
        out[0] = (byte) (code >> 8);
        out[1] = (byte) code;
        System.arraycopy(r, 0, out, 2, n);
        return out;
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new EOFException();
        return b;
    }

    private static void readFully(InputStream in, byte[] buf, int n) throws IOException {
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
    }
}
