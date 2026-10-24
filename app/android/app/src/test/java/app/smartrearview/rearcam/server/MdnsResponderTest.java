package app.smartrearview.rearcam.server;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class MdnsResponderTest {
    private static byte[] query(String name, int type, int cls, int flags) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0);
        o.write(0);
        o.write(flags >> 8);
        o.write(flags);
        o.write(0);
        o.write(1); // one question
        o.write(0);
        o.write(0);
        o.write(0);
        o.write(0);
        o.write(0);
        o.write(0);
        for (String label : name.split("\\.")) {
            o.write(label.length());
            byte[] b = label.getBytes(StandardCharsets.US_ASCII);
            o.write(b, 0, b.length);
        }
        o.write(0);
        o.write(type >> 8);
        o.write(type);
        o.write(cls >> 8);
        o.write(cls);
        return o.toByteArray();
    }

    @Test
    public void answersAQueriesForItsNameOnly() {
        byte[] q = query("rearview.local", 1, 1, 0);
        assertTrue(MdnsResponder.asksForHost(q, q.length, "rearview"));
        byte[] upper = query("ReArView.LOCAL", 1, 1, 0);
        assertTrue(MdnsResponder.asksForHost(upper, upper.length, "rearview"));
        byte[] any = query("rearview.local", 255, 1, 0);
        assertTrue(MdnsResponder.asksForHost(any, any.length, "rearview"));
        byte[] unicastBit = query("rearview.local", 1, 0x8001, 0);
        assertTrue(MdnsResponder.asksForHost(unicastBit, unicastBit.length, "rearview"));
    }

    @Test
    public void ignoresOtherNamesTypesResponsesAndGarbage() {
        byte[] other = query("printer.local", 1, 1, 0);
        assertFalse(MdnsResponder.asksForHost(other, other.length, "rearview"));
        byte[] aaaa = query("rearview.local", 28, 1, 0);
        assertFalse(MdnsResponder.asksForHost(aaaa, aaaa.length, "rearview"));
        byte[] resp = query("rearview.local", 1, 1, 0x8400);
        assertFalse(MdnsResponder.asksForHost(resp, resp.length, "rearview"));
        byte[] wrongClass = query("rearview.local", 1, 3, 0);
        assertFalse(MdnsResponder.asksForHost(wrongClass, wrongClass.length, "rearview"));
        byte[] sub = query("x.rearview.local", 1, 1, 0);
        assertFalse(MdnsResponder.asksForHost(sub, sub.length, "rearview"));
        assertFalse(MdnsResponder.asksForHost(new byte[5], 5, "rearview"));
        byte[] truncated = query("rearview.local", 1, 1, 0);
        assertFalse(MdnsResponder.asksForHost(truncated, truncated.length - 3, "rearview"));
        byte[] compressed = query("rearview.local", 1, 1, 0);
        compressed[12] = (byte) 0xC0; // a compression pointer where a label length should be
        assertFalse(MdnsResponder.asksForHost(compressed, compressed.length, "rearview"));
    }

    @Test
    public void buildsAWellFormedAuthoritativeAResponse() {
        byte[] r = MdnsResponder.response("rearview", new byte[] {(byte) 192, (byte) 168, 43, 1});
        assertEquals(0x84, r[2] & 0xFF); // QR + AA
        assertEquals(1, r[7]); // one answer
        assertEquals(8, r[12]); // "rearview"
        assertEquals("rearview", new String(r, 13, 8, StandardCharsets.US_ASCII));
        assertEquals(5, r[21]); // "local"
        assertEquals(0, r[27]); // end of name
        assertEquals(1, r[29]); // type A
        assertEquals((byte) 0x80, r[30]); // cache-flush + class IN high byte
        assertEquals(1, r[31]);
        assertEquals(MdnsResponder.TTL_SECONDS, ((r[34] & 0xFF) << 8) | (r[35] & 0xFF));
        assertEquals(4, r[37]);
        assertArrayEquals(new byte[] {(byte) 192, (byte) 168, 43, 1}, java.util.Arrays.copyOfRange(r, 38, 42));
        assertEquals(42, r.length);
    }
}
