import { test } from "node:test";
import assert from "node:assert/strict";
import { ledHoldWindow, findScanStart, remapDetectionsToCoordinateMap, type LedDetection } from "./photoAnnotate.js";
import type { CoordinateMap } from "./coordinateMap.js";

test("ledHoldWindow: LED 0's window starts after the post-marker gap", () => {
  const window = ledHoldWindow({ gapMs: 500, holdMs: 250 }, 0);
  assert.deepEqual(window, { startMs: 500, endMs: 750 });
});

test("ledHoldWindow: later LEDs' windows are offset by holdMs each", () => {
  const window = ledHoldWindow({ gapMs: 500, holdMs: 250 }, 3);
  assert.deepEqual(window, { startMs: 500 + 3 * 250, endMs: 500 + 4 * 250 });
});

test("findScanStart: returns the timestamp of the last frame in the first marker run", () => {
  const frames = [
    { timestampMs: 0, isMarker: false }, // footage before the marker starts
    { timestampMs: 100, isMarker: true },
    { timestampMs: 200, isMarker: true },
    { timestampMs: 300, isMarker: true },
    { timestampMs: 400, isMarker: false }, // gap begins -- scan starts gapMs after this
    { timestampMs: 500, isMarker: false },
  ];
  assert.equal(findScanStart(frames), 300);
});

test("findScanStart: returns null when no marker run is present", () => {
  const frames = [
    { timestampMs: 0, isMarker: false },
    { timestampMs: 100, isMarker: false },
  ];
  assert.equal(findScanStart(frames), null);
});

test("findScanStart: ignores a later marker run (the end marker) once the first run has ended", () => {
  const frames = [
    { timestampMs: 0, isMarker: true },
    { timestampMs: 100, isMarker: true },
    { timestampMs: 200, isMarker: false },
    { timestampMs: 300, isMarker: false },
    { timestampMs: 400, isMarker: true }, // end marker -- shouldn't move markerEnd
    { timestampMs: 500, isMarker: true },
  ];
  assert.equal(findScanStart(frames), 100);
});

const baseMap: CoordinateMap = {
  device: "test-device",
  capturedAt: "hand-traced",
  runs: [
    {
      id: "run-a",
      segment: 0,
      startIndex: 0,
      endIndex: 2,
      deviceOffset: 0,
      waypoints: [
        { index: 0, x: 0.1, y: 0.1 },
        { index: 2, x: 0.3, y: 0.3 },
      ],
    },
    {
      id: "run-b",
      segment: 1,
      startIndex: 0,
      endIndex: 1,
      deviceOffset: 3,
      waypoints: [{ index: 0, x: 0.9, y: 0.9 }],
    },
  ],
};

test("remapDetectionsToCoordinateMap: replaces a run's waypoints with confident measured detections", () => {
  const detections: LedDetection[] = [
    { deviceIndex: 0, x: 0.11, y: 0.12, confidence: "ok" },
    { deviceIndex: 1, x: 0.2, y: 0.2, confidence: "weak" }, // not confident enough -- excluded
    { deviceIndex: 2, x: 0.31, y: 0.32, confidence: "ok" },
  ];
  const result = remapDetectionsToCoordinateMap(detections, baseMap);
  const runA = result.runs.find((r) => r.id === "run-a")!;
  assert.deepEqual(runA.waypoints, [
    { index: 0, x: 0.11, y: 0.12 },
    { index: 2, x: 0.31, y: 0.32 },
  ]);
});

test("remapDetectionsToCoordinateMap: a run with no confident detections keeps its original waypoints", () => {
  const detections: LedDetection[] = [
    { deviceIndex: 3, x: 0.5, y: 0.5, confidence: "missing" },
    { deviceIndex: 4, x: 0.5, y: 0.5, confidence: "ambiguous" },
  ];
  const result = remapDetectionsToCoordinateMap(detections, baseMap);
  const runB = result.runs.find((r) => r.id === "run-b")!;
  assert.deepEqual(runB.waypoints, baseMap.runs[1].waypoints);
});

test("remapDetectionsToCoordinateMap: preserves run/segment/index topology untouched", () => {
  const result = remapDetectionsToCoordinateMap([], baseMap);
  assert.equal(result.runs.length, 2);
  for (const [i, run] of result.runs.entries()) {
    assert.equal(run.id, baseMap.runs[i].id);
    assert.equal(run.segment, baseMap.runs[i].segment);
    assert.equal(run.startIndex, baseMap.runs[i].startIndex);
    assert.equal(run.endIndex, baseMap.runs[i].endIndex);
    assert.equal(run.deviceOffset, baseMap.runs[i].deviceOffset);
  }
});
