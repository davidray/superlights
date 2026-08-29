import type { RGB, LedContext, Scene } from "./scenes.js";
import { hash } from "./scenes.js";

export type ScenePattern =
  | "solid"
  | "wave"
  | "chase"
  | "twinkle"
  | "pulse"
  | "gradientDrift"
  | "fireworks"
  | "comet"
  | "rain"
  | "bounce"
  | "aurora"
  | "strobe";

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
  /** Fraction of the house per repeating band, for wave/chase/aurora. Also reused,
   *  pattern-specifically, as: fireworks' ring thickness, comet's trail length,
   *  rain's column width, bounce's dot size. Smaller means more/thinner/narrower. */
  bandWidth?: number;
  direction?: 1 | -1;
  /** Fraction of LEDs lit at once, for twinkle. Also reused as fireworks' spark
   *  texture density within a burst ring, and strobe's per-slot flash probability. */
  sparkleDensity?: number;
  /** Brightness floor/ceiling (0-1). twinkle's background / pulse's & fireworks'
   *  breathing-fade range / aurora's shimmer range / strobe's between-flash floor. */
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

/** 0->1->0 triangle wave of period 1 at phase `p` (any real number). */
function triangleWave(p: number): number {
  const wrapped = ((p % 1) + 1) % 1;
  return wrapped < 0.5 ? wrapped * 2 : 2 - wrapped * 2;
}

/** One firework "battery"'s contribution at (x, y, t): a burst ignites at the start of
 *  some slots (probabilistically, seeded by slot index), expands into a ring, and
 *  fades as it ages. Returns 0 brightness for slots with no burst, or once a burst has
 *  aged out -- callers combine multiple streams by taking whichever is brighter. */
function fireworksBurst(
  streamSeed: number,
  x: number,
  y: number,
  t: number,
  slotDuration: number,
  burstDuration: number,
  ringWidth: number,
  sparkDensity: number,
  fade: (progress: number) => number
): { brightness: number; seed: number } {
  const slotIndex = Math.floor(t / slotDuration);
  const seed = slotIndex * 4 + streamSeed;
  if (hash(seed, 0) > 0.7) return { brightness: 0, seed }; // ~70% of slots launch a burst

  const age = t - slotIndex * slotDuration;
  if (age < 0 || age > burstDuration) return { brightness: 0, seed };

  const originX = hash(seed, 1);
  const originY = hash(seed, 2) * 0.6; // weighted toward the roofline (low y), not the ground
  const radius = (age / burstDuration) * 0.5;
  const dx = x - originX;
  const dy = y - originY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const ringProximity = 1 - Math.min(1, Math.abs(dist - radius) / ringWidth);
  if (ringProximity <= 0) return { brightness: 0, seed };

  const sparkle = hash(seed * 97 + Math.floor(dist * 977), Math.floor(dy * 613)) < sparkDensity ? 1 : 0.15;
  return { brightness: ringProximity * sparkle * fade(age / burstDuration), seed };
}

