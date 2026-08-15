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
function hash(a: number, b: number): number {
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
];

export function findScene(id: string): Scene | undefined {
  return scenes.find((s) => s.id === id);
}
