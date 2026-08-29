import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALIBRATION_DIR = process.env.WLED_CALIBRATION_DIR ?? join(__dirname, "..", "calibration");
const RESOLVED_CALIBRATION_DIR = resolve(CALIBRATION_DIR);

/**
 * Builds the on-disk path for a device's calibration file, rejecting any device name
 * that could escape the calibration directory (path traversal via "/", "\", ".."), or
 * whose resolved path ends up outside it regardless. Applied here, at the point the
 * device name is first accepted, so it's safe no matter which caller passes it through
 * (including the trigger server's decoded URL path segment).
 */
function calibrationPath(device: string): string {
  if (!device || typeof device !== "string" || device.includes("/") || device.includes("\\") || device.includes("..")) {
    throw new Error(`Invalid device name "${device}": must not contain "/", "\\", or "..".`);
  }
  const path = join(CALIBRATION_DIR, `${device}.json`);
  const resolvedPath = resolve(path);
  if (resolvedPath !== RESOLVED_CALIBRATION_DIR && !resolvedPath.startsWith(RESOLVED_CALIBRATION_DIR + sep)) {
    throw new Error(`Invalid device name "${device}": resolves outside the calibration directory.`);
  }
  return path;
}

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
  const path = calibrationPath(device);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`No coordinate map for device "${device}" at ${path}. Run calibration or add a placeholder file there.`);
  }
  return JSON.parse(raw) as CoordinateMap;
}

/** Returns null if no coordinate map exists yet for this device, instead of throwing. */
export function tryLoadCoordinateMap(device: string): CoordinateMap | null {
  try {
    return loadCoordinateMap(device);
  } catch {
    return null;
  }
}

/**
 * Mirrors the bounds index.ts's set_calibration zod schema enforces (waypoints.min(1),
 * x/y in 0-1), so a caller that bypasses the MCP layer's zod validation (e.g. the
 * trigger server's HTTP route) can't write a malformed coordinate map.
 */
function validateCoordinateMap(map: CoordinateMap): void {
  if (!map || typeof map !== "object") throw new Error("Coordinate map must be an object.");
  if (!Array.isArray(map.runs) || map.runs.length === 0) {
    throw new Error("Coordinate map must include at least one run.");
  }
  for (const run of map.runs) {
    if (!Array.isArray(run.waypoints) || run.waypoints.length === 0) {
      throw new Error(`Run "${run.id}" must include at least one waypoint.`);
    }
    for (const wp of run.waypoints) {
      if (typeof wp.x !== "number" || wp.x < 0 || wp.x > 1 || typeof wp.y !== "number" || wp.y < 0 || wp.y > 1) {
        throw new Error(`Run "${run.id}" has a waypoint with x/y outside the 0-1 range (got x=${wp.x}, y=${wp.y}).`);
      }
    }
  }
}

export function saveCoordinateMap(device: string, map: CoordinateMap): void {
  const path = calibrationPath(device);
  validateCoordinateMap(map);
  mkdirSync(CALIBRATION_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2));
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
