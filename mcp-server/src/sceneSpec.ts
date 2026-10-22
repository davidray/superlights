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
  | "strobe"
  | "shimmer"
  | "clouds"
  | "dancingShadows"
  | "fireworks1d"
  | "lavaLamp";

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
   *  rain's column width, bounce's dot size, shimmer's glint width, clouds' cloud
   *  size, dancingShadows' beam width, fireworks1d's spark size, lavaLamp's blob
   *  size. Smaller means more/thinner/narrower. */
  bandWidth?: number;
  direction?: 1 | -1;
  /** Fraction of LEDs lit at once, for twinkle. Also reused as fireworks' spark
   *  texture density within a burst ring, strobe's per-slot flash probability, and
   *  fireworks1d's spark count per burst. */
  sparkleDensity?: number;
  /** Brightness floor/ceiling (0-1). twinkle's background / pulse's & fireworks'
   *  breathing-fade range / aurora's shimmer range / strobe's between-flash floor /
   *  shimmer's base-to-glint range / clouds' brightness range / dancingShadows' and
   *  fireworks1d's and lavaLamp's background floor. */
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

/** Smooth 1D value noise in [0,1]: hashed lattice values at integer u, eased between. */
function valueNoise(seed: number, u: number): number {
  const i = Math.floor(u);
  const f = u - i;
  const eased = f * f * (3 - 2 * f);
  const a = hash(seed, i);
  return a + (hash(seed, i + 1) - a) * eased;
}

/** One 1D firework "battery" (WLED 16's PS Fireworks 1D / PS Starburst, along the
 *  roofline): a rocket streaks toward a random point, then bursts into sparks that fly
 *  outward both ways, slowing under drag and fading. Returns this battery's brightness
 *  at x plus the burst's seed (for picking its color); 0 when nothing is lit here. */
