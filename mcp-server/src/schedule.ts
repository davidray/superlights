import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ha from "./haClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.WLED_SCHEDULE_CONFIG ?? join(__dirname, "..", "schedule.json");

export interface ScheduleEntityMap {
  onTime: string;
  offTime: string;
  seasonStart: string;
  seasonEnd: string;
  scene: string;
  enabled: string;
}

let cache: ScheduleEntityMap | null = null;

function entityMap(): ScheduleEntityMap {
  if (cache) return cache;
  cache = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return cache!;
}

export interface ScheduleUpdate {
  onTime?: string; // "HH:MM"
  offTime?: string; // "HH:MM"
  seasonStart?: string; // "MM-DD"
  seasonEnd?: string; // "MM-DD"
  scene?: string;
  enabled?: boolean;
}

export interface ScheduleSnapshot {
  onTime?: string;
  offTime?: string;
  seasonStart?: string;
  seasonEnd?: string;
  scene?: string;
  enabled?: boolean;
}

/** Applies only the fields provided; each maps to one HA helper entity (see schedule.json). */
export async function setSchedule(update: ScheduleUpdate): Promise<void> {
  const map = entityMap();
  const jobs: Promise<void>[] = [];
  if (update.onTime !== undefined) jobs.push(ha.setHelperTime(map.onTime, update.onTime));
  if (update.offTime !== undefined) jobs.push(ha.setHelperTime(map.offTime, update.offTime));
  if (update.seasonStart !== undefined) jobs.push(ha.setHelperDate(map.seasonStart, update.seasonStart));
  if (update.seasonEnd !== undefined) jobs.push(ha.setHelperDate(map.seasonEnd, update.seasonEnd));
  if (update.scene !== undefined) jobs.push(ha.setHelperText(map.scene, update.scene));
  if (update.enabled !== undefined) jobs.push(ha.setHelperBoolean(map.enabled, update.enabled));
  if (jobs.length === 0) throw new Error("No schedule fields provided to update.");
  await Promise.all(jobs);
}

export async function getSchedule(): Promise<ScheduleSnapshot> {
  const map = entityMap();
  const [onTime, offTime, seasonStart, seasonEnd, scene, enabled] = await Promise.all([
    ha.getState(map.onTime).catch(() => undefined),
    ha.getState(map.offTime).catch(() => undefined),
    ha.getState(map.seasonStart).catch(() => undefined),
    ha.getState(map.seasonEnd).catch(() => undefined),
    ha.getState(map.scene).catch(() => undefined),
    ha.getState(map.enabled).catch(() => undefined),
  ]);
  return {
    onTime: onTime?.state,
    offTime: offTime?.state,
    seasonStart: seasonStart?.state,
    seasonEnd: seasonEnd?.state,
    scene: scene?.state,
    enabled: enabled ? enabled.state === "on" : undefined,
  };
}
