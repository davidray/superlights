import type { RGB } from "./scenes.js";

// Scene palettes are authored as sRGB, the way they look on a screen (and in the
// Mac simulator preview). LED PWM is linear light, and WLED does not gamma-correct
// realtime (DDP) data by default, so sending those values raw makes every mix of
// channels read washed out: halloween's orange [255, 100, 0] drives green at ~39%
// duty, which the eye sees as yellow.
const GAMMA = 2.2;

/**
 * Convert a scene's sRGB color to what the LEDs should be driven at. Gamma is
 * applied to each channel relative to the brightest one, so hue and saturation
 * come out right while the brightest channel -- the color's overall level -- is
 * left as the scene set it. Scenes tuned for dim floors and fades keep their
 * brightness; only the color gets stronger.
 */
export function toLedColor([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b);
  if (max <= 0) return [0, 0, 0];
  const correct = (c: number) => Math.round(max * Math.pow(c / max, GAMMA));
  return [correct(r), correct(g), correct(b)];
}
