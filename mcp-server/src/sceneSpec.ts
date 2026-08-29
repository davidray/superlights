import type { RGB, LedContext, Scene } from "./scenes.js";
import { hash } from "./scenes.js";

export type ScenePattern = "solid" | "wave" | "chase" | "twinkle" | "pulse" | "gradientDrift";

/**
 * An ad-hoc scene, built from data instead of a compiled render() function. Lets a
 * caller (a chat request, a future UI, etc.) describe a one-off scene at runtime --
 * "romantic, in these colors" -- without needing a code change + add-on release.
 */
export interface SceneSpec {
  /** Human-readable label used in status messages. */
  name?: string;
  /** 1-8 colors as [r,g,b] triples, 0-255 per channel. */
  palette: RGB[];
  pattern: ScenePattern;
  /** Overall tempo multiplier. Default 1. */
  speed?: number;
  /** Fraction of the house per repeating band, for wave/chase. Smaller = more bands. */
  bandWidth?: number;
  direction?: 1 | -1;
  /** Fraction of LEDs lit at once, for twinkle. 0-1, default 0.12. */
  sparkleDensity?: number;
  /** Brightness floor/ceiling (0-1) for twinkle's background and pulse's breathing range. */
  brightnessMin?: number;
  brightnessMax?: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

function scaleRgb(c: RGB, brightness: number): RGB {
  const b = clamp01(brightness);
  return [Math.round(c[0] * b), Math.round(c[1] * b), Math.round(c[2] * b)];
}

/** Smoothly blend between adjacent palette stops at cyclic position u (any real number). */
function paletteAt(palette: RGB[], u: number): RGB {
  if (palette.length === 1) return palette[0];
  const wrapped = ((u % 1) + 1) % 1;
  const scaled = wrapped * palette.length;
  const i = Math.floor(scaled) % palette.length;
  const j = (i + 1) % palette.length;
  return lerpRgb(palette[i], palette[j], scaled - Math.floor(scaled));
}

/** Pick one discrete (non-blended) palette color at cyclic position u in [0,1). */
function paletteStepAt(palette: RGB[], u: number): RGB {
  const wrapped = ((u % 1) + 1) % 1;
  return palette[Math.floor(wrapped * palette.length) % palette.length];
}

export function buildSceneFromSpec(spec: SceneSpec): Scene {
  if (!spec.palette.length) throw new Error("Scene spec needs at least one palette color.");
  const palette = spec.palette;
  const speed = spec.speed ?? 1;
  const direction = spec.direction ?? 1;
  const cycles = spec.bandWidth ? 1 / spec.bandWidth : undefined;

  // Per-frame memo for "pulse": its color/brightness depend only on `t`, never on the
  // per-LED ctx, but render() is called once per LED per frame (liveStreamController's
  // tick loop invokes scene.render(p, t) with the SAME t for every LED in one frame).
  // Cache the last {t, color} pair so repeat calls within a frame just reuse it instead
  // of redoing the sin()/paletteAt() work per LED.
  let pulseMemo: { t: number; color: RGB } | undefined;

  const render = (ctx: LedContext, t: number): RGB => {
    switch (spec.pattern) {
      case "solid":
        return palette[0];

      case "gradientDrift":
        return paletteAt(palette, ctx.x * (cycles ?? 1) - t * speed * 0.35 * direction);

      case "wave":
        return paletteAt(palette, ctx.x * (cycles ?? 1.5) - t * speed * 0.4 * direction);

      case "chase": {
        const bandCount = cycles ?? palette.length * 4;
        const bandIndex = Math.floor(ctx.x * bandCount - t * speed * 6 * direction);
        const i = ((bandIndex % palette.length) + palette.length) % palette.length;
        return palette[i];
      }

      case "twinkle": {
        const density = spec.sparkleDensity ?? 0.12;
        const floor = spec.brightnessMin ?? 0.04;
        const frame = Math.floor(t * 8 * speed);
        if (hash(ctx.deviceIndex, frame) > 1 - density) {
          return paletteStepAt(palette, hash(ctx.deviceIndex, frame + 1000));
        }
        return scaleRgb(palette[0], floor);
      }

      case "pulse": {
        if (pulseMemo && pulseMemo.t === t) return pulseMemo.color;
        const min = spec.brightnessMin ?? 0.25;
        const max = spec.brightnessMax ?? 1;
        const pulse = (Math.sin(t * speed * 1.1) + 1) / 2;
        const color = paletteAt(palette, t * speed * 0.05);
        const result = scaleRgb(color, min + (max - min) * pulse);
        pulseMemo = { t, color: result };
        return result;
      }
    }
  };

  return { id: "custom", name: spec.name ?? "Custom Scene", description: "Ad-hoc scene composed from an inline spec.", render };
}
