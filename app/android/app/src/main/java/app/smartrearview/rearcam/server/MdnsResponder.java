package app.smartrearview.rearcam.server;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.util.Locale;

/**
 * Minimal multicast-DNS responder (RFC 6762) that answers "A" queries for ONE name, e.g. rearview.local, with this phone's IPv4
 * address, so an iPhone (Bonjour) can open http://rearview.local:8080/ without knowing the phone's IP (D-040). It answers nothing
 * else and sends nothing except those answers and one announcement at start. Packet building and matching are static and unit
 * tested; whether multicast reaches the app on the phone's hotspot interface is device-dependent and UNVERIFIED.
 */
public final class MdnsResponder {
    static final String GROUP = "224.0.0.251";
    static final int PORT = 5353;
    static final int TTL_SECONDS = 120;

    private final String host; // label only, e.g. "rearview"
    private final byte[] ip;
    private final NetworkInterface nif;
    private MulticastSocket socket;
    private volatile boolean running;
    private Thread thread;

    public MdnsResponder(String hostLabel, Inet4Address address, NetworkInterface nif) {
        this.host = hostLabel.toLowerCase(Locale.ROOT);
        this.ip = address.getAddress();
        this.nif = nif;
    }

    public void start() throws IOException {
        MulticastSocket s = new MulticastSocket(null);
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(PORT));
        s.setTimeToLive(255);
        if (nif != null) s.setNetworkInterface(nif);
        s.joinGroup(new InetSocketAddress(InetAddress.getByName(GROUP), PORT), nif);
        s.setSoTimeout(1000);
        socket = s;
        running = true;
        thread = new Thread(this::loop, "mdns");
        thread.setDaemon(true);
        thread.start();
        send(response(host, ip)); // announcement
    }

    public void stop() {
        running = false;
        MulticastSocket s = socket;
        if (s != null) s.close();
    }

    private void loop() {
        byte[] buf = new byte[1500];
        while (running) {
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try {
                socket.receive(p);
            } catch (java.net.SocketTimeoutException e) {
                continue;
            } catch (IOException e) {
                return;
            }
            if (asksForHost(buf, p.getLength(), host)) send(response(host, ip));
        }
    }

    private void send(byte[] data) {
        try {
            socket.send(new DatagramPacket(data, data.length, InetAddress.getByName(GROUP), PORT));
        } catch (IOException ignored) {
            // best effort: the IP address link always works
        }
    }

    /** True if the packet is a standard query with a question for {@code <host>.local} of type A or ANY, class IN. */
    static boolean asksForHost(byte[] pkt, int len, String host) {
        if (len < 12) return false;
        int flags = ((pkt[2] & 0xFF) << 8) | (pkt[3] & 0xFF);
        if ((flags & 0x8000) != 0) return false; // a response, not a query
        if (((flags >> 11) & 0xF) != 0) return false; // not a standard query
        int qd = ((pkt[4] & 0xFF) << 8) | (pkt[5] & 0xFF);
        int pos = 12;
        for (int q = 0; q < qd && q < 16; q++) {
            StringBuilder name = new StringBuilder();
            while (true) {
                if (pos >= len) return false;
                int l = pkt[pos++] & 0xFF;
                if (l == 0) break;
                if ((l & 0xC0) != 0 || pos + l > len || l > 63) return false; // no compression in questions we care about
                if (name.length() > 0) name.append('.');
                name.append(new String(pkt, pos, l, java.nio.charset.StandardCharsets.US_ASCII));
                pos += l;
            }
            if (pos + 4 > len) return false;
            int type = ((pkt[pos] & 0xFF) << 8) | (pkt[pos + 1] & 0xFF);
            int cls = (((pkt[pos + 2] & 0xFF) << 8) | (pkt[pos + 3] & 0xFF)) & 0x7FFF; // top bit = unicast-response request
            pos += 4;
            if (name.toString().toLowerCase(Locale.ROOT).equals(host + ".local") && (type == 1 || type == 255) && cls == 1) return true;
        }
        return false;
    }

    /** An authoritative mDNS response carrying one A record for {@code <host>.local}. */
    static byte[] response(String host, byte[] ipv4) {
        byte[] label = host.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        byte[] local = "local".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        int n = 12 + 1 + label.length + 1 + local.length + 1 + 2 + 2 + 4 + 2 + 4;
        byte[] out = new byte[n];
        out[2] = (byte) 0x84; // QR=1, AA=1
        out[7] = 1; // one answer
        int p = 12;
        out[p++] = (byte) label.length;
        System.arraycopy(label, 0, out, p, label.length);
        p += label.length;
        out[p++] = (byte) local.length;
        System.arraycopy(local, 0, out, p, local.length);
        p += local.length;
        out[p++] = 0;
        out[p++] = 0; // type A
        out[p++] = 1;
        out[p++] = (byte) 0x80; // class IN with the cache-flush bit
        out[p++] = 1;
        out[p++] = 0;
        out[p++] = 0;
        out[p++] = (byte) (TTL_SECONDS >> 8);
        out[p++] = (byte) TTL_SECONDS;
        out[p++] = 0;
        out[p++] = 4;
        System.arraycopy(ipv4, 0, out, p, 4);
        return out;
    }
}
