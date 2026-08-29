import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveTimeValue } from "./sunTimes.js";
import { resolveDateRule, monthDayFromDate, type DateRule } from "./dateRules.js";

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
  defaultSchedule: DefaultSchedule | null;
  windows: HolidayWindow[];
  overrides: Override[];
}

const EMPTY_CONFIG: HolidayScheduleConfig = { location: null, defaultSchedule: null, windows: [], overrides: [] };

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
  if (!existsSync(CONFIG_PATH)) return { ...EMPTY_CONFIG };
  return { ...EMPTY_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
}

export function saveConfig(config: HolidayScheduleConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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

export function setDefaultSchedule(schedule: DefaultSchedule): HolidayScheduleConfig {
  assertTimeValue(schedule.onTime, "onTime");
  assertTimeValue(schedule.offTime, "offTime");
  assertNonEmptyString(schedule.device, "device");
  assertNonEmptyString(schedule.scene, "scene");
  const config = loadConfig();
  config.defaultSchedule = schedule;
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
 * Priority: overrides > holiday windows > default schedule. First match in list order
 * wins within the override/window tiers. Returns null only if nothing applies at all
 * (no match in either tier, and no default schedule configured or enabled).
 */
export function evaluateSchedule(now: Date, config: HolidayScheduleConfig): ActiveRule | null {
  const today = monthDayFromDate(now);
  const todayIso = isoDate(now);
  const location = config.location;

  const activeOverride = config.overrides.find((o) => {
    if (!o.enabled) return false;
    if (o.rule) return monthDayFromDate(resolveDateRule(o.rule, now.getFullYear())) === today;
    return o.recurring ? o.date === today : o.date === todayIso;
  });
  if (activeOverride) {
    return { source: "override", id: activeOverride.id, name: activeOverride.name, device: activeOverride.device, scene: activeOverride.scene, ...resolve(activeOverride, now, location) };
  }

  const activeWindow = config.windows.find((w) => w.enabled && monthDayInRange(today, w.seasonStart, w.seasonEnd));
  if (activeWindow) {
    return { source: "window", id: activeWindow.id, name: activeWindow.name, device: activeWindow.device, scene: activeWindow.scene, ...resolve(activeWindow, now, location) };
  }

  if (config.defaultSchedule?.enabled) {
    const d = config.defaultSchedule;
    return { source: "default", id: "default", name: "Default", device: d.device, scene: d.scene, ...resolve(d, now, location) };
  }

  return null;
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
