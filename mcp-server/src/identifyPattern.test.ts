import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentifyFrames } from "./identifyPattern.js";

// fps=10 with every phase at 100ms makes each phase exactly 1 frame, so frame indices
// map directly to phases -- easy to reason about by hand.
const OPTS = { holdMs: 100, startMarkerMs: 100, endMarkerMs: 100, gapMs: 100, fps: 10 };

test("buildIdentifyFrames produces the expected frame count and duration", () => {
  const { frames, timing } = buildIdentifyFrames(3, "test-device", OPTS);
  // start marker (1) + gap (1) + one frame per LED (3) + gap (1) + end marker (1) = 7
  assert.equal(frames.length, 7);
  assert.equal(timing.ledCount, 3);
  assert.equal(timing.totalDurationSeconds, 7 / 10);
});

test("start/end markers are solid white, gaps are solid black", () => {
  const { frames } = buildIdentifyFrames(3, "test-device", OPTS);
  const white = [
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
  ];
  const black = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  assert.deepEqual(frames[0], white); // start marker
  assert.deepEqual(frames[1], black); // gap after start marker
  assert.deepEqual(frames[5], black); // gap before end marker
  assert.deepEqual(frames[6], white); // end marker
});

test("each per-LED frame lights exactly one LED at the expected deviceIndex", () => {
  const { frames } = buildIdentifyFrames(3, "test-device", OPTS);
  for (let i = 0; i < 3; i++) {
    const frame = frames[2 + i];
    for (let j = 0; j < 3; j++) {
      assert.deepEqual(frame[j], j === i ? [255, 255, 255] : [0, 0, 0]);
    }
  }
});

test("holdMs longer than one frame interval repeats the same per-LED frame", () => {
  const { frames, timing } = buildIdentifyFrames(2, "test-device", { ...OPTS, holdMs: 300 });
  // holdFrames = round(300/1000*10) = 3 frames per LED
  assert.equal(timing.totalDurationSeconds, (1 + 1 + 3 * 2 + 1 + 1) / 10);
  for (let i = 2; i < 5; i++) assert.deepEqual(frames[i][0], [255, 255, 255]);
  for (let i = 5; i < 8; i++) assert.deepEqual(frames[i][1], [255, 255, 255]);
});

test("rejects a non-positive ledCount", () => {
  assert.throws(() => buildIdentifyFrames(0, "test-device", OPTS), /ledCount must be a positive integer/);
});

test("rejects a non-positive holdMs", () => {
  assert.throws(() => buildIdentifyFrames(3, "test-device", { ...OPTS, holdMs: 0 }), /holdMs must be a positive number/);
});

test("rejects an out-of-range fps", () => {
  assert.throws(() => buildIdentifyFrames(3, "test-device", { ...OPTS, fps: 100 }), /fps must be an integer between 1 and 60/);
});
