// Lets the local MCP server (what Claude talks to) manage the holiday schedule,
// devices, and calibration that actually live on the always-on trigger server (the
// HA add-on), over the network -- same routes triggerServer.ts exposes.

const BASE_URL = process.env.TRIGGER_SERVER_URL;
const TOKEN = process.env.TRIGGER_SERVER_TOKEN;

function requireConfig(): { baseUrl: string; token: string } {
  if (!BASE_URL || !TOKEN) {
    throw new Error(
      "TRIGGER_SERVER_URL and TRIGGER_SERVER_TOKEN must be set (in mcp-server/.env) to manage the holiday schedule. " +
        "TRIGGER_SERVER_URL is the always-on host's address, e.g. http://192.168.1.50:8788 -- TRIGGER_SERVER_TOKEN is the same token configured on the trigger add-on."
    );
  }
  return { baseUrl: BASE_URL.replace(/\/+$/, ""), token: TOKEN };
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const { baseUrl, token } = requireConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (err) {
    throw new Error(`Could not reach the trigger server at ${baseUrl} (${(err as Error).message})`);
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new Error(`Trigger server returned HTTP ${res.status} for ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

export const triggerServer = {
  getSchedule: () => call("/schedule", { method: "GET" }),
  setLocation: (location: unknown) => call("/schedule/location", { method: "POST", body: JSON.stringify(location) }),
  setDefaultSchedule: (schedule: unknown) => call("/schedule/default", { method: "POST", body: JSON.stringify(schedule) }),
  upsertWindow: (window: unknown) => call("/schedule/windows", { method: "POST", body: JSON.stringify(window) }),
  removeWindow: (id: string) => call(`/schedule/windows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  upsertOverride: (override: unknown) => call("/schedule/overrides", { method: "POST", body: JSON.stringify(override) }),
  removeOverride: (id: string) => call(`/schedule/overrides/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listDevices: () => call("/devices", { method: "GET" }),
  upsertDevice: (name: string, host: string) => call("/devices", { method: "POST", body: JSON.stringify({ name, host }) }),
  removeDevice: (name: string) => call(`/devices/${encodeURIComponent(name)}`, { method: "DELETE" }),
  getCalibration: (device: string) => call(`/calibration/${encodeURIComponent(device)}`, { method: "GET" }),
  setCalibration: (device: string, map: unknown) =>
    call(`/calibration/${encodeURIComponent(device)}`, { method: "POST", body: JSON.stringify(map) }),
};
