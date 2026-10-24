package app.smartrearview.rearcam.server;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Per-remote-IP limits (docs/PROTOCOL_SPEC.md §13): 5 failed authentications in 60 s lock the IP out for 60 s; at most 10
 * connection attempts per IP per minute. State is bounded (at most MAX_IPS tracked addresses). Time is passed in.
 */
public final class AuthGuard {
    static final int MAX_FAILURES = 5;
    static final long FAIL_WINDOW_MS = 60_000;
    static final long LOCKOUT_MS = 60_000;
    static final int MAX_CONNECTS = 10;
    static final long CONNECT_WINDOW_MS = 60_000;
    static final int MAX_IPS = 256;

    private final Map<String, ArrayDeque<Long>> failures = new HashMap<>();
    private final Map<String, ArrayDeque<Long>> connects = new HashMap<>();
    private final Map<String, Long> lockedUntil = new HashMap<>();

    public synchronized boolean isLockedOut(String ip, long nowMs) {
        Long until = lockedUntil.get(ip);
        if (until == null) return false;
        if (nowMs >= until) {
            lockedUntil.remove(ip);
            return false;
        }
        return true;
    }

    /** Counts a connection attempt; false means the attempt exceeds the per-minute limit. */
    public synchronized boolean allowConnect(String ip, long nowMs) {
        ArrayDeque<Long> q = prune(connects, ip, nowMs, CONNECT_WINDOW_MS);
        if (q.size() >= MAX_CONNECTS) return false;
        q.add(nowMs);
        return true;
    }

    /** Records a failed authentication; returns true if the IP is now locked out. */
    public synchronized boolean recordFailure(String ip, long nowMs) {
        ArrayDeque<Long> q = prune(failures, ip, nowMs, FAIL_WINDOW_MS);
        q.add(nowMs);
        if (q.size() >= MAX_FAILURES) {
            lockedUntil.put(ip, nowMs + LOCKOUT_MS);
            q.clear();
            return true;
        }
        return false;
    }

    private ArrayDeque<Long> prune(Map<String, ArrayDeque<Long>> map, String ip, long nowMs, long windowMs) {
        if (!map.containsKey(ip) && map.size() >= MAX_IPS) evict(map, nowMs, windowMs);
        ArrayDeque<Long> q = map.get(ip);
        if (q == null) {
            q = new ArrayDeque<>();
            map.put(ip, q);
        }
        while (!q.isEmpty() && nowMs - q.peekFirst() >= windowMs) q.pollFirst();
        return q;
    }

    private void evict(Map<String, ArrayDeque<Long>> map, long nowMs, long windowMs) {
        Iterator<Map.Entry<String, ArrayDeque<Long>>> it = map.entrySet().iterator();
        while (it.hasNext()) {
            ArrayDeque<Long> q = it.next().getValue();
            if (q.isEmpty() || nowMs - q.peekLast() >= windowMs) it.remove();
        }
        if (map.size() >= MAX_IPS) map.clear(); // bounded: forget everything rather than grow
        Iterator<Map.Entry<String, Long>> li = lockedUntil.entrySet().iterator();
        while (li.hasNext()) if (nowMs >= li.next().getValue()) li.remove();
    }
}
