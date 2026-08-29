import { DdpSender } from "./ddp.js";
import { resolveDevice } from "./devices.js";
import { loadCoordinateMap, allLedPositions } from "./coordinateMap.js";
import { findScene, type Scene } from "./scenes.js";
import { buildSceneFromSpec, type SceneSpec } from "./sceneSpec.js";

interface LiveStream {
  /** Unique per registration, so a deferred/stale stop (keyed only by device name) can
   *  tell whether the stream it was scheduled against is still the current one before
   *  tearing anything down. */
  id: number;
  timer: ReturnType<typeof setInterval>;
  sender: DdpSender;
  stopTimeout?: ReturnType<typeof setTimeout>;
}

const liveStreams = new Map<string, LiveStream>();
let nextStreamId = 1;

/** Stops whatever stream currently owns `device`, regardless of id. Only call this
 *  when the caller genuinely wants to preempt the current stream (e.g. a fresh
 *  playSceneLive call, or an explicit stop_live request) -- not from a deferred
 *  callback that only owns one specific stream generation. */
export function stopStream(device: string): boolean {
  const stream = liveStreams.get(device);
  if (!stream) return false;
  clearInterval(stream.timer);
  if (stream.stopTimeout) clearTimeout(stream.stopTimeout);
  stream.sender.close();
  liveStreams.delete(device);
  return true;
}

/** Stops the stream for `device` only if it's still the same registration as `id` --
 *  i.e. no newer stream has replaced it since. Used by deferred/timed stops so they
 *  never kill a stream they don't own. */
function stopStreamIfCurrent(device: string, id: number): void {
  const stream = liveStreams.get(device);
  if (!stream || stream.id !== id) return;
  stopStream(device);
}

export interface PlaySceneOptions {
  durationSeconds?: number;
  fps?: number;
}

export interface PlaySceneResult {
  scene: Scene;
  /** true if streaming continues after this call returns (long/open-ended run) */
  backgrounded: boolean;
}

/**
 * Stream a custom scene to a WLED device over DDP, bypassing its effect engine.
 * Runs of 20s or less resolve only once playback finishes; longer or open-ended
 * runs start immediately and keep streaming in the background — call stopStream
 * to cancel those.
 */
export async function playSceneLive(device: string, sceneOrSpec: string | SceneSpec, opts: PlaySceneOptions = {}): Promise<PlaySceneResult> {
  let scene: Scene;
  if (typeof sceneOrSpec === "string") {
    const found = findScene(sceneOrSpec);
    if (!found) throw new Error(`Unknown scene "${sceneOrSpec}".`);
    scene = found;
  } else {
    scene = buildSceneFromSpec(sceneOrSpec);
  }

  const host = resolveDevice(device);
  const map = loadCoordinateMap(device);
  const positions = allLedPositions(map);
  const fps = opts.fps ?? 30;

  stopStream(device);
  const sender = new DdpSender(host);
  const start = Date.now();

  const tick = async () => {
    const t = (Date.now() - start) / 1000;
    try {
      await sender.sendFrame(positions.map((p) => scene.render(p, t)));
    } catch (err) {
      console.error(`[playSceneLive] send failed for ${device}: ${(err as Error).message}`);
    }
  };

  const id = nextStreamId++;
  const timer = setInterval(tick, 1000 / fps);
  const stream: LiveStream = { id, timer, sender };
  liveStreams.set(device, stream);
  await tick();

  const durationSeconds = opts.durationSeconds;
  if (durationSeconds !== undefined && durationSeconds <= 20) {
    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
    // Only stop the stream we started -- a newer playSceneLive call (or an explicit
    // stop_live) may have already replaced it on this device while we were asleep.
    stopStreamIfCurrent(device, id);
    return { scene, backgrounded: false };
  }

  if (durationSeconds !== undefined) {
    stream.stopTimeout = setTimeout(() => stopStreamIfCurrent(device, id), durationSeconds * 1000);
  }
  return { scene, backgrounded: true };
}
