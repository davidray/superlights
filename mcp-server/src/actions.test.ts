import { test } from "node:test";
import assert from "node:assert/strict";
import { setBrightness, applyPreset, runEffect } from "./actions.js";

// Issue #5: these bounds mirror index.ts's zod schemas for set_brightness/apply_preset/
// set_effect, so triggerServer.ts's HTTP handlers (which call these functions directly
// from raw JSON, bypassing that zod validation) can't push out-of-range values through
// to a real device. All of these throw before any network call to the device, so no
// device/network needs to be configured for the test to run.

test("setBrightness rejects out-of-range values", async () => {
  await assert.rejects(() => setBrightness("eaves", 0), /brightness/);
  await assert.rejects(() => setBrightness("eaves", 256), /brightness/);
  await assert.rejects(() => setBrightness("eaves", 12.5), /brightness/);
});

test("applyPreset rejects an out-of-range slot", async () => {
  await assert.rejects(() => applyPreset("eaves", 0), /preset slot/);
  await assert.rejects(() => applyPreset("eaves", 251), /preset slot/);
});

test("runEffect rejects out-of-range speed/intensity", async () => {
  await assert.rejects(() => runEffect("eaves", "Solid", { speed: 300 }), /speed/);
  await assert.rejects(() => runEffect("eaves", "Solid", { intensity: -1 }), /intensity/);
});

test("runEffect rejects a malformed hex color", async () => {
  await assert.rejects(() => runEffect("eaves", "Solid", { colors: ["not-a-color"] }), /color/);
});

test("runEffect rejects a negative segment id", async () => {
  await assert.rejects(() => runEffect("eaves", "Solid", { segment: -1 }), /segment/);
});
