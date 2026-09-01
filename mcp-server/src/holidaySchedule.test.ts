import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSchedule,
  evaluateScheduleForDevice,
  timeInRange,
  setLocation,
  setDefaultSchedule,
  upsertWindow,
  upsertOverride,
  type HolidayScheduleConfig,
} from "./holidaySchedule.js";

function config(partial: Partial<HolidayScheduleConfig> = {}): HolidayScheduleConfig {
  return {
    location: null,
    defaultSchedules: [{ onTime: "08:00", offTime: "22:00", device: "eaves", scene: "default-scene", enabled: true }],
    windows: [
      {
        id: "christmas",
        name: "Christmas",
        seasonStart: "11-20",
        seasonEnd: "01-05",
        onTime: "08:00",
        offTime: "23:00",
        device: "eaves",
        scene: "candy-cane-chase",
        enabled: true,
      },
    ],
    overrides: [
      { id: "birthday", name: "Birthday", date: "05-08", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "birthday-confetti", enabled: true },
      { id: "game-2026", name: "Game Day", date: "2026-09-05", recurring: false, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "game-day", enabled: true },
      {
        id: "thanksgiving",
        name: "Thanksgiving",
        date: "",
        recurring: false,
        rule: { type: "nthWeekday", month: 11, weekday: 4, n: 4 },
        onTime: "08:00",
        offTime: "22:00",
        device: "eaves",
        scene: "autumn-harvest",
        enabled: true,
      },
    ],
    ...partial,
  };
}

const forEaves = (date: string, c = config()) => evaluateScheduleForDevice("eaves", new Date(date), c);

test("default schedule wins when nothing else matches", () => {
  const result = forEaves("2026-03-01T12:00:00");
  assert.equal(result?.source, "default");
  assert.equal(result?.scene, "default-scene");
});

test("a holiday window beats the default schedule", () => {
  const result = forEaves("2026-12-25T12:00:00");
  assert.equal(result?.source, "window");
  assert.equal(result?.scene, "candy-cane-chase");
});

test("a holiday window wraps correctly across the year boundary", () => {
  const result = forEaves("2027-01-02T12:00:00");
  assert.equal(result?.source, "window");
  assert.equal(result?.id, "christmas");
});

test("an override beats a holiday window, even on a date inside the window", () => {
  const c = config();
  c.overrides.push({ id: "in-window", name: "Special", date: "12-25", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "special-scene", enabled: true });
  const result = forEaves("2026-12-25T12:00:00", c);
  assert.equal(result?.source, "override");
  assert.equal(result?.scene, "special-scene");
});

test("a recurring MM-DD override matches every year", () => {
  assert.equal(forEaves("2026-05-08T12:00:00")?.id, "birthday");
  assert.equal(forEaves("2030-05-08T12:00:00")?.id, "birthday");
});

test("a one-time YYYY-MM-DD override only matches its exact year", () => {
  assert.equal(forEaves("2026-09-05T12:00:00")?.id, "game-2026");
  assert.equal(forEaves("2027-09-05T12:00:00")?.source, "default");
});

test("a rule-based override recalculates per year, ignoring its date field", () => {
  assert.equal(forEaves("2026-11-26T12:00:00")?.id, "thanksgiving");
  assert.equal(forEaves("2027-11-25T12:00:00")?.id, "thanksgiving");
  // Nov 1 is safely outside both Thanksgiving and the Nov 20 - Jan 5 Christmas window.
  assert.equal(forEaves("2026-11-01T12:00:00")?.source, "default");
});

test("a disabled override is skipped entirely", () => {
  const c = config();
  c.overrides[0].enabled = false;
  const result = forEaves("2026-05-08T12:00:00", c);
  assert.equal(result?.source, "default");
});

test("first match wins within a tier (list order)", () => {
  const c = config({
    overrides: [
      { id: "first", name: "First", date: "07-04", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "a", enabled: true },
      { id: "second", name: "Second", date: "07-04", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "b", enabled: true },
    ],
  });
  const result = forEaves("2026-07-04T12:00:00", c);
  assert.equal(result?.id, "first");
});

// --- Multi-device evaluation: each device gets its own winning rule, independently.

function twoDeviceConfig(): HolidayScheduleConfig {
  return config({
    defaultSchedules: [
      { onTime: "08:00", offTime: "22:00", device: "eaves", scene: "default-scene", enabled: true },
      { onTime: "17:00", offTime: "21:00", device: "dragon-lamp", scene: "dragon-fire", enabled: true },
    ],
    windows: [],
    overrides: [],
  });
}

test("evaluateSchedule returns a winning rule per device", () => {
  const rules = evaluateSchedule(new Date("2026-03-01T12:00:00"), twoDeviceConfig());
  assert.equal(rules.length, 2);
  const byDevice = new Map(rules.map((r) => [r.device, r]));
  assert.equal(byDevice.get("eaves")?.scene, "default-scene");
  assert.equal(byDevice.get("dragon-lamp")?.scene, "dragon-fire");
});

