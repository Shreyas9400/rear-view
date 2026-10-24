package app.smartrearview.rearcam.detector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class LatestFrameSlotTest {
    @Test
    public void newestItemReplacesAnUntakenOne() throws Exception {
        LatestFrameSlot<Integer> s = new LatestFrameSlot<>();
        assertFalse(s.offer(1));
        assertTrue(s.offer(2));
        assertTrue(s.offer(3));
        assertEquals(Integer.valueOf(3), s.take());
        assertEquals(3, s.offeredCount());
        assertEquals(2, s.replacedCount());
    }

    @Test
    public void takingEmptiesTheSlotSoTheNextOfferIsNotAReplacement() throws Exception {
        LatestFrameSlot<String> s = new LatestFrameSlot<>();
        s.offer("a");
        assertEquals("a", s.take());
        assertFalse(s.offer("b"));
        assertEquals("b", s.take());
        assertEquals(0, s.replacedCount());
    }

    @Test
    public void takeBlocksUntilAnItemArrives() throws Exception {
        final LatestFrameSlot<Integer> s = new LatestFrameSlot<>();
        final AtomicReference<Integer> got = new AtomicReference<>();
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch done = new CountDownLatch(1);
        Thread t = new Thread(() -> {
            try {
                started.countDown();
                got.set(s.take());
            } catch (InterruptedException e) {
                got.set(-1);
            }
            done.countDown();
        });
        t.start();
        assertTrue(started.await(2, TimeUnit.SECONDS));
        assertFalse("must still be waiting", done.await(150, TimeUnit.MILLISECONDS));
        s.offer(42);
        assertTrue(done.await(2, TimeUnit.SECONDS));
        assertEquals(Integer.valueOf(42), got.get());
    }

    @Test
    public void closeWakesAWaitingConsumerWithNullAndRefusesOffers() throws Exception {
        final LatestFrameSlot<Integer> s = new LatestFrameSlot<>();
        final AtomicReference<Object> got = new AtomicReference<>("unset");
        final CountDownLatch done = new CountDownLatch(1);
        Thread t = new Thread(() -> {
            try {
                got.set(s.take());
            } catch (InterruptedException e) {
                got.set("interrupted");
            }
            done.countDown();
        });
        t.start();
        Thread.sleep(100);
        s.close();
        assertTrue(done.await(2, TimeUnit.SECONDS));
        assertNull(got.get());
        try {
            s.offer(1);
            fail("expected IllegalStateException");
        } catch (IllegalStateException expected) {
            // ok
        }
    }

    @Test
    public void closeDiscardsAPendingItem() throws Exception {
        LatestFrameSlot<Integer> s = new LatestFrameSlot<>();
        s.offer(7);
        s.close();
        assertNull(s.take());
    }

    @Test
    public void rejectsNull() {
        try {
            new LatestFrameSlot<String>().offer(null);
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
    }

    @Test
    public void aFastProducerAndASlowConsumerNeverQueue() throws Exception {
        final LatestFrameSlot<Integer> s = new LatestFrameSlot<>();
        final List<Integer> seen = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch finished = new CountDownLatch(1);
        Thread consumer = new Thread(() -> {
            try {
                Integer v;
                while ((v = s.take()) != null) {
                    seen.add(v);
                    Thread.sleep(5); // slow consumer
                    if (v == 999) break;
                }
            } catch (InterruptedException ignored) {
                // test ends
            }
            finished.countDown();
        });
        consumer.start();
        for (int i = 0; i < 1000; i++) {
            s.offer(i);
            if (i % 50 == 0) Thread.sleep(1);
        }
        assertTrue(finished.await(5, TimeUnit.SECONDS));
        // the newest item always gets through, order is increasing, and far fewer items were processed than offered
        assertEquals(Integer.valueOf(999), seen.get(seen.size() - 1));
        for (int i = 1; i < seen.size(); i++) assertTrue(seen.get(i) > seen.get(i - 1));
        assertTrue("consumer saw " + seen.size(), seen.size() < 1000);
        assertEquals(1000, s.offeredCount());
        assertEquals(1000 - seen.size(), s.replacedCount());
    }
}
