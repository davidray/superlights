import { writeFile } from "node:fs/promises";
import { tryLoadCoordinateMap, allLedPositions, type CoordinateMap, type Waypoint } from "./coordinateMap.js";
import { IDENTIFY_DEFAULTS } from "./identifyPattern.js";
import { isMarkerFrame, findBrightestBlob, drawDot, drawLabel, type Frame } from "./ledDetect.js";
import { extractVideoFrames, encodePng } from "./mediaDecode.js";

const ANALYSIS_FPS = 10;
const WEAK_MIN_PIXELS = 2;

export type DetectionConfidence = "ok" | "weak" | "missing" | "ambiguous";

export interface LedDetection {
  deviceIndex: number;
  x: number;
  y: number;
  confidence: DetectionConfidence;
}

/**
 * The [startMs, endMs) window during which LED `deviceIndex` is expected to be lit,
 * relative to the moment the start marker ends (not the recording's own start -- see
 * findScanStart). Pure -- shared by annotateLedCapture and its tests. Mirrors the phase
 * order identifyPattern.ts's buildIdentifyFrames streams: startMarker -> gap -> per-LED
 * holds -> gap -> endMarker; if that order changes, update this too.
 */
export function ledHoldWindow(timing: { gapMs: number; holdMs: number }, deviceIndex: number): { startMs: number; endMs: number } {
  const startMs = timing.gapMs + deviceIndex * timing.holdMs;
  return { startMs, endMs: startMs + timing.holdMs };
}

/**
 * Finds the timestamp of the last frame in the first run of marker-classified frames --
 * i.e. where the identify_leds start marker ends and (gapMs later) the per-LED scan
 * begins. Returns null if no marker run is found at all (e.g. the recording doesn't
 * include it, or was trimmed too aggressively).
 */
export function findScanStart(frames: { timestampMs: number; isMarker: boolean }[]): number | null {
  let markerEnd: number | null = null;
  let inMarker = false;
  for (const f of frames) {
    if (f.isMarker) {
      inMarker = true;
      markerEnd = f.timestampMs;
    } else if (inMarker) {
      break; // first non-marker frame after a marker run -- the run just ended
    }
  }
  return markerEnd;
}

/**
 * Remaps flat detections into an existing coordinate map's run/segment structure. Only
 * run/segment/startIndex/endIndex/deviceOffset topology is preserved verbatim (that isn't
 * recoverable from a video alone); each run's waypoints are replaced with the measured
 * `ok`-confidence positions for its LEDs, falling back to that run's existing waypoints
 * untouched if no confident detection covers it.
 */
export function remapDetectionsToCoordinateMap(detections: LedDetection[], existingMap: CoordinateMap): CoordinateMap {
  const byDeviceIndex = new Map(detections.map((d) => [d.deviceIndex, d]));
  const runs = existingMap.runs.map((run) => {
    const waypoints: Waypoint[] = [];
    for (let index = run.startIndex; index <= run.endIndex; index++) {
      const deviceIndex = run.deviceOffset + (index - run.startIndex);
      const detection = byDeviceIndex.get(deviceIndex);
      if (detection && detection.confidence === "ok") {
        waypoints.push({ index, x: detection.x, y: detection.y });
      }
    }
    return waypoints.length > 0 ? { ...run, waypoints } : run;
  });
  return { ...existingMap, capturedAt: `measured via annotate_led_capture on ${new Date().toISOString()}`, runs };
}

export interface AnnotateLedCaptureArgs {
  device: string;
  filePath: string;
  outputImagePath: string;
  ledCount?: number;
  holdMs?: number;
  startMarkerMs?: number;
  endMarkerMs?: number;
  gapMs?: number;
  writeCandidateCalibration?: boolean;
}

export interface AnnotateLedCaptureResult {
  annotatedImagePath: string;
  imageWidth: number;
  imageHeight: number;
  detections: LedDetection[];
  missingCount: number;
  candidateCalibration: CoordinateMap | null;
}

export async function annotateLedCapture(args: AnnotateLedCaptureArgs): Promise<AnnotateLedCaptureResult> {
  const existingMap = tryLoadCoordinateMap(args.device);
  const ledCount = args.ledCount ?? (existingMap ? allLedPositions(existingMap).length : undefined);
  if (!ledCount) {
    throw new Error(`No ledCount given, and device "${args.device}" has no existing coordinate map to infer it from.`);
  }

  const timing = {
    gapMs: args.gapMs ?? IDENTIFY_DEFAULTS.gapMs,
    holdMs: args.holdMs ?? IDENTIFY_DEFAULTS.holdMs,
  };

  const extracted = await extractVideoFrames(args.filePath, ANALYSIS_FPS);
  const markerEnd = findScanStart(extracted.map((f) => ({ timestampMs: f.timestampMs, isMarker: isMarkerFrame(f.frame) })));
  if (markerEnd === null) {
    throw new Error(
      `Couldn't find the identify_leds start marker (a run of solid-white frames) in "${args.filePath}". ` +
        `Make sure the recording includes it -- start recording a couple seconds before calling identify_leds.`
    );
  }

  const detections: LedDetection[] = [];
  for (let deviceIndex = 0; deviceIndex < ledCount; deviceIndex++) {
    const window = ledHoldWindow(timing, deviceIndex);
    const windowFrames = extracted.filter((f) => {
      const t = f.timestampMs - markerEnd;
      return t >= window.startMs && t < window.endMs;
    });
    if (windowFrames.length === 0) {
      detections.push({ deviceIndex, x: 0, y: 0, confidence: "missing" });
      continue;
    }
    const blobs = windowFrames.map((f) => findBrightestBlob(f.frame)).filter((b): b is NonNullable<typeof b> => b !== null);
    if (blobs.length === 0) {
      detections.push({ deviceIndex, x: 0, y: 0, confidence: "missing" });
      continue;
    }
    const best = blobs.reduce((a, b) => (b.totalBrightness > a.totalBrightness ? b : a));
    const confidence: DetectionConfidence = best.ambiguous
      ? "ambiguous"
      : best.pixelCount < WEAK_MIN_PIXELS || blobs.length < windowFrames.length / 2
        ? "weak"
        : "ok";
    detections.push({ deviceIndex, x: best.x, y: best.y, confidence });
  }

  // Draw onto a dark reference frame from just after the start marker (before the scan
  // begins) -- the actual install at night looks like this: mostly black, one dot per LED.
  const baseFrame: Frame = extracted.find((f) => f.timestampMs > markerEnd)?.frame ?? extracted[0].frame;
  const annotated: Frame = { width: baseFrame.width, height: baseFrame.height, data: Uint8Array.from(baseFrame.data) };
  for (const d of detections) {
    if (d.confidence === "missing") continue;
    const px = Math.round(d.x * annotated.width);
    const py = Math.round(d.y * annotated.height);
    const dotColor: [number, number, number] = d.confidence === "ok" ? [64, 255, 64] : [255, 200, 0];
    drawDot(annotated, px, py, 2, dotColor);
    drawLabel(annotated, String(d.deviceIndex), px + 4, py - 8, { color: dotColor });
  }

  await writeFile(args.outputImagePath, encodePng(annotated));

  const missingCount = detections.filter((d) => d.confidence === "missing").length;
  const candidateCalibration = args.writeCandidateCalibration && existingMap ? remapDetectionsToCoordinateMap(detections, existingMap) : null;

  return {
    annotatedImagePath: args.outputImagePath,
    imageWidth: annotated.width,
    imageHeight: annotated.height,
    detections,
    missingCount,
    candidateCalibration,
  };
}
