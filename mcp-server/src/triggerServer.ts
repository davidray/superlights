import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as actions from "./actions.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";

// A small always-on HTTP endpoint meant to run somewhere that's never asleep (e.g. the
// same Raspberry Pi as Home Assistant), so HA's own scheduler/automations — which already
// handle time-of-day, sunrise/sunset, and date-range conditions well — can trigger WLED
// scenes without needing WLED's own (JSON-API-inaccessible, date-range-less) timers.

const PORT = Number(process.env.TRIGGER_SERVER_PORT ?? 8788);
const TOKEN = process.env.TRIGGER_SERVER_TOKEN;

if (!TOKEN) {
  console.error("[triggerServer] WARNING: TRIGGER_SERVER_TOKEN is not set — /trigger is unauthenticated. Set it in .env before exposing this beyond localhost.");
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
      const result = await playSceneLive(device, body.scene as string, {
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
  if (req.method !== "POST" || req.url !== "/trigger") {
    return send(res, 404, { ok: false, error: "POST /trigger is the only endpoint" });
  }

  if (TOKEN) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      // Never log the actual secret values -- just enough metadata to tell failure modes apart.
      console.error(
        `[triggerServer] auth mismatch: header ${auth ? "present" : "MISSING"}, ` +
          `starts-with-Bearer=${auth?.startsWith("Bearer ") ?? false}, ` +
          `received-len=${auth?.replace(/^Bearer /, "").length ?? 0}, expected-len=${TOKEN.length}`
      );
      return send(res, 401, { ok: false, error: "missing or invalid Authorization: Bearer <token>" });
    }
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as TriggerBody;
    const result = await handleTrigger(body);
    send(res, 200, result);
  } catch (err) {
    send(res, 400, { ok: false, error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.error(`WLED trigger server listening on http://0.0.0.0:${PORT}${TOKEN ? "" : " (no auth token set)"}`);
});
