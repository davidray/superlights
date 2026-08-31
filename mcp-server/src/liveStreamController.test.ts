import { test } from "node:test";
import assert from "node:assert/strict";
import { isStreamOverdue } from "./liveStreamController.js";

// Regression coverage for the watchdog backstop: a duration-bound stream whose
// primary stopTimeout somehow never fires (a process hiccup, etc.) should eventually
// get force-stopped, but only after a grace period -- not on every tick where it's
// merely still running its configured duration.

test("a stream with no expectedStopAt (open-ended, no duration given) is never overdue", () => {
  assert.equal(isStreamOverdue(undefined, Date.now() + 999_999_999), false);
});

test("a stream well within its configured duration is not overdue", () => {
  const now = 1_000_000;
  const expectedStopAt = now + 60_000; // stops a minute from now
  assert.equal(isStreamOverdue(expectedStopAt, now), false);
});

test("a stream just past its expected stop time, but still within grace, is not overdue", () => {
  const now = 1_000_000;
  const expectedStopAt = now - 10_000; // 10s overdue
  assert.equal(isStreamOverdue(expectedStopAt, now, 30_000), false);
});

test("a stream past its expected stop time plus grace is overdue", () => {
  const now = 1_000_000;
  const expectedStopAt = now - 31_000; // 31s overdue, grace is 30s
  assert.equal(isStreamOverdue(expectedStopAt, now, 30_000), true);
});

test("exactly at the grace boundary is not yet overdue", () => {
  const now = 1_000_000;
  const expectedStopAt = now - 30_000;
  assert.equal(isStreamOverdue(expectedStopAt, now, 30_000), false);
});
