import "./loadEnv.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as actions from "./actions.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";
import type { SceneSpec } from "./sceneSpec.js";
import {
  loadConfig,
  upsertWindow,
  removeWindow,
  upsertOverride,
  removeOverride,
  setLocation,
  setDefaultSchedule,
  type HolidayWindow,
  type Override,
  type Location,
  type DefaultSchedule,
} from "./holidaySchedule.js";
import { startScheduler } from "./scheduler.js";

// A small always-on HTTP endpoint meant to run somewhere that's never asleep (the
// same box as Home Assistant, via this add-on). Two jobs:
//   POST /trigger        -- one-shot commands, for ad-hoc control (HA automations, etc.)
//   /schedule/*          -- manage the holiday-window/override schedule this process
//                           runs itself (see scheduler.ts) -- no HA automation involved.

const PORT = Number(process.env.TRIGGER_SERVER_PORT ?? 8788);
const TOKEN = process.env.TRIGGER_SERVER_TOKEN;

if (!TOKEN) {
  console.error("[triggerServer] WARNING: TRIGGER_SERVER_TOKEN is not set — endpoints are unauthenticated. Set it in .env before exposing this beyond localhost.");
}

interface TriggerBody {
  device: string;
  action: "power" | "brightness" | "preset" | "effect" | "scene" | "stop_scene";
  [key: string]: unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  return JSON.parse(raw) as T;
}

async function handleTrigger(body: TriggerBody): Promise<unknown> {
  const { device, action } = body;
  if (!device) throw new Error("missing 'device'");

  switch (action) {
    case "power":
      await actions.setPower(device, body.on as boolean | "toggle");
      return { ok: true };
    case "brightness":
      await actions.setBrightness(device, body.value as number);
      return { ok: true };
    case "preset":
      await actions.applyPreset(device, body.slot as number, body.transitionMs as number | undefined);
      return { ok: true };
    case "effect": {
      const result = await actions.runEffect(device, body.effect as string | number, {
        segment: body.segment as number | undefined,
        speed: body.speed as number | undefined,
        intensity: body.intensity as number | undefined,
        palette: body.palette as string | number | undefined,
        colors: body.colors as string[] | undefined,
      });
      return { ok: true, appliedEffect: result.effectName };
    }
    case "scene": {
      const result = await playSceneLive(device, body.scene as string | SceneSpec, {
        durationSeconds: body.durationSeconds as number | undefined,
        fps: body.fps as number | undefined,
      });
      return { ok: true, scene: result.scene.name, backgrounded: result.backgrounded };
    }
    case "stop_scene":
      return { ok: true, stopped: stopStream(device) };
    default:
      throw new Error(`unknown action "${action}". Expected one of: power, brightness, preset, effect, scene, stop_scene.`);
  }
}

const server = createServer(async (req, res) => {
  if (TOKEN) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      console.error(
        `[triggerServer] auth mismatch: header ${auth ? "present" : "MISSING"}, ` +
          `starts-with-Bearer=${auth?.startsWith("Bearer ") ?? false}, ` +
          `received-len=${auth?.replace(/^Bearer /, "").length ?? 0}, expected-len=${TOKEN.length}`
      );
      return send(res, 401, { ok: false, error: "missing or invalid Authorization: Bearer <token>" });
    }
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "POST" && url.pathname === "/trigger") {
      return send(res, 200, await handleTrigger(await readJson<TriggerBody>(req)));
    }

    if (req.method === "GET" && url.pathname === "/schedule") {
      return send(res, 200, loadConfig());
    }

    if (req.method === "POST" && url.pathname === "/schedule/location") {
      return send(res, 200, setLocation(await readJson<Location>(req)));
    }

    if (req.method === "POST" && url.pathname === "/schedule/default") {
      return send(res, 200, setDefaultSchedule(await readJson<DefaultSchedule>(req)));
    }

    if (req.method === "POST" && url.pathname === "/schedule/windows") {
      return send(res, 200, upsertWindow(await readJson<HolidayWindow>(req)));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/schedule/windows/")) {
      return send(res, 200, removeWindow(decodeURIComponent(url.pathname.slice("/schedule/windows/".length))));
    }

    if (req.method === "POST" && url.pathname === "/schedule/overrides") {
      return send(res, 200, upsertOverride(await readJson<Override>(req)));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/schedule/overrides/")) {
      return send(res, 200, removeOverride(decodeURIComponent(url.pathname.slice("/schedule/overrides/".length))));
    }

    return send(res, 404, { ok: false, error: "no such route" });
  } catch (err) {
    return send(res, 400, { ok: false, error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.error(`WLED trigger server listening on http://0.0.0.0:${PORT}${TOKEN ? "" : " (no auth token set)"}`);
  startScheduler();
});
