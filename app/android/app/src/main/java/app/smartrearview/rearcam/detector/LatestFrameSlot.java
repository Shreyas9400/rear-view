package app.smartrearview.rearcam.detector;

/**
 * A one-slot mailbox with "newest wins" semantics: the producer never blocks and never queues; a newer item replaces an
 * older one that the consumer has not taken yet (docs/ARCHITECTURE.md latest-frame-wins, D-006). The consumer blocks in
 * take() until something is available or the slot is closed. Pure Java, so it runs in plain JVM unit tests.
 */
public final class LatestFrameSlot<T> {
    private final Object lock = new Object();
    private T item;
    private boolean closed;
    private long offered;
    private long replaced;

    /** Store the newest item. Returns true if it replaced an older item nobody had taken (that item is dropped). */
    public boolean offer(T t) {
        if (t == null) throw new IllegalArgumentException("item must not be null");
        synchronized (lock) {
            if (closed) throw new IllegalStateException("slot is closed");
            boolean drop = item != null;
            item = t;
            offered++;
            if (drop) replaced++;
            lock.notifyAll();
            return drop;
        }
    }

    /** Block until an item is available (and return it, emptying the slot) or the slot is closed (return null). */
    public T take() throws InterruptedException {
        synchronized (lock) {
            while (item == null && !closed) lock.wait();
            if (item == null) return null; // closed and empty
            T t = item;
            item = null;
            return t;
        }
    }

    /** Wake the consumer and refuse further offers. A pending item is discarded: the stream is being stopped. */
    public void close() {
        synchronized (lock) {
            closed = true;
            item = null;
            lock.notifyAll();
        }
    }

    public long offeredCount() {
        synchronized (lock) {
            return offered;
        }
    }

    public long replacedCount() {
        synchronized (lock) {
            return replaced;
        }
    }
}
