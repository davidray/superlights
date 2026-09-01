import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These exercise the real on-disk read/write path (loadConfig's legacy-shape
// migration, setDefaultSchedule's per-device upsert), so unlike
// holidaySchedule.test.ts they need a real config file. CONFIG_PATH is resolved from
// the env at module load, hence the dynamic import after pointing it at a temp file
// -- this works because the node:test runner gives each test file its own process.
const dir = mkdtempSync(join(tmpdir(), "superlights-schedule-"));
const configPath = join(dir, "holidaySchedule.json");
process.env.WLED_HOLIDAY_SCHEDULE_CONFIG = configPath;
const { loadConfig, setDefaultSchedule, removeDefaultSchedule } = await import("./holidaySchedule.js");

const legacyDefault = { onTime: "dusk", offTime: "22:15", device: "eaves", scene: "warm-white", enabled: true };

function writeLegacyConfig(): void {
  writeFileSync(configPath, JSON.stringify({ location: null, defaultSchedule: legacyDefault, windows: [], overrides: [] }));
}

test("loadConfig migrates the legacy singular defaultSchedule into defaultSchedules", () => {
  writeLegacyConfig();
  const config = loadConfig();
  assert.deepEqual(config.defaultSchedules, [legacyDefault]);
  assert.equal("defaultSchedule" in config, false);
});

test("loadConfig treats a legacy defaultSchedule: null as no defaults", () => {
  writeFileSync(configPath, JSON.stringify({ location: null, defaultSchedule: null, windows: [], overrides: [] }));
  assert.deepEqual(loadConfig().defaultSchedules, []);
});

test("the first write after migration persists the new shape and drops the legacy key", () => {
  writeLegacyConfig();
  setDefaultSchedule({ onTime: "17:00", offTime: "21:00", device: "dragon-lamp", scene: "dragon-fire", enabled: true });
  const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
  assert.equal("defaultSchedule" in onDisk, false);
  assert.equal(onDisk.defaultSchedules.length, 2);
  assert.deepEqual(onDisk.defaultSchedules[0], legacyDefault);
});

test("setDefaultSchedule upserts by device instead of appending duplicates", () => {
  writeLegacyConfig();
  setDefaultSchedule({ ...legacyDefault, offTime: "23:00" });
  const config = loadConfig();
  assert.equal(config.defaultSchedules.length, 1);
  assert.equal(config.defaultSchedules[0].offTime, "23:00");
});

test("removeDefaultSchedule removes only the named device's default", () => {
  writeLegacyConfig();
  setDefaultSchedule({ onTime: "17:00", offTime: "21:00", device: "dragon-lamp", scene: "dragon-fire", enabled: true });
  const config = removeDefaultSchedule("eaves");
  assert.deepEqual(config.defaultSchedules.map((d) => d.device), ["dragon-lamp"]);
});
