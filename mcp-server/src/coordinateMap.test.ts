import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCoordinateMap, saveCoordinateMap, type CoordinateMap } from "./coordinateMap.js";

// Issue #3: the device name is reachable from a decoded URL path segment in
// triggerServer.ts's /calibration/<device> route, so it needs to be validated at the
// point it's first accepted here -- regardless of caller. All of these throw before any
// filesystem access, so they're safe to run without touching the calibration directory.

test("loadCoordinateMap rejects a device name containing '..'", () => {
  assert.throws(() => loadCoordinateMap("../../etc/passwd"), /Invalid device name/);
});

test("loadCoordinateMap rejects a device name containing a forward slash", () => {
  assert.throws(() => loadCoordinateMap("sub/dir"), /Invalid device name/);
});

test("loadCoordinateMap rejects a device name containing a backslash", () => {
  assert.throws(() => loadCoordinateMap("sub\\dir"), /Invalid device name/);
});

test("saveCoordinateMap rejects a path-traversing device name before writing anything", () => {
  const map: CoordinateMap = { device: "x", capturedAt: "test", runs: [{ id: "r", segment: 0, startIndex: 0, endIndex: 0, deviceOffset: 0, waypoints: [{ index: 0, x: 0, y: 0 }] }] };
  assert.throws(() => saveCoordinateMap("../escape", map), /Invalid device name/);
});

// Issue #5: saveCoordinateMap is also called directly from triggerServer.ts's HTTP
// route with a raw JSON body, bypassing index.ts's set_calibration zod schema -- so it
// needs to enforce the same shape itself (non-empty runs/waypoints, x/y in 0-1).

test("saveCoordinateMap rejects a map with no runs", () => {
  const map = { device: "x", capturedAt: "test", runs: [] } as unknown as CoordinateMap;
  assert.throws(() => saveCoordinateMap("valid-device-name", map), /at least one run/);
});

test("saveCoordinateMap rejects a run with no waypoints", () => {
  const map: CoordinateMap = { device: "x", capturedAt: "test", runs: [{ id: "r", segment: 0, startIndex: 0, endIndex: 0, deviceOffset: 0, waypoints: [] }] };
  assert.throws(() => saveCoordinateMap("valid-device-name", map), /at least one waypoint/);
});

test("saveCoordinateMap rejects a waypoint with x/y outside 0-1", () => {
  const map: CoordinateMap = {
    device: "x",
    capturedAt: "test",
    runs: [{ id: "r", segment: 0, startIndex: 0, endIndex: 0, deviceOffset: 0, waypoints: [{ index: 0, x: 1.5, y: 0.5 }] }],
  };
  assert.throws(() => saveCoordinateMap("valid-device-name", map), /0-1 range/);
});