test("an override on one device does not preempt another device's schedule", () => {
  const c = twoDeviceConfig();
  c.overrides.push({ id: "lamp-event", name: "Lamp Event", date: "07-04", recurring: true, onTime: "08:00", offTime: "22:00", device: "dragon-lamp", scene: "fireworks", enabled: true });
  const rules = evaluateSchedule(new Date("2026-07-04T12:00:00"), c);
  const byDevice = new Map(rules.map((r) => [r.device, r]));
  assert.equal(byDevice.get("dragon-lamp")?.source, "override");
  assert.equal(byDevice.get("dragon-lamp")?.scene, "fireworks");
  // The eaves keep their own default rule -- the lamp's override is invisible to them.
  assert.equal(byDevice.get("eaves")?.source, "default");
});

test("a window scoped to one device is ignored when evaluating another", () => {
  const c = twoDeviceConfig();
  c.windows.push({
    id: "christmas",
    name: "Christmas",
    seasonStart: "11-20",
    seasonEnd: "01-05",
    onTime: "08:00",
    offTime: "23:00",
    device: "eaves",
    scene: "candy-cane-chase",
    enabled: true,
  });
  assert.equal(evaluateScheduleForDevice("eaves", new Date("2026-12-25T12:00:00"), c)?.source, "window");
  assert.equal(evaluateScheduleForDevice("dragon-lamp", new Date("2026-12-25T12:00:00"), c)?.source, "default");
});

test("evaluateSchedule omits devices with nothing active", () => {
  const c = twoDeviceConfig();
  c.defaultSchedules[1].enabled = false;
  const rules = evaluateSchedule(new Date("2026-03-01T12:00:00"), c);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].device, "eaves");
});

test("timeInRange handles a normal same-day range", () => {
  const now = (h: number, m: number) => new Date(2026, 0, 1, h, m);
  assert.equal(timeInRange(now(10, 0), "08:00", "22:00"), true);
  assert.equal(timeInRange(now(23, 0), "08:00", "22:00"), false);
});

test("timeInRange handles a range that crosses midnight", () => {
  const now = (h: number, m: number) => new Date(2026, 0, 1, h, m);
  assert.equal(timeInRange(now(23, 30), "22:00", "02:00"), true);
  assert.equal(timeInRange(now(1, 0), "22:00", "02:00"), true);
  assert.equal(timeInRange(now(10, 0), "22:00", "02:00"), false);
});

// --- Input validation on the write functions (issue #5: the trigger-server's HTTP
// routes call these directly with raw JSON bodies, bypassing index.ts's zod schemas --
// so these functions need to reject malformed data themselves, regardless of caller.
// These only exercise the validation (which throws before any config file I/O), so
// they don't touch disk.

test("setLocation rejects an out-of-range latitude/longitude", () => {
  assert.throws(() => setLocation({ latitude: 200, longitude: 0 }), /latitude/);
  assert.throws(() => setLocation({ latitude: 0, longitude: -200 }), /longitude/);
});

test("setDefaultSchedule rejects a malformed onTime/offTime", () => {
  assert.throws(
    () => setDefaultSchedule({ onTime: "not-a-time", offTime: "22:00", device: "eaves", scene: "s", enabled: true }),
    /onTime/
  );
  assert.throws(
    () => setDefaultSchedule({ onTime: "08:00", offTime: "22:00", device: "", scene: "s", enabled: true }),
    /device/
  );
});

test("upsertWindow rejects a malformed seasonStart/seasonEnd", () => {
  assert.throws(
    () =>
      upsertWindow({
        id: "w",
        name: "W",
        seasonStart: "November 20",
        seasonEnd: "01-05",
        onTime: "08:00",
        offTime: "22:00",
        device: "eaves",
        scene: "s",
        enabled: true,
      }),
    /seasonStart/
  );
});

test("upsertOverride rejects a malformed date-rule shape", () => {
  assert.throws(
    () =>
      upsertOverride({
        id: "bad-rule",
        name: "Bad Rule",
        date: "",
        recurring: false,
        rule: { type: "nthWeekday", month: 13, weekday: 4, n: 4 },
        onTime: "08:00",
        offTime: "22:00",
        device: "eaves",
        scene: "s",
        enabled: true,
      }),
    /rule\.month/
  );
});

test("upsertOverride rejects a one-time override whose date isn't YYYY-MM-DD", () => {
  assert.throws(
    () =>
      upsertOverride({
        id: "bad-date",
        name: "Bad Date",
        date: "09/05/2026",
        recurring: false,
        onTime: "08:00",
        offTime: "22:00",
        device: "eaves",
        scene: "s",
        enabled: true,
      }),
    /date/
  );
});

test("upsertOverride rejects a recurring override whose date isn't MM-DD", () => {
  assert.throws(
    () =>
      upsertOverride({
        id: "bad-recurring-date",
        name: "Bad Recurring Date",
        date: "2026-05-08",
        recurring: true,
        onTime: "08:00",
        offTime: "22:00",
        device: "eaves",
        scene: "s",
        enabled: true,
      }),
    /date/
  );
});
