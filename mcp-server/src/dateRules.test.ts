import { test } from "node:test";
import assert from "node:assert/strict";
import { nthWeekdayOfMonth, easterDate, resolveDateRule, monthDayFromDate } from "./dateRules.js";

test("nthWeekdayOfMonth: Thanksgiving (4th Thursday of November)", () => {
  assert.equal(monthDayFromDate(nthWeekdayOfMonth(2026, 11, 4, 4)), "11-26");
  assert.equal(monthDayFromDate(nthWeekdayOfMonth(2027, 11, 4, 4)), "11-25");
});

test("nthWeekdayOfMonth: Memorial Day (last Monday of May, n=-1)", () => {
  assert.equal(monthDayFromDate(nthWeekdayOfMonth(2026, 5, 1, -1)), "05-25");
});

test("nthWeekdayOfMonth: Labor Day (first Monday of September)", () => {
  assert.equal(monthDayFromDate(nthWeekdayOfMonth(2026, 9, 1, 1)), "09-07");
});

test("easterDate: known reference years", () => {
  assert.equal(monthDayFromDate(easterDate(2024)), "03-31");
  assert.equal(monthDayFromDate(easterDate(2025)), "04-20");
  assert.equal(monthDayFromDate(easterDate(2026)), "04-05");
});

test("resolveDateRule dispatches nthWeekday vs easter correctly", () => {
  assert.equal(monthDayFromDate(resolveDateRule({ type: "easter" }, 2026)), "04-05");
  assert.equal(
    monthDayFromDate(resolveDateRule({ type: "nthWeekday", month: 11, weekday: 4, n: 4 }, 2026)),
    "11-26"
  );
});
