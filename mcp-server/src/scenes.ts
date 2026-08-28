export type RGB = [number, number, number];

export interface LedContext {
  run: string;
  segment: number;
  /** Index local to the run/segment */
  index: number;
  /** Index in the device's flat pixel buffer (DDP order) */
  deviceIndex: number;
  /** Normalized physical position from the coordinate map, 0-1 */
  x: number;
  y: number;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  render(ctx: LedContext, tSeconds: number): RGB;
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 1) + 1) % 1;
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Deterministic pseudo-random in [0,1) from two numbers, for stable-looking sparkle without shared state. */
export function hash(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export const scenes: Scene[] = [
  {
    id: "ocean-wave",
    name: "Ocean Wave",
    description: "A blue/teal wave sweeping left-to-right across the house, driven by physical x position rather than LED index.",
    render: (ctx, t) => {
      const phase = ctx.x * 3 - t * 0.4;
      const hue = (185 + 35 * Math.sin(phase * Math.PI * 2)) / 360;
      return hslToRgb(hue, 0.75, 0.5);
    },
  },
  {
    id: "candy-cane-chase",
    name: "Candy Cane Chase",
    description: "Red/white diagonal stripes marching along the house by physical position.",
    render: (ctx, t) => {
      const stripe = Math.floor(ctx.x * 20 - t * 6) % 2;
      return stripe === 0 ? [220, 20, 20] : [235, 235, 235];
    },
  },
  {
    id: "roofline-sparkle",
    name: "Roofline Sparkle",
    description: "Random twinkle, weighted brighter near the roofline (low y) and dimmer toward the ground.",
    render: (ctx, t) => {
      const frame = Math.floor(t * 8);
      const twinkle = hash(ctx.deviceIndex, frame);
      const heightWeight = 1 - ctx.y;
      const on = twinkle > 1 - 0.12 * heightWeight;
      const b = on ? Math.round(255 * (0.6 + 0.4 * heightWeight)) : 0;
      return [b, b, Math.min(255, b + 30)];
    },
  },
  {
    id: "solid-warm-white",
    name: "Solid Warm White",
    description: "Static warm white across every LED. Useful as a calibration/baseline scene.",
    render: () => [255, 180, 110],
  },
  {
    id: "birthday-confetti",
    name: "Birthday Confetti",
    description: "Rapid, colorful random flashes across the whole house against a dark background — festive and high-energy, for birthdays and celebrations.",
    render: (ctx, t) => {
      const frame = Math.floor(t * 6);
      const twinkle = hash(ctx.deviceIndex, frame);
      if (twinkle <= 0.75) return [0, 0, 0];
      const hue = hash(ctx.deviceIndex, frame + 1000);
      return hslToRgb(hue, 0.9, 0.55);
    },
  },
  {
    id: "new-years-sparkle",
    name: "New Year's Sparkle",
    description: "Bright gold and white twinkle over a dim warm base — countdown energy for New Year's Eve.",
    render: (ctx, t) => {
      const frame = Math.floor(t * 7);
      const twinkle = hash(ctx.deviceIndex, frame);
      if (twinkle <= 0.7) return [40, 30, 10];
      return hash(ctx.deviceIndex, frame + 500) > 0.5 ? [255, 215, 90] : [255, 255, 240];
    },
  },
  {
    id: "valentines-glow",
    name: "Valentine's Glow",
    description: "Soft pulsing red and pink across the house.",
    render: (ctx, t) => {
      const pulse = (Math.sin(t * 1.2 + ctx.x * 2) + 1) / 2;
      const hue = (340 + ctx.x * 10) / 360;
      return hslToRgb(hue, 0.75, 0.35 + pulse * 0.25);
    },
  },
  {
    id: "st-patricks-shimmer",
    name: "St. Patrick's Shimmer",
    description: "Shades of green shimmering across the house.",
    render: (ctx, t) => {
      const phase = ctx.x * 3 - t * 0.5;
      const hue = (100 + 30 * Math.sin(phase * Math.PI * 2)) / 360;
      return hslToRgb(hue, 0.7, 0.45);
    },
  },
  {
    id: "patriotic-wave",
    name: "Patriotic Wave",
    description: "Red, white, and blue bands sweeping across the house — for July 4th, Veterans Day, Memorial Day, and Labor Day.",
    render: (ctx, t) => {
      const phase = ctx.x * 3 - t * 0.4;
      const p = ((phase % 1) + 1) % 1;
      if (p < 0.33) return [190, 20, 30];
      if (p < 0.66) return [245, 245, 245];
      return [20, 40, 140];
    },
  },
  {
    id: "halloween-flicker",
    name: "Halloween Flicker",
    description: "Flickering orange and purple with occasional dark pulses — spooky for Halloween season.",
    render: (ctx, t) => {
      const frame = Math.floor(t * 10);
      if (hash(ctx.deviceIndex, frame) < 0.08) return [0, 0, 0];
      return hash(ctx.deviceIndex, Math.floor(t * 0.5)) > 0.5 ? [255, 100, 0] : [110, 20, 160];
    },
  },
  {
    id: "autumn-harvest",
    name: "Autumn Harvest",
    description: "Warm oranges, browns, and gold drifting across the house — for Thanksgiving.",
    render: (ctx, t) => {
      const phase = ctx.x * 2.5 - t * 0.3;
      const hue = (25 + 20 * Math.sin(phase * Math.PI * 2)) / 360;
      return hslToRgb(hue, 0.75, 0.4);
    },
  },
  {
    id: "easter-pastels",
    name: "Easter Pastels",
    description: "Soft pastel pink, lavender, and mint drifting across the house — for Easter.",
    render: (ctx, t) => {
      const phase = ctx.x * 3 - t * 0.35;
      const hue = (300 + 120 * ((Math.sin(phase * Math.PI * 2) + 1) / 2)) % 360 / 360;
      return hslToRgb(hue, 0.55, 0.7);
    },
  },
  {
    id: "byu-game-day",
    name: "BYU Game Day",
    description: "Royal blue and white bands sweeping across the house — for BYU football game days.",
    render: (ctx, t) => {
      const phase = ctx.x * 4 - t * 0.5;
      const p = ((phase % 1) + 1) % 1;
      return p < 0.5 ? [0, 46, 93] : [255, 255, 255];
    },
  },
];

export function findScene(id: string): Scene | undefined {
  return scenes.find((s) => s.id === id);
}
