import assert from "node:assert/strict";
import { test } from "node:test";
import { createUpdateCheckScheduler, type UpdateCheckSchedulerClock } from "../../../src/main/update-check-scheduler.js";

class FakeClock implements UpdateCheckSchedulerClock {
  time = 0; sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = ++this.sequence; this.timers.set(id, { at: this.time + milliseconds, callback }); return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      this.timers.delete(next[0]); next[1].callback();
    }
  }
}
const turn = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

test("automatic checks run at startup/hourly, skip disabled updates, and resume without overlap", async () => {
  const clock = new FakeClock(); let enabled = true, calls = 0, release!: () => void;
  const pending = new Promise<void>((accept) => { release = accept; });
  const scheduler = createUpdateCheckScheduler({ clock, startupDelayMs: 10, intervalMs: 100, resumeCooldownMs: 50,
    allowed: () => enabled, check: async () => { calls++; if (calls === 1) await pending; } });
  scheduler.start(); scheduler.start(); clock.advance(9); await turn(); assert.equal(calls, 0);
  clock.advance(1); await turn(); assert.equal(calls, 1);
  scheduler.resume(); clock.advance(50); await turn(); assert.equal(calls, 1);
  release(); await turn();
  scheduler.resume(); await turn(); assert.equal(calls, 2);
  enabled = false; clock.advance(100); await turn(); assert.equal(calls, 2);
  enabled = true; clock.advance(50); scheduler.resume(); await turn(); assert.equal(calls, 3);
  scheduler.close(); clock.advance(500); await turn(); assert.equal(calls, 3);
});

test("disabled startup and a temporary busy/failed state do not suppress the next hourly discovery", async () => {
  const clock = new FakeClock(); let enabled = false, busy = false, calls = 0;
  const scheduler = createUpdateCheckScheduler({ clock, startupDelayMs: 10, intervalMs: 100,
    allowed: () => enabled && !busy, check: async () => { calls++; if (calls === 1) throw new Error("synthetic feed refusal"); } });
  scheduler.start(); clock.advance(10); await turn(); assert.equal(calls, 0);
  enabled = true; busy = true; clock.advance(100); await turn(); assert.equal(calls, 0);
  busy = false; clock.advance(100); await turn(); assert.equal(calls, 1);
  clock.advance(100); await turn(); assert.equal(calls, 2);
  scheduler.close();
  assert.throws(() => createUpdateCheckScheduler({ check: async () => {}, allowed: () => true, intervalMs: 0 }), RangeError);
});
