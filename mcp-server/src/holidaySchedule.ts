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

export function loadConfig(): HolidayScheduleConfig {
  if (!existsSync(CONFIG_PATH)) return { ...EMPTY_CONFIG };
  return { ...EMPTY_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
}

export function saveConfig(config: HolidayScheduleConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function setLocation(location: Location): HolidayScheduleConfig {
  const config = loadConfig();
  config.location = location;
  saveConfig(config);
  return config;
}

export function setDefaultSchedule(schedule: DefaultSchedule): HolidayScheduleConfig {
  const config = loadConfig();
  config.defaultSchedule = schedule;
  saveConfig(config);
  return config;
}

export function upsertWindow(window: HolidayWindow): HolidayScheduleConfig {
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

function monthDay(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${monthDay(date)}`;
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
  const today = monthDay(now);
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
