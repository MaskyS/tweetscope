const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_IDLE_DELAY_MS = 250;
const RETRY_DELAY_MS = 100;
const MAX_DEFER_MS = 2000;

export const EMBED_PRIORITY = {
  USER_INITIATED: 100,
  HOVER: 50,
  FOCUSED: 20,
  ADJACENT: 10,
  FAR: 0,
};

let nextTaskId = 0;

function createAbortError() {
  return new DOMException('Embed task cancelled', 'AbortError');
}

class EmbedScheduler {
  constructor({
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    idleDelayMs = DEFAULT_IDLE_DELAY_MS,
  } = {}) {
    this.maxInFlight = maxInFlight;
    this.idleDelayMs = idleDelayMs;
    this.queue = [];
    this.tasksByKey = new Map();
    this.inFlightCount = 0;
    this.lastActivityAt = Date.now();
    this.pumpTimer = null;
    this.listenersAttached = false;
    this.handleActivity = this.handleActivity.bind(this);
    this.attachActivityListeners();
  }

  attachActivityListeners() {
    if (this.listenersAttached) return;
    if (typeof window === 'undefined') return;
    this.listenersAttached = true;
    const opts = { passive: true, capture: true };
    window.addEventListener('scroll', this.handleActivity, opts);
    window.addEventListener('wheel', this.handleActivity, opts);
    window.addEventListener('touchmove', this.handleActivity, opts);
    window.addEventListener('keydown', this.handleActivity, opts);
  }

  destroy() {
    if (!this.listenersAttached || typeof window === 'undefined') return;
    const opts = { passive: true, capture: true };
    window.removeEventListener('scroll', this.handleActivity, opts);
    window.removeEventListener('wheel', this.handleActivity, opts);
    window.removeEventListener('touchmove', this.handleActivity, opts);
    window.removeEventListener('keydown', this.handleActivity, opts);
    this.listenersAttached = false;
    if (this.pumpTimer !== null) {
      window.clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  handleActivity() {
    this.lastActivityAt = Date.now();
    if (this.queue.length > 0) {
      this.schedulePump(this.idleDelayMs);
    }
  }

  isIdle() {
    return Date.now() - this.lastActivityAt >= this.idleDelayMs;
  }

  schedule(key, run, { canRun = null, priority = 0, allowDuringActivity = false } = {}) {
    const existing = this.tasksByKey.get(key);
    if (existing) {
      // If queued, merge options (higher priority wins, allowDuringActivity ORs)
      if (existing.state === 'queued') {
        existing.priority = Math.max(existing.priority, priority);
        existing.allowDuringActivity = existing.allowDuringActivity || allowDuringActivity;
        if (canRun != null) existing.canRun = canRun;
      }
      // If in-flight, just return existing promise
      return existing.promise;
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const taskId = nextTaskId++;
    let settled = false;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    const task = {
      taskId,
      key,
      run,
      canRun,
      promise,
      resolve: settleResolve,
      reject: settleReject,
      state: 'queued',
      cancelled: false,
      queuedAt: Date.now(),
      priority,
      allowDuringActivity,
    };

    this.tasksByKey.set(key, task);
    this.queue.push(task);
    this.schedulePump(0);
    return promise;
  }

  cancel(key) {
    const task = this.tasksByKey.get(key);
    if (!task) return;

    task.cancelled = true;
    // Always remove from map immediately, regardless of state
    this.tasksByKey.delete(key);

    if (task.state === 'queued') {
      this.queue = this.queue.filter((item) => item.key !== key);
    }
    // Reject for both queued and in-flight (settle guard prevents double-reject)
    task.reject(createAbortError());
  }

  schedulePump(delayMs) {
    if (this.pumpTimer !== null) return;
    this.pumpTimer = window.setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, delayMs);
  }

  pump() {
    if (this.inFlightCount >= this.maxInFlight) return;
    if (this.queue.length === 0) return;

    // Sort by priority desc, then queuedAt asc (stable fairness within same priority)
    this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);

    // Starvation guard: check if oldest queued task has waited too long
    const now = Date.now();
    const oldestQueuedAt = this.queue.reduce(
      (min, t) => (t.queuedAt < min ? t.queuedAt : min),
      Infinity
    );
    const starved = now - oldestQueuedAt >= MAX_DEFER_MS;

    // Check if any queued task has allowDuringActivity
    const hasActivityBypass = this.queue.some(
      (t) => t.allowDuringActivity && !t.cancelled && (typeof t.canRun !== 'function' || t.canRun())
    );

    if (!starved && !hasActivityBypass && !this.isIdle()) {
      this.schedulePump(this.idleDelayMs);
      return;
    }

    let deferredCount = this.queue.length;
    while (this.inFlightCount < this.maxInFlight && this.queue.length > 0 && deferredCount > 0) {
      const task = this.queue.shift();
      if (!task || task.cancelled) {
        if (task) {
          // Map entry already removed by cancel(); just clean up
          if (this.tasksByKey.get(task.key) === task) {
            this.tasksByKey.delete(task.key);
          }
          task.reject(createAbortError());
        }
        deferredCount--;
        continue;
      }

      // If not idle and this task doesn't bypass activity gate, re-queue it
      if (!this.isIdle() && !starved && !task.allowDuringActivity) {
        this.queue.push(task);
        deferredCount--;
        continue;
      }

      if (typeof task.canRun === 'function' && !task.canRun()) {
        this.queue.push(task);
        deferredCount--;
        continue;
      }

      this.startTask(task);
      deferredCount = this.queue.length;
    }

    if (this.queue.length > 0 && this.inFlightCount < this.maxInFlight) {
      this.schedulePump(RETRY_DELAY_MS);
    }
  }

  startTask(task) {
    task.state = 'in_flight';
    this.inFlightCount += 1;

    Promise.resolve()
      .then(() => task.run())
      .then((value) => {
        if (!task.cancelled) {
          task.resolve(value);
        }
      })
      .catch((error) => {
        if (!task.cancelled) {
          task.reject(error);
        }
      })
      .finally(() => {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        // Only delete if this task is still the current entry for this key
        // (prevents deleting a newer rescheduled task with the same key)
        if (this.tasksByKey.get(task.key) === task) {
          this.tasksByKey.delete(task.key);
        }
        if (this.queue.length > 0) {
          this.schedulePump(0);
        }
      });
  }
}

export const embedScheduler = new EmbedScheduler();
