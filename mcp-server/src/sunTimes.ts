import * as SunCalc from "suncalc";

/** Returns "HH:MM" (local time, zero-padded) for dusk/dawn on the given date and location. */
export function resolveSunTime(kind: "dusk" | "dawn", date: Date, latitude: number, longitude: number): string {
  const times = SunCalc.getTimes(date, latitude, longitude);
  const t = kind === "dusk" ? times.dusk : times.dawn;
  if (!t) throw new Error(`No ${kind} time for this date/location (likely a polar day/night edge case).`);
  const hours = String(t.getHours()).padStart(2, "0");
  const minutes = String(t.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** A stored onTime/offTime value is either "HH:MM" or the literal "dusk"/"dawn". */
export function resolveTimeValue(value: string, date: Date, latitude: number | undefined, longitude: number | undefined): string {
  if (value !== "dusk" && value !== "dawn") return value;
  if (latitude === undefined || longitude === undefined) {
    throw new Error(`Schedule uses "${value}" but no location (latitude/longitude) is configured.`);
  }
  return resolveSunTime(value, date, latitude, longitude);
}