export function buildSceneFromSpec(spec: SceneSpec): Scene {
  if (!spec.palette.length) throw new Error("Scene spec needs at least one palette color.");
  const palette = spec.palette;
  const speed = spec.speed ?? 1;
  const direction = spec.direction ?? 1;
  const cycles = spec.bandWidth ? 1 / spec.bandWidth : undefined;

  // Per-frame memo for patterns whose color/brightness depend only on `t`, never on the
  // per-LED ctx, but whose render() is still called once per LED per frame (the
  // liveStreamController tick loop invokes scene.render(p, t) with the SAME t for every
  // LED in one frame). Caching the last {t, result} pair means repeat calls within a
  // frame reuse it instead of redoing the same frame-invariant work per LED.
  let frameMemo: { t: number; color: RGB } | undefined;

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
        if (frameMemo && frameMemo.t === t) return frameMemo.color;
        const min = spec.brightnessMin ?? 0.25;
        const max = spec.brightnessMax ?? 1;
        const pulse = (Math.sin(t * speed * 1.1) + 1) / 2;
        const color = paletteAt(palette, t * speed * 0.05);
        const result = scaleRgb(color, min + (max - min) * pulse);
        frameMemo = { t, color: result };
        return result;
      }

      case "fireworks": {
        const slotDuration = 1.4 / speed;
        const burstDuration = slotDuration * 0.85;
        const ringWidth = spec.bandWidth ?? 0.08;
        const sparkDensity = spec.sparkleDensity ?? 0.6;
        const floor = spec.brightnessMin ?? 0;
        const ceiling = spec.brightnessMax ?? 1;
        const fade = (progress: number) => floor + (ceiling - floor) * (1 - progress);

        // Two independently-timed "batteries" (offset by half a slot) so bursts overlap
        // more often than a single stream would allow -- whichever is brighter at this
        // LED wins, both in brightness and in which burst's color it shows.
        let best = { brightness: 0, seed: 0 };
        for (let stream = 0; stream < 2; stream++) {
          const streamT = t + stream * (slotDuration / 2);
          const contribution = fireworksBurst(stream, ctx.x, ctx.y, streamT, slotDuration, burstDuration, ringWidth, sparkDensity, fade);
          if (contribution.brightness > best.brightness) best = contribution;
        }
        if (best.brightness <= 0) return [0, 0, 0];
        const color = paletteStepAt(palette, hash(best.seed, 3));
        return scaleRgb(color, best.brightness);
      }

      case "comet": {
        const raw = t * speed * 0.18 * direction;
        const pos = ((raw % 1) + 1) % 1;
        const loopCount = Math.floor(raw);
        const trailWidth = spec.bandWidth ?? 0.15;
        // Distance behind the comet along its direction of travel, wrapped into [0,1) --
        // 0 at the comet's head, increasing going backward, and (correctly) large for
        // points it hasn't reached yet just ahead of it.
        const behind = (((pos - ctx.x) * direction) % 1 + 1) % 1;
        const brightness = Math.exp(-behind / trailWidth);
        const colorIndex = ((loopCount % palette.length) + palette.length) % palette.length;
        return scaleRgb(palette[colorIndex], brightness);
      }

      case "rain": {
        const columnCount = cycles ?? 30;
        const column = Math.min(columnCount - 1, Math.floor(ctx.x * columnCount));
        const dropPeriod = 1.6 / speed;
        const phase = hash(column, 7);
        const localT = (((t / dropPeriod + phase) % 1) + 1) % 1;
        const dropY = localT; // 0 at the roofline, 1 at the ground, then resets
        const trailWidth = 0.18;
        const trailDist = dropY - ctx.y; // trail is above the head (smaller y), where it's already fallen past
        const brightness = trailDist >= 0 ? Math.exp(-trailDist / trailWidth) : 0;
        const intensity = spec.brightnessMax ?? 1;
        const colorIndex = column % palette.length;
        return scaleRgb(palette[colorIndex], brightness * intensity);
      }

      case "bounce": {
        const ballCount = Math.max(1, Math.min(3, palette.length));
        const width = spec.bandWidth ?? 0.06;
        const freq = speed / 2;
        let best = { brightness: 0, index: 0 };
        for (let i = 0; i < ballCount; i++) {
          const phaseOffset = i / ballCount + hash(i, 42) * 0.3;
          const pos = triangleWave(t * freq + phaseOffset);
          const brightness = Math.exp(-Math.abs(ctx.x - pos) / width);
          if (brightness > best.brightness) best = { brightness, index: i };
        }
        return scaleRgb(palette[best.index], best.brightness);
      }

      case "aurora": {
        const freq = cycles ?? 1.3;
        const flow = ctx.x * freq + 0.4 * Math.sin(ctx.y * 3 + t * speed * 0.15) - t * speed * 0.12 * direction;
        const color = paletteAt(palette, flow);
        const floor = spec.brightnessMin ?? 0.35;
        const ceiling = spec.brightnessMax ?? 1;
        const shimmer = clamp01(0.65 + 0.35 * Math.sin(ctx.x * 5 + ctx.y * 4 + t * speed * 0.3));
        return scaleRgb(color, floor + (ceiling - floor) * shimmer);
      }

      case "strobe": {
        if (frameMemo && frameMemo.t === t) return frameMemo.color;
        const slotDuration = 1.5 / speed;
        const slotIndex = Math.floor(t / slotDuration);
        const fireProbability = spec.sparkleDensity ?? 0.35;
        const flashDuration = 0.12 / speed;
        const floor = spec.brightnessMin ?? 0;
        const withinSlot = t - slotIndex * slotDuration;
        const fires = hash(slotIndex, 11) < fireProbability;
        const brightness = fires && withinSlot < flashDuration ? 1 - withinSlot / flashDuration : floor;
        const color = scaleRgb(paletteStepAt(palette, hash(slotIndex, 12)), brightness);
        frameMemo = { t, color };
        return color;
      }
    }
  };

  return { id: "custom", name: spec.name ?? "Custom Scene", description: "Ad-hoc scene composed from an inline spec.", render };
}
