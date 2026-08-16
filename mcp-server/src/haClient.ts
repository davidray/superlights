// Minimal Home Assistant REST client — just enough to read/write helper entities
// (input_datetime / input_text / input_boolean / input_number), which is how the
// schedule tools parameterize the generic automations you set up in HA. Not a
// general-purpose HA client; HA's own automation engine does the actual scheduling.

const BASE_URL = process.env.HA_BASE_URL;
const TOKEN = process.env.HA_TOKEN;

function requireConfig(): { baseUrl: string; token: string } {
  if (!BASE_URL || !TOKEN) {
    throw new Error(
      "HA_BASE_URL and HA_TOKEN must be set (in mcp-server/.env) to manage the schedule. " +
        "HA_TOKEN is a long-lived access token from your Home Assistant profile page."
    );
  }
  return { baseUrl: BASE_URL.replace(/\/+$/, ""), token: TOKEN };
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  const { baseUrl, token } = requireConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (err) {
    throw new Error(`Could not reach Home Assistant at ${baseUrl} (${(err as Error).message})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Home Assistant returned HTTP ${res.status} for ${path}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export async function getState(entityId: string): Promise<HaState> {
  return (await call(`/api/states/${entityId}`, { method: "GET" })) as HaState;
}

/** Sets an input_datetime helper's time-of-day (HH:MM or HH:MM:SS), leaving its date untouched. */
export async function setHelperTime(entityId: string, time: string): Promise<void> {
  await call("/api/services/input_datetime/set_datetime", {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId, time }),
  });
}

/** Sets an input_datetime helper's date (MM-DD, year defaults to current), leaving its time untouched. */
export async function setHelperDate(entityId: string, monthDay: string): Promise<void> {
  const year = new Date().getFullYear();
  await call("/api/services/input_datetime/set_datetime", {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId, date: `${year}-${monthDay}` }),
  });
}

export async function setHelperText(entityId: string, value: string): Promise<void> {
  await call("/api/services/input_text/set_value", {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId, value }),
  });
}

export async function setHelperBoolean(entityId: string, on: boolean): Promise<void> {
  await call(`/api/services/input_boolean/turn_${on ? "on" : "off"}`, {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId }),
  });
}
