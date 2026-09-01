import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveTimeValue } from "./sunTimes.js";
import { resolveDateRule, monthDayFromDate, type DateRule } from "./dateRules.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.WLED_HOLIDAY_SCHEDULE_CONFIG ?? join(__dirname, "..", "holidaySchedule.json");

/** HH:MM (24h), or the literal "dusk"/"dawn" to resolve daily from location. */
export type TimeValue = string;

export interface DefaultSchedule {
  onTime: TimeValue;
  offTime: TimeValue;
  device: string;
  scene: string;
  enabled: boolean;
}

export interface HolidayWindow {
  id: string;
  name: string;
  /** MM-DD, annual recurring. May wrap the new year (e.g. 11-20 -> 01-05). */
  seasonStart: string;
  seasonEnd: string;
  onTime: TimeValue;
  offTime: TimeValue;
  device: string;
  scene: string;
  enabled: boolean;
}

export interface Override {
  id: string;
  name: string;
  /**
   * YYYY-MM-DD for a one-time date, or MM-DD if recurring is true. Ignored if `rule`
   * is set -- `rule` takes precedence for holidays that move every year (Thanksgiving,
   * Memorial Day, Labor Day, Easter), computed fresh for the current year each time.
   */
  date: string;
  recurring: boolean;
  rule?: DateRule;
  onTime: TimeValue;
  offTime: TimeValue;
  device: string;
  scene: string;
  enabled: boolean;
}

export interface Location {
  latitude: number;
  longitude: number;
}

export interface HolidayScheduleConfig {
  location: Location | null;
  /** At most one per device — see setDefaultSchedule, which upserts by device. */
  defaultSchedules: DefaultSchedule[];
  windows: HolidayWindow[];
  overrides: Override[];
}

const EMPTY_CONFIG: HolidayScheduleConfig = { location: null, defaultSchedules: [], windows: [], overrides: [] };

