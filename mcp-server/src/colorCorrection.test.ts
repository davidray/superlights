import { test } from "node:test";
import assert from "node:assert/strict";
import { toLedColor } from "./colorCorrection.js";

test("orange's green channel is pulled down so it stops reading as yellow", () => {
  const [r, g, b] = toLedColor([255, 100, 0]);
  assert.equal(r, 255);
  assert.ok(g < 40, `green should drop well below 100, got ${g}`);
  assert.equal(b, 0);
});

test("primaries, white, and black pass through unchanged", () => {
  for (const c of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]] as const) {
    assert.deepEqual(toLedColor([...c]), [...c]);
  }
});

test("the brightest channel keeps its level, so dim colors stay as dim", () => {
  assert.equal(Math.max(...toLedColor([15, 6, 0])), 15);
  assert.equal(Math.max(...toLedColor([40, 120, 80])), 120);
});
