import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, hasDrifted, type SchedulerIo } from "./scheduler.js";
import type { ActiveRule } from "./holidaySchedule.js";

// The scheduler used to fire only on transitions: once it had powered a device off
// for the night it never looked at it again until the next rule change. A device
// that rebooted and came up lit (WLED's power-on default) stayed on all night. It
// now re-asserts the applied state whenever the device disagrees.

const rule: ActiveRule = { source: "default", id: "default:eaves", name: "Default", onTime: "18:00", offTime: "22:15", device: "eaves", scene: "roofline-sparkle" };

function fakeIo(opts: { rules?: ActiveRule[]; poweredOn?: boolean | Error; streaming?: boolean } = {}) {
  const calls: string[] = [];
  const io: SchedulerIo = {
    rulesFor: () => opts.rules ?? [rule],
    applyOn: async (device) => { calls.push(`on:${device}`); },
    applyOff: async (device) => { calls.push(`off:${device}`); },
    isPoweredOn: async () => {
      if (opts.poweredOn instanceof Error) throw opts.poweredOn;
      return opts.poweredOn ?? false;
    },
    isStreaming: () => opts.streaming ?? false,
    log: () => {},
  };
  return { io, calls };
}

const night = new Date(2026, 8, 25, 4, 25); // 04:25 -- inside the off period
const evening = new Date(2026, 8, 25, 20, 0); // 20:00 -- inside the on period

test("hasDrifted: off period drifts only when the device is on", () => {
  assert.equal(hasDrifted(false, false, false), false);
  assert.equal(hasDrifted(false, true, false), true);
});

test("hasDrifted: on period drifts when the device is off or the stream is gone", () => {
  assert.equal(hasDrifted(true, true, true), false);
  assert.equal(hasDrifted(true, false, true), true);
  assert.equal(hasDrifted(true, true, false), true);
});

test("first tick applies the transition without probing the device", async () => {
  const { io, calls } = fakeIo({ poweredOn: new Error("unreachable") });
  const applied = new Map();
  await reconcile(night, io, applied);
  assert.deepEqual(calls, ["off:eaves"]);
  assert.deepEqual(applied.get("eaves"), { ruleId: rule.id, on: false });
});

test("a device that matches the applied state is left alone", async () => {
  const { io, calls } = fakeIo({ poweredOn: false });
  const applied = new Map([["eaves", { ruleId: rule.id, on: false }]]);
  await reconcile(night, io, applied);
  assert.deepEqual(calls, []);
});

test("a device found on during the off period is powered off again", async () => {
  const { io, calls } = fakeIo({ poweredOn: true });
  const applied = new Map([["eaves", { ruleId: rule.id, on: false }]]);
  await reconcile(night, io, applied);
  assert.deepEqual(calls, ["off:eaves"]);
});

test("a device found off during the on period gets its scene restarted", async () => {
  const { io, calls } = fakeIo({ poweredOn: false, streaming: true });
  const applied = new Map([["eaves", { ruleId: rule.id, on: true }]]);
  await reconcile(evening, io, applied);
  assert.deepEqual(calls, ["on:eaves"]);
});

test("a lost stream during the on period is restarted even if the device is on", async () => {
  const { io, calls } = fakeIo({ poweredOn: true, streaming: false });
  const applied = new Map([["eaves", { ruleId: rule.id, on: true }]]);
  await reconcile(evening, io, applied);
  assert.deepEqual(calls, ["on:eaves"]);
});

test("an unreachable device is skipped, not re-commanded, and stays recorded", async () => {
  const { io, calls } = fakeIo({ poweredOn: new Error("ECONNREFUSED") });
  const applied = new Map([["eaves", { ruleId: rule.id, on: false }]]);
  await reconcile(night, io, applied);
  assert.deepEqual(calls, []);
  assert.deepEqual(applied.get("eaves"), { ruleId: rule.id, on: false });
});

test("a device whose rule disappeared is powered off once and forgotten", async () => {
  const { io, calls } = fakeIo({ rules: [] });
  const applied = new Map([["eaves", { ruleId: rule.id, on: true }]]);
  await reconcile(evening, io, applied);
  assert.deepEqual(calls, ["off:eaves"]);
  assert.equal(applied.has("eaves"), false);
});
