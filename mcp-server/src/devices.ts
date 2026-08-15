import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.WLED_DEVICES_CONFIG ?? join(__dirname, "..", "devices.json");

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  cache = JSON.parse(raw);
  return cache!;
}

export function listDevices(): { name: string; host: string }[] {
  const devices = load();
  return Object.entries(devices).map(([name, host]) => ({ name, host }));
}

export function resolveDevice(name: string): string {
  const devices = load();
  const host = devices[name];
  if (!host) {
    const known = Object.keys(devices).join(", ") || "(none configured)";
    throw new Error(`Unknown device "${name}". Configured devices: ${known}`);
  }
  if (host.startsWith("REPLACE_WITH")) {
    throw new Error(
      `Device "${name}" is still a placeholder in devices.json. Edit ${CONFIG_PATH} with its real IP/hostname.`
    );
  }
  return host;
}
