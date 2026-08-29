import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Reads and parses a JSON file, or returns undefined if it doesn't exist. Callers
 *  decide what "missing" means for them (an empty default, a placeholder, an error). */
export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Writes a JSON file, creating its parent directory first if needed. */
export function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
