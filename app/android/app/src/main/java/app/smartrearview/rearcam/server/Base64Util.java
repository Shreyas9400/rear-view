package app.smartrearview.rearcam.server;

/** Base64 encoder that works on every Android API level and in plain JVM tests (java.util.Base64 needs API 26). */
public final class Base64Util {
    private static final char[] STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
    private static final char[] URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    private Base64Util() {}

    /** Standard alphabet with padding, or the URL-safe alphabet without padding. */
    public static String encode(byte[] in, boolean urlSafe) {
        char[] a = urlSafe ? URL : STD;
        StringBuilder sb = new StringBuilder((in.length + 2) / 3 * 4);
        for (int i = 0; i < in.length; i += 3) {
            int b0 = in[i] & 0xFF;
            int b1 = i + 1 < in.length ? in[i + 1] & 0xFF : 0;
            int b2 = i + 2 < in.length ? in[i + 2] & 0xFF : 0;
            sb.append(a[b0 >> 2]);
            sb.append(a[((b0 & 3) << 4) | (b1 >> 4)]);
            if (i + 1 < in.length) sb.append(a[((b1 & 15) << 2) | (b2 >> 6)]);
            else if (!urlSafe) sb.append('=');
            if (i + 2 < in.length) sb.append(a[b2 & 63]);
            else if (!urlSafe) sb.append('=');
        }
        return sb.toString();
    }
}