// Mirrors the formats index.ts's zod schemas enforce for the equivalent MCP tools --
// applied here too so triggerServer.ts's HTTP handlers (which write these objects
// directly from raw JSON, bypassing that zod validation) can't persist malformed
// schedule data.
const TIME_VALUE_PATTERN = /^\d{2}:\d{2}$/;
const MONTH_DAY_PATTERN = /^\d{2}-\d{2}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required.`);
  }
}

function assertTimeValue(value: TimeValue, field: string): void {
  if (value !== "dusk" && value !== "dawn" && (typeof value !== "string" || !TIME_VALUE_PATTERN.test(value))) {
    throw new Error(`Invalid ${field} "${value}": expected "HH:MM", "dusk", or "dawn".`);
  }
}

function assertDateRule(rule: DateRule): void {
  if (rule.type === "easter") return;
  if (rule.type !== "nthWeekday") {
    throw new Error(`Invalid rule type "${(rule as { type: string }).type}": expected "nthWeekday" or "easter".`);
  }
  if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) {
    throw new Error(`Invalid rule.month ${rule.month}: must be an integer 1-12.`);
  }
  if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
    throw new Error(`Invalid rule.weekday ${rule.weekday}: must be an integer 0-6 (0=Sunday).`);
  }
  if (!Number.isInteger(rule.n)) {
    throw new Error(`Invalid rule.n ${rule.n}: must be an integer.`);
  }
}

export function loadConfig(): HolidayScheduleConfig {
  // `defaultSchedule` (singular, one object) is the pre-multi-device shape. A running
  // add-on's persistent storage can still hold it, so migrate on read; the next
  // saveConfig writes the array shape and the legacy key disappears.
  const raw = readJsonFile<Partial<HolidayScheduleConfig> & { defaultSchedule?: DefaultSchedule | null }>(CONFIG_PATH) ?? {};
  const { defaultSchedule: legacy, ...rest } = raw;
  const config = { ...EMPTY_CONFIG, ...rest };
  if (legacy && !raw.defaultSchedules?.length) config.defaultSchedules = [legacy];
  return config;
}

export function saveConfig(config: HolidayScheduleConfig): void {
  writeJsonFile(CONFIG_PATH, config);
}

export function setLocation(location: Location): HolidayScheduleConfig {
  if (typeof location.latitude !== "number" || !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
    throw new Error(`Invalid latitude ${location.latitude}: must be a number between -90 and 90.`);
  }
  if (typeof location.longitude !== "number" || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
    throw new Error(`Invalid longitude ${location.longitude}: must be a number between -180 and 180.`);
  }
  const config = loadConfig();
  config.location = location;
  saveConfig(config);
  return config;
}

/** Upserts by device — each device gets at most one default schedule. */
export function setDefaultSchedule(schedule: DefaultSchedule): HolidayScheduleConfig {
  assertTimeValue(schedule.onTime, "onTime");
  assertTimeValue(schedule.offTime, "offTime");
  assertNonEmptyString(schedule.device, "device");
  assertNonEmptyString(schedule.scene, "scene");
  const config = loadConfig();
  const i = config.defaultSchedules.findIndex((d) => d.device === schedule.device);
  if (i >= 0) config.defaultSchedules[i] = schedule;
  else config.defaultSchedules.push(schedule);
  saveConfig(config);
  return config;
}

export function removeDefaultSchedule(device: string): HolidayScheduleConfig {
  const config = loadConfig();
  config.defaultSchedules = config.defaultSchedules.filter((d) => d.device !== device);
  saveConfig(config);
  return config;
}

export function upsertWindow(window: HolidayWindow): HolidayScheduleConfig {
  assertNonEmptyString(window.id, "id");
  assertNonEmptyString(window.name, "name");
  if (typeof window.seasonStart !== "string" || !MONTH_DAY_PATTERN.test(window.seasonStart)) {
    throw new Error(`Invalid seasonStart "${window.seasonStart}": expected "MM-DD".`);
  }
  if (typeof window.seasonEnd !== "string" || !MONTH_DAY_PATTERN.test(window.seasonEnd)) {
    throw new Error(`Invalid seasonEnd "${window.seasonEnd}": expected "MM-DD".`);
  }
  assertTimeValue(window.onTime, "onTime");
  assertTimeValue(window.offTime, "offTime");
  assertNonEmptyString(window.device, "device");
  assertNonEmptyString(window.scene, "scene");
  const config = loadConfig();
  const i = config.windows.findIndex((w) => w.id === window.id);
  if (i >= 0) config.windows[i] = window;
  else config.windows.push(window);
  saveConfig(config);
  return config;
}

export function removeWindow(id: string): HolidayScheduleConfig {
  const config = loadConfig();
  config.windows = config.windows.filter((w) => w.id !== id);
  saveConfig(config);
  return config;
}

export function upsertOverride(override: Override): HolidayScheduleConfig {
  assertNonEmptyString(override.id, "id");
  assertNonEmptyString(override.name, "name");
  if (override.rule) {
    assertDateRule(override.rule);
  } else if (override.recurring) {
    if (typeof override.date !== "string" || !MONTH_DAY_PATTERN.test(override.date)) {
      throw new Error(`Invalid date "${override.date}": a recurring override needs "MM-DD".`);
    }
  } else {
    if (typeof override.date !== "string" || !ISO_DATE_PATTERN.test(override.date)) {
      throw new Error(`Invalid date "${override.date}": a one-time override needs "YYYY-MM-DD".`);
    }
  }
  assertTimeValue(override.onTime, "onTime");
  assertTimeValue(override.offTime, "offTime");
  assertNonEmptyString(override.device, "device");
  assertNonEmptyString(override.scene, "scene");
  const config = loadConfig();
  const i = config.overrides.findIndex((o) => o.id === override.id);
  if (i >= 0) config.overrides[i] = override;
  else config.overrides.push(override);
  saveConfig(config);
  return config;
}

export function removeOverride(id: string): HolidayScheduleConfig {
  const config = loadConfig();
  config.overrides = config.overrides.filter((o) => o.id !== id);
  saveConfig(config);
  return config;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${monthDayFromDate(date)}`;
}

