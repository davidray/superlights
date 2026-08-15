import { createServer } from "node:http";
import { scenes, findScene } from "./scenes.js";
import { loadCoordinateMap, allLedPositions } from "./coordinateMap.js";
import { renderFrames } from "./renderFrames.js";

const PORT = Number(process.env.WLED_PREVIEW_PORT ?? 8787);

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/scenes") {
      send(res, 200, scenes.map(({ id, name, description }) => ({ id, name, description })));
      return;
    }

    if (url.pathname === "/coordinate-map") {
      const device = url.searchParams.get("device");
      if (!device) return send(res, 400, { error: "missing ?device=" });
      const map = loadCoordinateMap(device);
      send(res, 200, { ...map, positions: allLedPositions(map) });
      return;
    }

    const framesMatch = url.pathname.match(/^\/scenes\/([^/]+)\/frames$/);
    if (framesMatch) {
      const sceneId = decodeURIComponent(framesMatch[1]);
      const device = url.searchParams.get("device");
      if (!device) return send(res, 400, { error: "missing ?device=" });
      const scene = findScene(sceneId);
      if (!scene) return send(res, 404, { error: `unknown scene "${sceneId}"` });

      const duration = Number(url.searchParams.get("duration") ?? "5");
      const fps = Number(url.searchParams.get("fps") ?? "24");
      if (duration > 30) return send(res, 400, { error: "duration capped at 30s per request; loop client-side for longer previews" });

      const map = loadCoordinateMap(device);
      const frames = renderFrames(map, scene, duration, fps);
      send(res, 200, { scene: scene.id, device, fps, frameCount: frames.length, frames });
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.error(`WLED preview server listening on http://localhost:${PORT}`);
});
