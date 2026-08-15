import { CoordinateMap, allLedPositions } from "./coordinateMap.js";
import { Scene, RGB } from "./scenes.js";

export interface Frame {
  tSeconds: number;
  /** Colors in deviceIndex order (matches DDP flat-buffer order) */
  colors: RGB[];
}

/** Render a single instant. Colors are in deviceIndex order. */
export function renderFrame(map: CoordinateMap, scene: Scene, tSeconds: number): RGB[] {
  return allLedPositions(map).map((p) => scene.render(p, tSeconds));
}

/** Render a span of time as discrete frames, for preview/simulation. */
export function renderFrames(map: CoordinateMap, scene: Scene, durationSeconds: number, fps: number): Frame[] {
  const positions = allLedPositions(map);
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  const frames: Frame[] = [];
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    frames.push({ tSeconds: t, colors: positions.map((p) => scene.render(p, t)) });
  }
  return frames;
}
