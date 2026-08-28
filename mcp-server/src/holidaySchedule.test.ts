import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSchedule, timeInRange, type HolidayScheduleConfig } from "./holidaySchedule.js";

function config(partial: Partial<HolidayScheduleConfig> = {}): HolidayScheduleConfig {
  return {
    location: null,
    defaultSchedule: { onTime: "08:00", offTime: "22:00", device: "eaves", scene: "default-scene", enabled: true },
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

test("default schedule wins when nothing else matches", () => {
  const result = evaluateSchedule(new Date("2026-03-01T12:00:00"), config());
  assert.equal(result?.source, "default");
  assert.equal(result?.scene, "default-scene");
});

test("a holiday window beats the default schedule", () => {
  const result = evaluateSchedule(new Date("2026-12-25T12:00:00"), config());
  assert.equal(result?.source, "window");
  assert.equal(result?.scene, "candy-cane-chase");
});

test("a holiday window wraps correctly across the year boundary", () => {
  const result = evaluateSchedule(new Date("2027-01-02T12:00:00"), config());
  assert.equal(result?.source, "window");
  assert.equal(result?.id, "christmas");
});

test("an override beats a holiday window, even on a date inside the window", () => {
  const c = config();
  c.overrides.push({ id: "in-window", name: "Special", date: "12-25", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "special-scene", enabled: true });
  const result = evaluateSchedule(new Date("2026-12-25T12:00:00"), c);
  assert.equal(result?.source, "override");
  assert.equal(result?.scene, "special-scene");
});

test("a recurring MM-DD override matches every year", () => {
  assert.equal(evaluateSchedule(new Date("2026-05-08T12:00:00"), config())?.id, "birthday");
  assert.equal(evaluateSchedule(new Date("2030-05-08T12:00:00"), config())?.id, "birthday");
});

test("a one-time YYYY-MM-DD override only matches its exact year", () => {
  assert.equal(evaluateSchedule(new Date("2026-09-05T12:00:00"), config())?.id, "game-2026");
  assert.equal(evaluateSchedule(new Date("2027-09-05T12:00:00"), config())?.source, "default");
});

test("a rule-based override recalculates per year, ignoring its date field", () => {
  assert.equal(evaluateSchedule(new Date("2026-11-26T12:00:00"), config())?.id, "thanksgiving");
  assert.equal(evaluateSchedule(new Date("2027-11-25T12:00:00"), config())?.id, "thanksgiving");
  // Nov 1 is safely outside both Thanksgiving and the Nov 20 - Jan 5 Christmas window.
  assert.equal(evaluateSchedule(new Date("2026-11-01T12:00:00"), config())?.source, "default");
});

test("a disabled override is skipped entirely", () => {
  const c = config();
  c.overrides[0].enabled = false;
  const result = evaluateSchedule(new Date("2026-05-08T12:00:00"), c);
  assert.equal(result?.source, "default");
});

test("first match wins within a tier (list order)", () => {
  const c = config({
    overrides: [
      { id: "first", name: "First", date: "07-04", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "a", enabled: true },
      { id: "second", name: "Second", date: "07-04", recurring: true, onTime: "08:00", offTime: "22:00", device: "eaves", scene: "b", enabled: true },
    ],
  });
  const result = evaluateSchedule(new Date("2026-07-04T12:00:00"), c);
  assert.equal(result?.id, "first");
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
