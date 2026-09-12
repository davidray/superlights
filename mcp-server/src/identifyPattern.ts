import type { RGB } from "./scenes.js";
import { DdpSender } from "./ddp.js";
import { resolveDevice } from "./devices.js";
import { clientFor } from "./actions.js";
import { stopStream } from "./liveStreamController.js";

export const IDENTIFY_DEFAULTS = {
  holdMs: 250,
  startMarkerMs: 2000,
  endMarkerMs: 3000,
  gapMs: 500,
  fps: 20,
} as const;

export interface IdentifyPatternOptions {
  holdMs?: number;
  startMarkerMs?: number;
  endMarkerMs?: number;
  gapMs?: number;
  fps?: number;
}

export interface IdentifyTiming {
  device: string;
  ledCount: number;
  holdMs: number;
  startMarkerMs: number;
  endMarkerMs: number;
  gapMs: number;
  fps: number;
  deviceIndexOrder: "deviceIndex 0..ledCount-1, flat DDP buffer order";
  totalDurationSeconds: number;
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

function requirePositive(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number (got ${value}).`);
  }
}

/**
 * Builds the full DDP frame sequence for identifying a device's LEDs one at a time: a
 * solid-white start marker, a black gap, one LED lit at a time in deviceIndex order (each
 * held for holdMs), another black gap, then a solid-white end marker. The markers let
 * annotate_led_capture auto-locate the scan in a raw recording without the user having to
 * trim the video by hand.
 *
 * Pure -- given the same inputs, always returns the same frames/timing, so this is fully
 * unit-testable without touching any hardware. photoAnnotate.ts's ledHoldWindow mirrors
 * this exact phase order (startMarker -> gap -> per-LED holds -> gap -> endMarker); if you
 * change the order here, update that too.
 */
export function buildIdentifyFrames(
  ledCount: number,
  device: string,
  opts: IdentifyPatternOptions = {}
): { frames: RGB[][]; timing: IdentifyTiming } {
  if (!Number.isInteger(ledCount) || ledCount < 1) {
    throw new Error(`ledCount must be a positive integer (got ${ledCount}).`);
  }
  const holdMs = opts.holdMs ?? IDENTIFY_DEFAULTS.holdMs;
  const startMarkerMs = opts.startMarkerMs ?? IDENTIFY_DEFAULTS.startMarkerMs;
  const endMarkerMs = opts.endMarkerMs ?? IDENTIFY_DEFAULTS.endMarkerMs;
  const gapMs = opts.gapMs ?? IDENTIFY_DEFAULTS.gapMs;
  const fps = opts.fps ?? IDENTIFY_DEFAULTS.fps;
  requirePositive("holdMs", holdMs);
  requirePositive("startMarkerMs", startMarkerMs);
  requirePositive("endMarkerMs", endMarkerMs);
  requirePositive("gapMs", gapMs);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error(`fps must be an integer between 1 and 60 (got ${fps}).`);
  }

  const framesFor = (ms: number) => Math.max(1, Math.round((ms / 1000) * fps));
  const allOff = (): RGB[] => new Array(ledCount).fill(BLACK);
  const allOn = (): RGB[] => new Array(ledCount).fill(WHITE);

  const frames: RGB[][] = [];
  const push = (frame: RGB[], count: number) => {
    for (let i = 0; i < count; i++) frames.push(frame);
  };

  push(allOn(), framesFor(startMarkerMs));
  push(allOff(), framesFor(gapMs));
  const holdFrames = framesFor(holdMs);
  for (let i = 0; i < ledCount; i++) {
    const frame = allOff();
    frame[i] = WHITE;
    push(frame, holdFrames);
  }
  push(allOff(), framesFor(gapMs));
  push(allOn(), framesFor(endMarkerMs));

  const timing: IdentifyTiming = {
    device,
    ledCount,
    holdMs,
    startMarkerMs,
    endMarkerMs,
    gapMs,
    fps,
    deviceIndexOrder: "deviceIndex 0..ledCount-1, flat DDP buffer order",
    totalDurationSeconds: frames.length / fps,
  };
  return { frames, timing };
}

/**
 * Streams the identify sequence to a device over DDP in the background and returns the
 * timing details immediately (the sequence itself takes tens of seconds to run) -- start
 * recording video right when this is called (the start marker gives a couple seconds of
 * slack) and record for totalDurationSeconds. Not registered with liveStreamController's
 * stream map, so stop_live can't cancel it early -- it's a short, bounded, one-shot
 * sequence rather than an ambient scene, so that's an acceptable simplification.
 */
export async function streamIdentifyPattern(device: string, opts: IdentifyPatternOptions = {}): Promise<IdentifyTiming> {
  const info = await clientFor(device).getInfo();
  const ledCount = info.leds?.count;
  if (!ledCount || ledCount < 1) {
    throw new Error(`Device "${device}" reports ${ledCount ?? 0} LEDs -- nothing to identify.`);
  }

  const { frames, timing } = buildIdentifyFrames(ledCount, device, opts);

  stopStream(device); // preempt any running play_scene_live stream on this device

  const host = resolveDevice(device);
  const sender = new DdpSender(host);
  const intervalMs = 1000 / timing.fps;
  let frameIndex = 0;
  const timer = setInterval(() => {
    if (frameIndex >= frames.length) {
      clearInterval(timer);
      sender.close();
      return;
    }
    const frame = frames[frameIndex++];
    sender.sendFrame(frame).catch((err) => {
      console.error(`[identifyPattern] send failed for ${device}: ${(err as Error).message}`);
    });
  }, intervalMs);

  return timing;
}
