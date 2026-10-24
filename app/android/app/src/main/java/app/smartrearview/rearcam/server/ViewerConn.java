package app.smartrearview.rearcam.server;

import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.ArrayList;

/**
 * One authenticated viewer. All writes to the socket happen on this connection's writer thread, so a slow viewer can block only
 * itself. Memory is bounded: one unsent frame (newest wins), at most MAX_TEXTS queued text messages, at most ackCredit
 * unacknowledged frames in flight (docs/PROTOCOL_SPEC.md §8).
 */
final class ViewerConn {
    static final int MAX_TEXTS = 8;
    static final long ACK_TIMEOUT_MS = 5000;

    interface Listener {
        void onClosed(ViewerConn c);
    }

    final String remoteIp;
    private final Socket socket;
    private final OutputStream out;
    private final int ackCredit;
    private final Listener listener;
    private final Object lock = new Object();
    private byte[] slotFrame;
    private long slotSeq;
    private final ArrayList<Long> outstanding = new ArrayList<>();
    private final ArrayDeque<byte[]> texts = new ArrayDeque<>();
    private long progressAtMs;
    private int closeCode = -1;
    private String closeReason = "";
    private long closeRequestedAtMs;
    private boolean finished;
    private boolean closeSent;
    private volatile long lastActivityMs = System.nanoTime() / 1_000_000L;
    private long replaced;
    private long sent;

    ViewerConn(Socket socket, OutputStream out, String remoteIp, int ackCredit, Listener listener) {
        this.socket = socket;
        this.out = out;
        this.remoteIp = remoteIp;
        this.ackCredit = ackCredit;
        this.listener = listener;
    }

    /** Called by the reader thread for every message from the viewer. */
    void touch(long nowMs) {
        lastActivityMs = nowMs;
    }

    long idleMs(long nowMs) {
        return nowMs - lastActivityMs;
    }

    void start() {
        Thread t = new Thread(this::writeLoop, "viewer-writer");
        t.setDaemon(true);
        t.start();
    }

    /** Newest frame replaces an unsent older one. */
    void offerFrame(byte[] frame, long seq, long nowMs) {
        synchronized (lock) {
            if (closeCode >= 0) return;
            if (slotFrame != null) replaced++;
            slotFrame = frame;
            slotSeq = seq;
            lock.notifyAll();
        }
    }

    void sendText(byte[] json) {
        synchronized (lock) {
            if (closeCode >= 0) return;
            if (texts.size() >= MAX_TEXTS) texts.pollFirst();
            texts.addLast(json);
            lock.notifyAll();
        }
    }

    void ack(long seq, long nowMs) {
        synchronized (lock) {
            int before = outstanding.size();
            for (int i = outstanding.size() - 1; i >= 0; i--) if (outstanding.get(i) <= seq) outstanding.remove(i);
            if (outstanding.size() < before) progressAtMs = nowMs;
            lock.notifyAll();
        }
    }

    boolean isStalled(long nowMs) {
        synchronized (lock) {
            return !outstanding.isEmpty() && nowMs - progressAtMs > ACK_TIMEOUT_MS;
        }
    }

    /** Queued texts are flushed first, then a close frame is sent and the socket is closed. */
    void close(int code, String reason, long nowMs) {
        synchronized (lock) {
            if (closeCode >= 0) return;
            closeCode = code;
            closeReason = reason;
            closeRequestedAtMs = nowMs;
            slotFrame = null;
            lock.notifyAll();
        }
    }

    /** True if a close was requested long ago but the writer is stuck in a blocked write: the caller should kill the socket. */
    boolean closeOverdue(long nowMs) {
        synchronized (lock) {
            return closeCode >= 0 && !finished && nowMs - closeRequestedAtMs > 1500;
        }
    }

    /** Waits until the close frame has been written (or the writer ended), up to timeoutMs. */
    void awaitCloseSent(long timeoutMs) {
        long end = System.nanoTime() + timeoutMs * 1_000_000L;
        synchronized (lock) {
            while (!closeSent && !finished) {
                long left = (end - System.nanoTime()) / 1_000_000L;
                if (left <= 0) return;
                try {
                    lock.wait(left);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    void kill() {
        try {
            socket.close();
        } catch (IOException ignored) {
            // already closed
        }
    }

    long replacedCount() {
        synchronized (lock) {
            return replaced;
        }
    }

    long sentCount() {
        synchronized (lock) {
            return sent;
        }
    }

    int unacked() {
        synchronized (lock) {
            return outstanding.size();
        }
    }

    private void writeLoop() {
        try {
            while (true) {
                byte[] text = null;
                byte[] frame = null;
                int code = -1;
                String reason = "";
                synchronized (lock) {
                    while (true) {
                        if (!texts.isEmpty()) {
                            text = texts.pollFirst();
                            break;
                        }
                        if (closeCode >= 0) {
                            code = closeCode;
                            reason = closeReason;
                            break;
                        }
                        if (slotFrame != null && outstanding.size() < ackCredit) {
                            frame = slotFrame;
                            slotFrame = null;
                            if (outstanding.isEmpty()) progressAtMs = System.nanoTime() / 1_000_000L;
                            outstanding.add(slotSeq);
                            sent++;
                            break;
                        }
                        lock.wait();
                    }
                }
                if (text != null) {
                    WebSocketProtocol.writeServerFrame(out, WebSocketProtocol.OP_TEXT, text);
                } else if (frame != null) {
                    WebSocketProtocol.writeServerFrame(out, WebSocketProtocol.OP_BINARY, frame);
                } else {
                    WebSocketProtocol.writeServerFrame(out, WebSocketProtocol.OP_CLOSE, WebSocketProtocol.closePayload(code, reason));
                    synchronized (lock) {
                        closeSent = true;
                        lock.notifyAll();
                    }
                    // Half-close and give the peer a moment to read the close frame and answer; the reader thread then closes.
                    try {
                        socket.shutdownOutput();
                    } catch (IOException ignored) {
                        // already closed
                    }
                    Thread.sleep(1000);
                    break;
                }
            }
        } catch (IOException | InterruptedException e) {
            // peer gone or killed
        } finally {
            synchronized (lock) {
                finished = true;
                lock.notifyAll();
            }
            kill();
            listener.onClosed(this);
        }
    }
}
