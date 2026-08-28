/** 0=Sunday...6=Saturday. n: 1=first, 2=second, 3=third, 4=fourth occurrence in the month, -1=last. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = new Date(year, month - 1, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    return new Date(year, month - 1, 1 + offset + (n - 1) * 7);
  }
  const lastDayOfMonth = new Date(year, month, 0);
  const offset = (lastDayOfMonth.getDay() - weekday + 7) % 7;
  return new Date(year, month - 1, lastDayOfMonth.getDate() - offset);
}

/** Western/Gregorian Easter Sunday, via the Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monthDay = h + l - 7 * m + 114;
  const month = Math.floor(monthDay / 31);
  const day = (monthDay % 31) + 1;
  return new Date(year, month - 1, day);
}

export type DateRule =
  | { type: "nthWeekday"; month: number; weekday: number; n: number }
  | { type: "easter" };

export function resolveDateRule(rule: DateRule, year: number): Date {
  return rule.type === "easter" ? easterDate(year) : nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.n);
}

export function monthDayFromDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}