function fireworks1dBurst(
  streamSeed: number,
  x: number,
  t: number,
  slotDuration: number,
  sparkCount: number,
  sparkWidth: number
): { brightness: number; seed: number } {
  const slotIndex = Math.floor(t / slotDuration);
  const seed = slotIndex * 4 + streamSeed + 100;
  if (hash(seed, 0) > 0.8) return { brightness: 0, seed }; // ~80% of slots launch

  const age = t - slotIndex * slotDuration;
  const launchDuration = slotDuration * 0.25;
  const burstX = 0.12 + 0.76 * hash(seed, 1);
  if (age < launchDuration) {
    const from = hash(seed, 2) < 0.5 ? burstX - 0.3 : burstX + 0.3;
    const head = from + (burstX - from) * (age / launchDuration);
    const behind = (x - head) * Math.sign(burstX - from) * -1; // >0 is the trail side
    if (behind < -sparkWidth) return { brightness: 0, seed };
    return { brightness: 0.6 * Math.exp(-Math.max(0, behind) / 0.03), seed };
  }

  const sparkAge = (age - launchDuration) / (slotDuration - launchDuration); // 0..1
  const drag = 4;
  const travel = (1 - Math.exp(-drag * sparkAge)) / drag;
  const fade = Math.pow(1 - sparkAge, 1.5);
  let best = 0;
  for (let k = 0; k < sparkCount; k++) {
    const velocity = (hash(seed, 10 + k) - 0.5) * 2;
    const pos = burstX + velocity * travel;
    const glow = Math.exp(-Math.abs(x - pos) / sparkWidth);
    // Late sparks crackle on and off instead of just dimming out.
    const crackle = sparkAge > 0.5 && hash(seed * 31 + k, Math.floor(t * 20)) < 0.35 ? 0.2 : 1;
    best = Math.max(best, glow * fade * crackle);
  }
  return { brightness: best, seed };
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

      case "shimmer": {
        // WLED 16's Shimmer: a soft highlight glides across a dim, gently-breathing base
        // at irregular intervals, like light catching satin.
        const floor = spec.brightnessMin ?? 0.35;
        const ceiling = spec.brightnessMax ?? 1;
        const width = spec.bandWidth ?? 0.08;
        const base = paletteAt(palette, ctx.x * 0.8 - t * speed * 0.03 * direction);
        const breathe = 0.85 + 0.15 * valueNoise(ctx.deviceIndex, t * speed * 0.8);
        const slotDuration = 4 / speed;
        let glint = 0;
        for (let stream = 0; stream < 2; stream++) {
          const streamT = t + stream * slotDuration * 0.5;
          const slotIndex = Math.floor(streamT / slotDuration);
          if (hash(slotIndex * 2 + stream, 21) > 0.75) continue; // ~25% of slots stay quiet
          const progress = (streamT - slotIndex * slotDuration) / slotDuration;
          const head = -width * 2 + progress * (1 + width * 4);
          const pos = direction === 1 ? head : 1 - head;
          const d = (ctx.x - pos) / width;
          glint = Math.max(glint, Math.exp(-d * d));
        }
        const color = lerpRgb(base, [255, 255, 255], 0.35 * glint);
        return scaleRgb(color, (floor + (ceiling - floor) * glint) * breathe);
      }

      case "clouds": {
        // WLED 16's Color Clouds: soft blobs of palette color drifting and morphing.
        const scale = cycles ?? 4;
        const drift = t * speed * 0.08 * direction;
        const u = ctx.x * scale + ctx.y * 0.6 - drift;
        const hueField = 0.7 * valueNoise(1, u) + 0.3 * valueNoise(2, u * 2.1 + t * speed * 0.05);
        const color = paletteAt(palette, hueField * 1.25);
        const floor = spec.brightnessMin ?? 0.25;
        const ceiling = spec.brightnessMax ?? 1;
        const density = valueNoise(3, ctx.x * scale * 1.3 + t * speed * 0.06 * direction);
        return scaleRgb(color, floor + (ceiling - floor) * density);
      }

      case "dancingShadows": {
        // WLED 16's PS Dancing Shadows: overlapping soft beams sliding back and forth at
        // different rates, leaving moving pools of shadow between them.
        const beamCount = Math.min(6, Math.max(3, palette.length * 2));
        const baseWidth = spec.bandWidth ?? 0.07;
        const floor = spec.brightnessMin ?? 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < beamCount; i++) {
          const rate = 0.25 + 0.35 * hash(i, 5);
          const pos = 0.5 + 0.6 * Math.sin(t * speed * rate + hash(i, 6) * Math.PI * 2);
          const width = baseWidth * (0.6 + 0.8 * hash(i, 7));
          const d = (ctx.x - pos) / width;
          const glow = Math.exp(-d * d);
          const c = palette[i % palette.length];
          r += c[0] * glow;
          g += c[1] * glow;
          b += c[2] * glow;
        }
        const bg = scaleRgb(palette[0], floor);
        return [Math.min(255, Math.round(r) + bg[0]), Math.min(255, Math.round(g) + bg[1]), Math.min(255, Math.round(b) + bg[2])];
      }

      case "fireworks1d": {
        const slotDuration = 2.2 / speed;
        const sparkCount = Math.round(6 + 18 * (spec.sparkleDensity ?? 0.5));
        const sparkWidth = spec.bandWidth ?? 0.012;
        const floor = spec.brightnessMin ?? 0;
        let best = { brightness: 0, seed: 0 };
        for (let stream = 0; stream < 2; stream++) {
          const streamT = t + stream * (slotDuration / 2);
          const contribution = fireworks1dBurst(stream, ctx.x, streamT, slotDuration, sparkCount, sparkWidth);
          if (contribution.brightness > best.brightness) best = contribution;
        }
        const bg = scaleRgb(palette[0], floor);
        if (best.brightness <= 0) return bg;
        const lit = scaleRgb(paletteStepAt(palette, hash(best.seed, 3)), best.brightness);
        return [Math.max(bg[0], lit[0]), Math.max(bg[1], lit[1]), Math.max(bg[2], lit[2])];
      }

      case "lavaLamp": {
        // WLED 16's Lava Lamp / Magma (user_fx): slow blobs that wander, swell, and merge,
        // hottest (last palette color) at their cores.
        const blobCount = 5;
        const size = spec.bandWidth ?? 0.12;
        const floor = spec.brightnessMin ?? 0.08;
        let field = 0;
        for (let i = 0; i < blobCount; i++) {
          const pos = 0.5 + 0.55 * Math.sin(t * speed * (0.05 + 0.06 * hash(i, 31)) + hash(i, 32) * Math.PI * 2);
          const radius = size * (0.7 + 0.5 * Math.sin(t * speed * 0.2 + i * 1.7));
          const d = ctx.x - pos;
          field += (radius * radius) / (d * d + radius * radius * 0.5);
        }
        const heat = clamp01((field - 0.35) / 1.5);
        if (heat <= 0) return scaleRgb(palette[0], floor);
        // Non-cyclic ramp from the first palette color (cool edge) to the last (hot core).
        let color = palette[0];
        if (palette.length > 1) {
          const scaled = heat * (palette.length - 1);
          const i = Math.min(palette.length - 2, Math.floor(scaled));
          color = lerpRgb(palette[i], palette[i + 1], scaled - i);
        }
        return scaleRgb(color, floor + (1 - floor) * Math.min(1, heat * 1.6));
      }
    }
  };

  return { id: "custom", name: spec.name ?? "Custom Scene", description: "Ad-hoc scene composed from an inline spec.", render };
}

