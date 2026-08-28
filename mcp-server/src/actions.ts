import { WledClient, findByName, type WledSegment } from "./wledClient.js";
import { resolveDevice } from "./devices.js";

function clientFor(device: string): WledClient {
  return new WledClient(resolveDevice(device));
}

// Mirrors the bounds index.ts's zod schemas enforce for the equivalent MCP tools --
// applied here too so triggerServer.ts's HTTP handlers (which call these functions
// directly from raw JSON, bypassing that zod validation) can't write out-of-range values.
const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

function assertInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${label} ${value}: must be an integer between ${min} and ${max}.`);
  }
}

export async function setPower(device: string, on: boolean | "toggle"): Promise<void> {
  await clientFor(device).postState({ on: on === "toggle" ? "t" : on });
}

export async function setBrightness(device: string, brightness: number): Promise<void> {
  assertInRange(brightness, 1, 255, "brightness");
  await clientFor(device).postState({ bri: brightness });
}

export async function applyPreset(device: string, slot: number, transitionMs?: number): Promise<void> {
  assertInRange(slot, 1, 250, "preset slot");
  const state: Record<string, unknown> = { ps: slot };
  if (transitionMs !== undefined) state.tt = Math.round(transitionMs / 100);
  await clientFor(device).postState(state);
}

export interface RunEffectOptions {
  segment?: number;
  speed?: number;
  intensity?: number;
  palette?: string | number;
  colors?: string[];
}

export interface RunEffectResult {
  effectName: string;
  applied: WledSegment;
}

/** Resolves effect/palette names to WLED's numeric IDs and applies them. Shared by the
 *  MCP set_effect tool and the Home Assistant trigger server. */
export async function runEffect(device: string, effect: string | number, opts: RunEffectOptions = {}): Promise<RunEffectResult> {
  if (opts.speed !== undefined) assertInRange(opts.speed, 0, 255, "speed");
  if (opts.intensity !== undefined) assertInRange(opts.intensity, 0, 255, "intensity");
  if (opts.segment !== undefined && (!Number.isInteger(opts.segment) || opts.segment < 0)) {
    throw new Error(`Invalid segment ${opts.segment}: must be a non-negative integer.`);
  }
  if (opts.colors !== undefined) {
    for (const c of opts.colors) {
      if (typeof c !== "string" || !HEX_COLOR.test(c)) {
        throw new Error(`Invalid color "${c}": expected a hex color like #FF8800.`);
      }
    }
  }

  const client = clientFor(device);
  const effects = await client.getEffects();
  const fxId = typeof effect === "number" ? effect : findByName(effects, effect);
  if (fxId === undefined) throw new Error(`No effect matching "${effect}". Call list_effects first.`);

  let palId: number | undefined;
  if (opts.palette !== undefined) {
    const palettes = await client.getPalettes();
    palId = typeof opts.palette === "number" ? opts.palette : findByName(palettes, opts.palette);
    if (palId === undefined) throw new Error(`No palette matching "${opts.palette}". Call list_palettes first.`);
  }

  const seg: WledSegment = { fx: fxId };
  if (opts.speed !== undefined) seg.sx = opts.speed;
  if (opts.intensity !== undefined) seg.ix = opts.intensity;
  if (palId !== undefined) seg.pal = palId;
  if (opts.colors !== undefined) seg.col = opts.colors;

  if (opts.segment !== undefined) {
    await client.postState({ seg: [{ id: opts.segment, ...seg }] });
  } else {
    await client.postState({ seg });
  }

  return { effectName: effects[fxId], applied: seg };
}
