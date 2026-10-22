import { buildSceneFromSpec, type SceneSpec } from "./sceneSpec.js";

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

/** A built-in scene's render() backed by a sceneSpec pattern. Built on first use rather
 *  than at module load, since sceneSpec.ts imports `hash` back from this module. */
function fromSpec(spec: SceneSpec): Scene["render"] {
  let render: Scene["render"] | undefined;
  return (ctx, t) => (render ??= buildSceneFromSpec(spec).render)(ctx, t);
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
      const heightWeight = 1 - ctx.y;
      // Each LED runs its own sparkle clock (offset by a per-LED hash) so fades
      // don't pulse in sync across the house.
      const cycle = 1.2;
      const local = t / cycle + hash(ctx.deviceIndex, 777);
      const slot = Math.floor(local);
      const density = 0.06 + 0.18 * heightWeight;
      if (hash(ctx.deviceIndex, slot) > density) return [0, 0, 0];
      const envelope = Math.sin((local - slot) * Math.PI);
      const b = Math.round(128 * (0.6 + 0.4 * heightWeight) * envelope);
      return [b, b, Math.min(255, b + Math.round(30 * envelope))];
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
    description: "Gold and white fireworks bursting along the roofline over a dim warm base, each rocket streaking in and exploding into crackling sparks (after WLED 16's PS Fireworks 1D) — countdown energy for New Year's Eve.",
    render: fromSpec({ palette: [[255, 200, 70], [255, 255, 240], [255, 160, 40]], pattern: "fireworks1d", speed: 1.1, sparkleDensity: 0.6, brightnessMin: 0.15 }),
  },
  {
    id: "valentines-glow",
    name: "Valentine's Glow",
    description: "Slow, glowing blobs of deep red and pink that wander, swell, and merge along the house (after WLED 16's Lava Lamp).",
    render: fromSpec({ palette: [[90, 0, 20], [200, 20, 60], [255, 110, 160]], pattern: "lavaLamp", speed: 0.8, brightnessMin: 0.12 }),
  },
  {
    id: "st-patricks-shimmer",
    name: "St. Patrick's Shimmer",
    description: "Shades of green with soft highlights gliding across the house, like light catching satin (after WLED 16's Shimmer).",
    render: fromSpec({ palette: [[0, 140, 40], [60, 200, 60], [0, 100, 60]], pattern: "shimmer", speed: 0.9, brightnessMin: 0.4 }),
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
    description: "Orange and purple lantern beams sweeping back and forth, leaving moving pools of shadow (after WLED 16's PS Dancing Shadows), with occasional dark flickers — spooky for Halloween season.",
    render: (() => {
      const shadows = fromSpec({ palette: [[255, 100, 0], [110, 20, 160]], pattern: "dancingShadows", speed: 0.9, bandWidth: 0.09, brightnessMin: 0.06 });
      return (ctx: LedContext, t: number): RGB => (hash(ctx.deviceIndex, Math.floor(t * 10)) < 0.05 ? [0, 0, 0] : shadows(ctx, t));
    })(),
  },
  {
    id: "autumn-harvest",
    name: "Autumn Harvest",
    description: "Drifting clouds of warm orange, brown, and gold, like leaves blowing across the house (after WLED 16's Color Clouds) — for Thanksgiving.",
    render: fromSpec({ palette: [[200, 70, 0], [120, 50, 10], [230, 150, 20], [170, 30, 0]], pattern: "clouds", speed: 0.8, bandWidth: 0.2, brightnessMin: 0.3 }),
  },
  {
    id: "easter-pastels",
    name: "Easter Pastels",
    description: "Soft clouds of pastel pink, lavender, and mint drifting and morphing across the house (after WLED 16's Color Clouds) — for Easter.",
    render: fromSpec({ palette: [[255, 150, 190], [190, 150, 255], [140, 240, 190], [255, 220, 150]], pattern: "clouds", speed: 0.6, bandWidth: 0.25, brightnessMin: 0.45 }),
  },
  // A one-off team/personal-color variant (e.g. a "game day" chase in one
  // household's team colors) belongs here as a local sceneSpec, not as a
  // permanent built-in shipped to every installer of this package -- see
  // the "Impromptu scenes" section of the top-level README.md for a
  // royal-blue/white chase example built from sceneSpec.ts's palette+pattern
  // primitives instead of a hand-written render() like the scenes above.
];

export function findScene(id: string): Scene | undefined {
  return scenes.find((s) => s.id === id);
}
