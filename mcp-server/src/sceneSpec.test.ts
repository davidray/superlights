import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSceneFromSpec } from "./sceneSpec.js";
import type { LedContext } from "./scenes.js";

function ctxAt(x: number, deviceIndex = 0, y = 0.5): LedContext {
  return { run: "r", segment: 0, index: deviceIndex, deviceIndex, x, y };
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

test("fireworks eventually lights up somewhere and stays within valid RGB bounds", () => {
  const scene = buildSceneFromSpec({ palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255]], pattern: "fireworks" });
  let sawLight = false;
  for (let t = 0; t < 5; t += 0.1) {
    for (let x = 0; x <= 1; x += 0.2) {
      for (let y = 0; y <= 0.6; y += 0.2) {
        const color = scene.render(ctxAt(x, 0, y), t);
        if (color[0] || color[1] || color[2]) sawLight = true;
        for (const c of color) assert.ok(c >= 0 && c <= 255, `channel out of range: ${color}`);
      }
    }
  }
  assert.ok(sawLight, "expected at least one burst to light up across the sampled grid");
});

test("comet: brightness peaks exactly at the head and fades going backward", () => {
  const scene = buildSceneFromSpec({ palette: [[255, 120, 0]], pattern: "comet" });
  // At t=0 the comet's head is at x=0.
  assert.deepEqual(scene.render(ctxAt(0), 0), [255, 120, 0]);
  const farBehind = scene.render(ctxAt(0.5), 0);
  assert.ok(farBehind[0] + farBehind[1] + farBehind[2] < 30, `expected far-behind LED to be near-dark, got ${farBehind}`);
});

test("rain: LEDs below the falling drop's head stay dark", () => {
  const scene = buildSceneFromSpec({ palette: [[0, 120, 255]], pattern: "rain" });
  const t = 3.7;
  let maxSum = 0;
  let yAtMax = 0;
  const samples: { y: number; sum: number }[] = [];
  for (let y = 0; y <= 1; y += 0.02) {
    const color = scene.render(ctxAt(0.5, 0, y), t);
    const sum = color[0] + color[1] + color[2];
    samples.push({ y, sum });
    if (sum > maxSum) {
      maxSum = sum;
      yAtMax = y;
    }
  }
  assert.ok(maxSum > 100, "expected the drop's head to be clearly lit somewhere");
  for (const s of samples) {
    if (s.y > yAtMax + 0.05) assert.equal(s.sum, 0, `expected dark below the drop's head at y=${s.y}, got sum=${s.sum}`);
  }
});

test("bounce: a single ball sweeps across the full range each period, not stuck in place", () => {
  const scene = buildSceneFromSpec({ palette: [[255, 255, 255]], pattern: "bounce" });
  let maxSum = 0;
  let minSum = 255 * 3;
  for (let t = 0; t <= 2; t += 0.02) {
    const color = scene.render(ctxAt(0), t);
    const sum = color[0] + color[1] + color[2];
    maxSum = Math.max(maxSum, sum);
    minSum = Math.min(minSum, sum);
  }
  assert.ok(maxSum > 700, `expected the ball to pass near x=0 at some point, max brightness sum was ${maxSum}`);
  assert.ok(minSum < 50, `expected the ball to be far from x=0 at some point, min brightness sum was ${minSum}`);
});

test("aurora brightness stays within the configured shimmer range", () => {
  const scene = buildSceneFromSpec({ palette: [[200, 200, 200]], pattern: "aurora", brightnessMin: 0.3, brightnessMax: 0.9 });
  for (let t = 0; t <= 10; t += 0.7) {
    for (let x = 0; x <= 1; x += 0.25) {
      const [r] = scene.render(ctxAt(x), t);
      const ratio = r / 200;
      assert.ok(ratio >= 0.29 && ratio <= 0.91, `brightness ratio out of range at t=${t},x=${x}: ${ratio}`);
    }
  }
});

test("strobe alternates between a dark floor and bright flashes, synchronized across all LEDs", () => {
  const scene = buildSceneFromSpec({ palette: [[255, 255, 255]], pattern: "strobe", brightnessMin: 0.05 });
  let sawFlash = false;
  let sawFloor = false;
  for (let t = 0; t < 6; t += 0.05) {
    const a = scene.render(ctxAt(0.1), t);
    const b = scene.render(ctxAt(0.9), t);
    assert.deepEqual(a, b, `expected all LEDs to flash in sync at t=${t}`);
    const sum = a[0] + a[1] + a[2];
    if (sum > 700) sawFlash = true;
    if (sum < 50) sawFloor = true;
  }
  assert.ok(sawFlash, "expected at least one bright flash");
  assert.ok(sawFloor, "expected a dark floor between flashes");
});
