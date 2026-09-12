import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarkerFrame, findBrightestBlob, drawDot, drawLabel, type Frame } from "./ledDetect.js";

function makeFrame(width: number, height: number, fill: [number, number, number] = [0, 0, 0]): Frame {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function setPixelRGB(frame: Frame, x: number, y: number, rgb: [number, number, number]) {
  const o = (y * frame.width + x) * 4;
  frame.data[o] = rgb[0];
  frame.data[o + 1] = rgb[1];
  frame.data[o + 2] = rgb[2];
  frame.data[o + 3] = 255;
}

test("isMarkerFrame: an all-black frame is not a marker", () => {
  assert.equal(isMarkerFrame(makeFrame(10, 10)), false);
});

test("isMarkerFrame: an all-white frame is a marker", () => {
  assert.equal(isMarkerFrame(makeFrame(10, 10, [255, 255, 255])), true);
});

test("isMarkerFrame: a single lit LED among many dark pixels is not a marker", () => {
  const frame = makeFrame(20, 20);
  setPixelRGB(frame, 10, 10, [255, 255, 255]);
  assert.equal(isMarkerFrame(frame), false);
});

test("findBrightestBlob: returns null for an all-black frame", () => {
  assert.equal(findBrightestBlob(makeFrame(10, 10)), null);
});

test("findBrightestBlob: finds a single bright pixel's normalized position", () => {
  const frame = makeFrame(10, 10);
  setPixelRGB(frame, 2, 4, [255, 255, 255]);
  const blob = findBrightestBlob(frame);
  assert.ok(blob);
  assert.equal(blob!.x, 2 / 10);
  assert.equal(blob!.y, 4 / 10);
  assert.equal(blob!.ambiguous, false);
});

test("findBrightestBlob: two comparably-bright separate blobs are flagged ambiguous", () => {
  const frame = makeFrame(10, 10);
  setPixelRGB(frame, 1, 1, [255, 255, 255]);
  setPixelRGB(frame, 8, 8, [250, 250, 250]);
  const blob = findBrightestBlob(frame);
  assert.ok(blob);
  assert.equal(blob!.ambiguous, true);
});

test("findBrightestBlob: a much dimmer second blob is not flagged ambiguous", () => {
  const frame = makeFrame(10, 10);
  setPixelRGB(frame, 1, 1, [255, 255, 255]);
  setPixelRGB(frame, 8, 8, [50, 50, 50]);
  const blob = findBrightestBlob(frame);
  assert.ok(blob);
  assert.equal(blob!.ambiguous, false);
  assert.equal(blob!.x, 1 / 10);
});

test("findBrightestBlob: a multi-pixel blob's centroid is brightness-weighted", () => {
  const frame = makeFrame(10, 10);
  setPixelRGB(frame, 4, 4, [255, 255, 255]);
  setPixelRGB(frame, 5, 4, [255, 255, 255]);
  const blob = findBrightestBlob(frame);
  assert.ok(blob);
  assert.equal(blob!.pixelCount, 2);
  assert.equal(blob!.x, 4.5 / 10);
});

test("drawDot paints a filled circle of the given color", () => {
  const frame = makeFrame(10, 10);
  drawDot(frame, 5, 5, 1, [10, 20, 30]);
  const o = (5 * 10 + 5) * 4;
  assert.equal(frame.data[o], 10);
  assert.equal(frame.data[o + 1], 20);
  assert.equal(frame.data[o + 2], 30);
  // A corner of the bounding box (outside the radius-1 circle) should be untouched.
  const corner = (4 * 10 + 4) * 4;
  assert.equal(frame.data[corner], 0);
});

test("drawLabel paints the '1' glyph in its color, its background box behind it, and leaves the rest of the frame untouched", () => {
  const frame = makeFrame(20, 20, [9, 9, 9]);
  drawLabel(frame, "1", 5, 5, { scale: 1, color: [255, 0, 0], background: [0, 0, 0] });
  // The '1' glyph's top row is "010" -- column 1 of the glyph (x=6) should be colored.
  const lit = (5 * 20 + 6) * 4;
  assert.deepEqual([frame.data[lit], frame.data[lit + 1], frame.data[lit + 2]], [255, 0, 0]);
  // Column 0 of the glyph (x=5) is unset, but still inside the background box.
  const boxed = (5 * 20 + 5) * 4;
  assert.deepEqual([frame.data[boxed], frame.data[boxed + 1], frame.data[boxed + 2]], [0, 0, 0]);
  // Far outside the label entirely -- untouched original fill.
  const untouched = (15 * 20 + 15) * 4;
  assert.deepEqual([frame.data[untouched], frame.data[untouched + 1], frame.data[untouched + 2]], [9, 9, 9]);
});