/** Handles ranges that cross the new year (e.g. start=11-20, end=01-05). */
function monthDayInRange(today: string, start: string, end: string): boolean {
  if (start <= end) return start <= today && today <= end;
  return today >= start || today <= end;
}

export interface ActiveRule {
  source: "override" | "window" | "default";
  id: string;
  name: string;
  /** Already resolved to HH:MM for `now` -- "dusk"/"dawn" have been looked up. */
  onTime: string;
  offTime: string;
  device: string;
  scene: string;
}

function resolve(rule: { onTime: TimeValue; offTime: TimeValue }, now: Date, location: Location | null) {
  return {
    onTime: resolveTimeValue(rule.onTime, now, location?.latitude, location?.longitude),
    offTime: resolveTimeValue(rule.offTime, now, location?.latitude, location?.longitude),
  };
}

/**
 * The winning rule for one device. Priority: overrides > holiday windows > default
 * schedule, considering only rules targeting `device`. First match in list order wins
 * within the override/window tiers. Returns null if nothing applies for this device.
 */
export function evaluateScheduleForDevice(device: string, now: Date, config: HolidayScheduleConfig): ActiveRule | null {
  const today = monthDayFromDate(now);
  const todayIso = isoDate(now);
  const location = config.location;

  const activeOverride = config.overrides.find((o) => {
    if (!o.enabled || o.device !== device) return false;
    if (o.rule) return monthDayFromDate(resolveDateRule(o.rule, now.getFullYear())) === today;
    return o.recurring ? o.date === today : o.date === todayIso;
  });
  if (activeOverride) {
    return { source: "override", id: activeOverride.id, name: activeOverride.name, device: activeOverride.device, scene: activeOverride.scene, ...resolve(activeOverride, now, location) };
  }

  const activeWindow = config.windows.find((w) => w.enabled && w.device === device && monthDayInRange(today, w.seasonStart, w.seasonEnd));
  if (activeWindow) {
    return { source: "window", id: activeWindow.id, name: activeWindow.name, device: activeWindow.device, scene: activeWindow.scene, ...resolve(activeWindow, now, location) };
  }

  const d = config.defaultSchedules.find((s) => s.enabled && s.device === device);
  if (d) {
    return { source: "default", id: "default", name: "Default", device: d.device, scene: d.scene, ...resolve(d, now, location) };
  }

  return null;
}

/**
 * The winning rule for every device that has one — devices schedule independently, so
 * (unlike before multi-device support) a rule on one device never preempts another
 * device's schedule. Empty if nothing applies anywhere.
 */
export function evaluateSchedule(now: Date, config: HolidayScheduleConfig): ActiveRule[] {
  const devices = new Set<string>([
    ...config.overrides.map((o) => o.device),
    ...config.windows.map((w) => w.device),
    ...config.defaultSchedules.map((d) => d.device),
  ]);
  const rules: ActiveRule[] = [];
  for (const device of devices) {
    const rule = evaluateScheduleForDevice(device, now, config);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** Whether the current clock time falls within [onTime, offTime), handling a window that crosses midnight. */
export function timeInRange(now: Date, onTime: string, offTime: string): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [onH, onM] = onTime.split(":").map(Number);
  const [offH, offM] = offTime.split(":").map(Number);
  const onMinutes = onH * 60 + onM;
  const offMinutes = offH * 60 + offM;
  if (onMinutes <= offMinutes) return nowMinutes >= onMinutes && nowMinutes < offMinutes;
  return nowMinutes >= onMinutes || nowMinutes < offMinutes;
}