/** Either a registered scene id (see scenes.ts) or an inline spec. */
export type SceneRef = string | SceneSpec;

const SCENE_PATTERNS: readonly ScenePattern[] = ["solid", "wave", "chase", "twinkle", "pulse", "gradientDrift", "fireworks", "comet", "rain", "bounce", "aurora", "strobe", "shimmer", "clouds", "dancingShadows", "fireworks1d", "lavaLamp"];

function assertOptionalNumber(value: unknown, field: string, { min, max, positive }: { min?: number; max?: number; positive?: boolean } = {}): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error(`Invalid scene ${field} ${JSON.stringify(value)}.`);
  }
}

/**
 * Mirrors the zod sceneSpec in index.ts, for callers that receive raw JSON without going
 * through it (triggerServer.ts's HTTP routes, a hand-edited holidaySchedule.json).
 */
export function assertSceneRef(scene: unknown, field = "scene"): asserts scene is SceneRef {
  if (typeof scene === "string") {
    if (scene.trim() === "") throw new Error(`"${field}" is required.`);
    return;
  }
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
    throw new Error(`"${field}" must be a scene id or an inline scene spec.`);
  }
  const spec = scene as Record<string, unknown>;
  if (!SCENE_PATTERNS.includes(spec.pattern as ScenePattern)) {
    throw new Error(`Invalid ${field}.pattern ${JSON.stringify(spec.pattern)}: expected one of ${SCENE_PATTERNS.join(", ")}.`);
  }
  const palette = spec.palette;
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 8) {
    throw new Error(`Invalid ${field}.palette: expected 1-8 [r,g,b] colors.`);
  }
  for (const color of palette) {
    if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
      throw new Error(`Invalid ${field}.palette color ${JSON.stringify(color)}: expected [r,g,b] integers 0-255.`);
    }
  }
  if (spec.name !== undefined && typeof spec.name !== "string") throw new Error(`Invalid ${field}.name: must be a string.`);
  if (spec.direction !== undefined && spec.direction !== 1 && spec.direction !== -1) throw new Error(`Invalid ${field}.direction: must be 1 or -1.`);
  assertOptionalNumber(spec.speed, `${field}.speed`, { positive: true });
  assertOptionalNumber(spec.bandWidth, `${field}.bandWidth`, { positive: true });
  assertOptionalNumber(spec.sparkleDensity, `${field}.sparkleDensity`, { min: 0, max: 1 });
  assertOptionalNumber(spec.brightnessMin, `${field}.brightnessMin`, { min: 0, max: 1 });
  assertOptionalNumber(spec.brightnessMax, `${field}.brightnessMax`, { min: 0, max: 1 });
}

/** Short label for logs and status messages. */
export function sceneLabel(scene: SceneRef): string {
  return typeof scene === "string" ? scene : (scene.name ?? "inline scene");
}
