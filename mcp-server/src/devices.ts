import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.WLED_DEVICES_CONFIG ?? join(__dirname, "..", "devices.json");

// A bare hostname/IP, optionally with a port -- rejects a scheme (http://), a path
// (/), whitespace, or other characters that could turn a "host" into a different URL
// than the one wledClient.ts's caller intended (SSRF via a crafted host string).
const HOST_PATTERN = /^[a-zA-Z0-9.-]+(:[0-9]+)?$/;

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  const devices = readJsonFile<Record<string, string>>(CONFIG_PATH);
  if (!devices) throw new Error(`Devices config not found at ${CONFIG_PATH}.`);
  cache = devices;
  return cache;
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

export function saveDevice(name: string, host: string): { name: string; host: string }[] {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("Device name is required.");
  }
  if (!host || typeof host !== "string" || !HOST_PATTERN.test(host)) {
    throw new Error(
      `Invalid host "${host}": expected a bare hostname or IP, optionally with ":<port>" (e.g. "192.168.1.50" or "wled.local:80") -- no scheme, path, or whitespace.`
    );
  }
  const devices = { ...load(), [name]: host };
  writeJsonFile(CONFIG_PATH, devices);
  cache = null;
  return listDevices();
}

export function removeDevice(name: string): { name: string; host: string }[] {
  const devices = { ...load() };
  delete devices[name];
  writeJsonFile(CONFIG_PATH, devices);
  cache = null;
  return listDevices();
}
