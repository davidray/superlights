export interface WledSegment {
  id?: number;
  start?: number;
  stop?: number;
  len?: number;
  n?: string;
  grp?: number;
  spc?: number;
  of?: number;
  on?: boolean;
  bri?: number;
  sel?: boolean;
  col?: (number[] | string)[];
  fx?: number | string;
  sx?: number | string;
  ix?: number | string;
  pal?: number | string;
  rev?: boolean;
  mi?: boolean;
  c1?: number;
  c2?: number;
  c3?: number;
  [key: string]: unknown;
}

export interface WledState {
  on?: boolean | "t";
  bri?: number;
  transition?: number;
  ps?: number | string;
  psave?: number;
  sb?: boolean;
  ib?: boolean;
  sc?: boolean;
  pdel?: number;
  mainseg?: number;
  v?: boolean;
  seg?: WledSegment[] | WledSegment;
  playlist?: {
    ps: number[];
    dur?: number | number[];
    transition?: number | number[];
    repeat?: number;
    end?: number;
  };
  nl?: {
    on?: boolean;
    dur?: number;
    mode?: number;
    tbri?: number;
  };
  [key: string]: unknown;
}

export interface WledInfo {
  ver: string;
  name: string;
  fxcount: number;
  palcount: number;
  leds: { count: number; maxseg: number; maxpwr: number; pwr: number };
  [key: string]: unknown;
}

async function req(baseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const url = `http://${baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Could not reach WLED device at ${baseUrl} (${(err as Error).message}). Is it powered on and on the network?`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WLED at ${baseUrl} returned HTTP ${res.status} for ${path}: ${body}`);
  }
  return res.json();
}

export class WledClient {
  constructor(private baseUrl: string) {}

  async getFullJson(): Promise<{ state: WledState; info: WledInfo; effects: string[]; palettes: string[] }> {
    return (await req(this.baseUrl, "/json")) as any;
  }

  async getState(): Promise<WledState> {
    return (await req(this.baseUrl, "/json/state")) as WledState;
  }

  async getInfo(): Promise<WledInfo> {
    return (await req(this.baseUrl, "/json/info")) as WledInfo;
  }

  async postState(state: WledState): Promise<unknown> {
    return req(this.baseUrl, "/json/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
  }

  async getEffects(): Promise<string[]> {
    return (await req(this.baseUrl, "/json/eff")) as string[];
  }

  async getPalettes(): Promise<string[]> {
    return (await req(this.baseUrl, "/json/pal")) as string[];
  }

  async getFxData(): Promise<string[]> {
    return (await req(this.baseUrl, "/json/fxdata")) as string[];
  }

  async getPresets(): Promise<Record<string, unknown>> {
    return (await req(this.baseUrl, "/presets.json")) as Record<string, unknown>;
  }
}

export function findByName(names: string[], query: string): number | undefined {
  const lower = query.trim().toLowerCase();
  const exact = names.findIndex((n) => n.toLowerCase() === lower);
  if (exact >= 0) return exact;
  const partial = names.findIndex((n) => n.toLowerCase().includes(lower));
  return partial >= 0 ? partial : undefined;
}
