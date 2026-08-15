const BASE_URL = "http://localhost:8787";

export interface SceneMeta {
  id: string;
  name: string;
  description: string;
}

export interface LedPosition {
  run: string;
  segment: number;
  index: number;
  deviceIndex: number;
  x: number;
  y: number;
}

export interface CoordinateMapResponse {
  device: string;
  referenceImage?: string;
  positions: LedPosition[];
}

export interface Frame {
  tSeconds: number;
  colors: [number, number, number][];
}

export interface FramesResponse {
  scene: string;
  device: string;
  fps: number;
  frameCount: number;
  frames: Frame[];
}

class PreviewServerUnreachableError extends Error {
  constructor() {
    super("Can't reach the preview server on localhost:8787. Run `npm run preview` in mcp-server/ first.");
  }
}

async function get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new PreviewServerUnreachableError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Preview server returned HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const previewServer = {
  scenes: () => get<SceneMeta[]>("/scenes"),
  coordinateMap: (device: string) => get<CoordinateMapResponse>("/coordinate-map", { device }),
  frames: (device: string, sceneId: string, duration: number, fps: number) =>
    get<FramesResponse>(`/scenes/${encodeURIComponent(sceneId)}/frames`, {
      device,
      duration: String(duration),
      fps: String(fps),
    }),
};
