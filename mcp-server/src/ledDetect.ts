export type RGB = [number, number, number];

export interface Frame {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major, length === width*height*4 */
  data: Uint8Array;
}

function brightnessMap(frame: Frame): { values: Float64Array; max: number } {
  const { width, height, data } = frame;
  const count = width * height;
  const values = new Float64Array(count);
  let max = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const b = (data[o] + data[o + 1] + data[o + 2]) / 3;
    values[i] = b;
    if (b > max) max = b;
  }
  return { values, max };
}

/**
 * Whether (nearly) the whole frame is bright -- i.e. a solid-white identify_leds sync
 * marker, as opposed to a mostly-dark frame with at most one lit LED. Used to locate the
 * start/end markers in a raw recording without knowing exact timing up front.
 */
export function isMarkerFrame(frame: Frame, opts: { markerFraction?: number } = {}): boolean {
  const markerFraction = opts.markerFraction ?? 0.5;
  const { values, max } = brightnessMap(frame);
  if (max <= 0) return false;
  const threshold = max * 0.6;
  let brightCount = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= threshold) brightCount++;
  return brightCount / values.length >= markerFraction;
}

export interface BlobDetection {
  /** Normalized 0-1, brightness-weighted centroid */
  x: number;
  y: number;
  pixelCount: number;
  totalBrightness: number;
  /** true if a second blob of comparable brightness was also found in this frame -- it
   *  doesn't clearly show just one lit LED (motion blur catching two, a reflection, etc). */
  ambiguous: boolean;
}

const AMBIGUOUS_RATIO = 0.8;

/**
 * Finds the single brightest connected blob of pixels in a frame (iterative flood fill --
 * no recursion, so it's safe on full-resolution frames), for locating one lit LED against
 * an otherwise-dark frame. Returns null if nothing is brighter than the noise floor.
 */
export function findBrightestBlob(frame: Frame, opts: { relativeThreshold?: number } = {}): BlobDetection | null {
  const { width, height } = frame;
  const relativeThreshold = opts.relativeThreshold ?? 0.6;
  const { values, max } = brightnessMap(frame);
  if (max <= 0) return null;
  const threshold = max * relativeThreshold;

  const visited = new Uint8Array(width * height);
  const blobs: { pixelCount: number; totalBrightness: number; sumX: number; sumY: number }[] = [];

  for (let start = 0; start < values.length; start++) {
    if (visited[start] || values[start] < threshold) continue;

    let pixelCount = 0;
    let totalBrightness = 0;
    let sumX = 0;
    let sumY = 0;
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = (idx / width) | 0;
      const b = values[idx];
      pixelCount++;
      totalBrightness += b;
      sumX += x * b;
      sumY += y * b;

      const tryNeighbor = (nx: number, ny: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const n = ny * width + nx;
        if (visited[n] || values[n] < threshold) return;
        visited[n] = 1;
        stack.push(n);
      };
      tryNeighbor(x - 1, y);
      tryNeighbor(x + 1, y);
      tryNeighbor(x, y - 1);
      tryNeighbor(x, y + 1);
    }
    blobs.push({ pixelCount, totalBrightness, sumX, sumY });
  }

  if (blobs.length === 0) return null;
  blobs.sort((a, b) => b.totalBrightness - a.totalBrightness);
  const [best, second] = blobs;
  return {
    x: best.sumX / best.totalBrightness / width,
    y: best.sumY / best.totalBrightness / height,
    pixelCount: best.pixelCount,
    totalBrightness: best.totalBrightness,
    ambiguous: second !== undefined && second.totalBrightness >= best.totalBrightness * AMBIGUOUS_RATIO,
  };
}

// --- Annotation drawing -----------------------------------------------------
// A tiny embedded 3x5 bitmap font (digits only -- LED indices are always integers) so
// annotate_led_capture doesn't need a canvas/font-rendering dependency just for labels.

const DIGIT_GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};
const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;

function setPixel(frame: Frame, x: number, y: number, color: RGB): void {
  if (x < 0 || x >= frame.width || y < 0 || y >= frame.height) return;
  const o = (y * frame.width + x) * 4;
  frame.data[o] = color[0];
  frame.data[o + 1] = color[1];
  frame.data[o + 2] = color[2];
  frame.data[o + 3] = 255;
}

/** Draws a filled circle -- a small dot marking a detected LED's position. */
export function drawDot(frame: Frame, cx: number, cy: number, radius: number, color: RGB): void {
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      if (x * x + y * y <= radius * radius) setPixel(frame, cx + x, cy + y, color);
    }
  }
}

/**
 * Draws an integer label (digits only) as blocky pixel text, scaled up by `scale`, with a
 * solid background box behind it for legibility against any backdrop. Anchored with its
 * top-left corner at (x, y).
 */
export function drawLabel(frame: Frame, text: string, x: number, y: number, opts: { scale?: number; color?: RGB; background?: RGB } = {}): void {
  const scale = opts.scale ?? 2;
  const color = opts.color ?? ([255, 32, 32] as RGB);
  const background = opts.background ?? ([0, 0, 0] as RGB);
  const charWidth = GLYPH_WIDTH * scale;
  const charHeight = GLYPH_HEIGHT * scale;
  const gap = scale;
  const totalWidth = text.length * charWidth + (text.length - 1) * gap;

  for (let by = -1; by <= charHeight; by++) {
    for (let bx = -1; bx <= totalWidth; bx++) setPixel(frame, x + bx, y + by, background);
  }

  let cursorX = x;
  for (const ch of text) {
    const glyph = DIGIT_GLYPHS[ch];
    if (glyph) {
      for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
        for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
          if (glyph[gy][gx] === "1") {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                setPixel(frame, cursorX + gx * scale + sx, y + gy * scale + sy, color);
              }
            }
          }
        }
      }
    }
    cursorX += charWidth + gap;
  }
}
