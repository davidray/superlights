import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSceneFromSpec } from "./sceneSpec.js";
import type { LedContext } from "./scenes.js";

function ctxAt(x: number, deviceIndex = 0): LedContext {
  return { run: "r", segment: 0, index: deviceIndex, deviceIndex, x, y: 0.5 };
}

test("solid pattern ignores position and time", () => {
  const scene = buildSceneFromSpec({ palette: [[10, 20, 30]], pattern: "solid" });
  assert.deepEqual(scene.render(ctxAt(0), 0), [10, 20, 30]);
  assert.deepEqual(scene.render(ctxAt(0.9), 50), [10, 20, 30]);
});

test("gradientDrift wraps back to the same color at x=1 as x=0", () => {
  const scene = buildSceneFromSpec({ palette: [[0, 0, 0], [255, 255, 255]], pattern: "gradientDrift" });
  assert.deepEqual(scene.render(ctxAt(0), 0), scene.render(ctxAt(1), 0));
});

test("chase produces hard-edged discrete bands, not a blend", () => {
  const scene = buildSceneFromSpec({ palette: [[255, 0, 0], [0, 0, 255]], pattern: "chase", bandWidth: 0.5 });
  assert.deepEqual(scene.render(ctxAt(0.1), 0), [255, 0, 0]);
  assert.deepEqual(scene.render(ctxAt(0.6), 0), [0, 0, 255]);
});

test("twinkle only ever returns the dim floor or a full-brightness palette color", () => {
  const scene = buildSceneFromSpec({ palette: [[255, 215, 90]], pattern: "twinkle", sparkleDensity: 0.3, brightnessMin: 0.05 });
  for (let i = 0; i < 20; i++) {
    const color = scene.render(ctxAt(0, i), 0);
    const sum = color[0] + color[1] + color[2];
    const isFloor = sum < 100;
    const isLit = color[0] === 255 && color[1] === 215 && color[2] === 90;
    assert.ok(isFloor || isLit, `unexpected color ${color} at deviceIndex ${i}`);
  }
});

test("pulse brightness stays within the configured min/max range", () => {
  const scene = buildSceneFromSpec({ palette: [[100, 100, 100]], pattern: "pulse", brightnessMin: 0.2, brightnessMax: 0.8 });
  for (let t = 0; t <= 10; t += 0.5) {
    const [r] = scene.render(ctxAt(0.5), t);
    assert.ok(r >= 19 && r <= 81, `brightness out of range at t=${t}: ${r}`);
  }
});

test("buildSceneFromSpec rejects an empty palette", () => {
  assert.throws(() => buildSceneFromSpec({ palette: [], pattern: "solid" }));
});
