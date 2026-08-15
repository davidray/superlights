import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALIBRATION_DIR = process.env.WLED_CALIBRATION_DIR ?? join(__dirname, "..", "calibration");

export interface Waypoint {
  /** LED index within the run (local, matches the WLED segment's own indexing) */
  index: number;
  /** Normalized position relative to the reference photo, 0-1 */
  x: number;
  y: number;
}

export interface Run {
  id: string;
  /** WLED segment id this run corresponds to, for JSON-API control */
  segment: number;
  startIndex: number;
  endIndex: number;
  /** Where this run starts in the device's flat DDP pixel buffer (concatenated across all outputs, in bus order) */
  deviceOffset: number;
  /** Ordered by index; position between waypoints is linearly interpolated */
  waypoints: Waypoint[];
}

export interface CoordinateMap {
  device: string;
  capturedAt: string;
  referenceImage?: string;
  imageWidth?: number;
  imageHeight?: number;
  runs: Run[];
}

export interface LedPosition {
  run: string;
  segment: number;
  index: number;
  deviceIndex: number;
  x: number;
  y: number;
}

export function loadCoordinateMap(device: string): CoordinateMap {
  const path = join(CALIBRATION_DIR, `${device}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`No coordinate map for device "${device}" at ${path}. Run calibration or add a placeholder file there.`);
  }
  return JSON.parse(raw) as CoordinateMap;
}

function interpolate(waypoints: Waypoint[], index: number): { x: number; y: number } {
  if (waypoints.length === 0) throw new Error("Run has no waypoints");
  if (waypoints.length === 1) return { x: waypoints[0].x, y: waypoints[0].y };

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (index >= a.index && index <= b.index) {
      const t = b.index === a.index ? 0 : (index - a.index) / (b.index - a.index);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return index < first.index ? { x: first.x, y: first.y } : { x: last.x, y: last.y };
}

/** Every LED position in a map, sorted by deviceIndex (i.e. DDP/flat-buffer order). */
export function allLedPositions(map: CoordinateMap): LedPosition[] {
  const out: LedPosition[] = [];
  for (const run of map.runs) {
    for (let i = run.startIndex; i <= run.endIndex; i++) {
      const { x, y } = interpolate(run.waypoints, i);
      out.push({ run: run.id, segment: run.segment, index: i, deviceIndex: run.deviceOffset + (i - run.startIndex), x, y });
    }
  }
  return out.sort((a, b) => a.deviceIndex - b.deviceIndex);
}
