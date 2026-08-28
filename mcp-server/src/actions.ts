import { WledClient, findByName, type WledSegment } from "./wledClient.js";
import { resolveDevice } from "./devices.js";

export function clientFor(device: string): WledClient {
  return new WledClient(resolveDevice(device));
}

export async function setPower(device: string, on: boolean | "toggle"): Promise<void> {
  await clientFor(device).postState({ on: on === "toggle" ? "t" : on });
}

export async function setBrightness(device: string, brightness: number): Promise<void> {
  await clientFor(device).postState({ bri: brightness });
}

export async function applyPreset(device: string, slot: number, transitionMs?: number): Promise<void> {
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
  const client = clientFor(device);
  const needsPalette = opts.palette !== undefined;
  // Independent HTTP calls -- fire both up front instead of waiting on effects before
  // even starting the palette lookup.
  const [effects, palettes] = await Promise.all([client.getEffects(), needsPalette ? client.getPalettes() : Promise.resolve(undefined)]);

  let fxId: number;
  if (typeof effect === "number") {
    if (!Number.isInteger(effect) || effect < 0 || effect >= effects.length) {
      throw new Error(`Effect id ${effect} is out of range (must be 0-${effects.length - 1}). Call list_effects first.`);
    }
    fxId = effect;
  } else {
    const found = findByName(effects, effect);
    if (found === undefined) throw new Error(`No effect matching "${effect}". Call list_effects first.`);
    fxId = found;
  }

  let palId: number | undefined;
  if (opts.palette !== undefined) {
    palId = typeof opts.palette === "number" ? opts.palette : findByName(palettes!, opts.palette);
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
