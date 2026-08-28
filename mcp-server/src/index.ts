import "./loadEnv.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listDevices, resolveDevice, saveDevice, removeDevice } from "./devices.js";
import { tryLoadCoordinateMap, saveCoordinateMap, type CoordinateMap } from "./coordinateMap.js";
import { WledClient, findByName, type WledSegment } from "./wledClient.js";
import { parseFxData } from "./fxdata.js";
import { scenes } from "./scenes.js";
import * as actions from "./actions.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";
import { triggerServer } from "./triggerServerClient.js";

const server = new McpServer({ name: "wled-lights", version: "0.1.0" });

function clientFor(device: string): WledClient {
  return new WledClient(resolveDevice(device));
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorText(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Discovery

server.tool("list_devices", "List the WLED devices configured in devices.json, by name.", {}, async () => {
  try {
    return text(listDevices());
  } catch (err) {
    return errorText(err);
  }
});

server.tool(
  "get_device_state",
  "Get a WLED device's current power, brightness, and per-segment state (effect/palette/colors resolved to readable names), plus basic device info (LED count, segment count, firmware version).",
  { device: z.string().describe("Device name, from list_devices") },
  async ({ device }) => {
    try {
      const client = clientFor(device);
      const [state, info, effects, palettes] = await Promise.all([
        client.getState(),
        client.getInfo(),
        client.getEffects(),
        client.getPalettes(),
      ]);
      const segs = Array.isArray(state.seg) ? state.seg : state.seg ? [state.seg] : [];
      const segments = segs.map((s) => ({
        id: s.id,
        start: s.start,
        stop: s.stop,
        on: s.on,
        brightness: s.bri,
        effect: typeof s.fx === "number" ? { id: s.fx, name: effects[s.fx] ?? "?" } : s.fx,
        speed: s.sx,
        intensity: s.ix,
        palette: typeof s.pal === "number" ? { id: s.pal, name: palettes[s.pal] ?? "?" } : s.pal,
        colors: s.col,
      }));
      return text({
        device,
        name: info.name,
        firmware: info.ver,
        ledCount: info.leds?.count,
        power: state.on,
        brightness: state.bri,
        currentPreset: state.ps,
        segments,
      });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "add_device",
  "Register a WLED device by name and IP/hostname. Writes both the local devices.json (used by this MCP server for direct control) and the trigger add-on's copy (used for scheduling), if TRIGGER_SERVER_URL/TOKEN are configured -- a device generally needs to be registered in both places to work end-to-end.",
  { name: z.string(), host: z.string().describe("IP address or hostname, e.g. 192.168.1.50") },
  async ({ name, host }) => {
    try {
      const local = saveDevice(name, host);
      try {
        const remote = await triggerServer.upsertDevice(name, host);
        return text({ local, remote });
      } catch (err) {
        return text({ local, remoteError: `Saved locally, but couldn't reach the trigger add-on: ${(err as Error).message}` });
      }
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "remove_device",
  "Remove a WLED device by name from both the local devices.json and the trigger add-on's copy, if configured.",
  { name: z.string() },
  async ({ name }) => {
    try {
      const local = removeDevice(name);
      try {
        const remote = await triggerServer.removeDevice(name);
        return text({ local, remote });
      } catch (err) {
        return text({ local, remoteError: `Removed locally, but couldn't reach the trigger add-on: ${(err as Error).message}` });
      }
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Effects & palettes catalog

server.tool(
  "list_effects",
  "List all effects available on a WLED device, with their numeric IDs (needed for set_segment) and names.",
  { device: z.string() },
  async ({ device }) => {
    try {
      const effects = await clientFor(device).getEffects();
      return text(effects.map((name, id) => ({ id, name })).filter((e) => e.name !== "RSVD" && e.name !== "-"));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "list_palettes",
  "List all color palettes available on a WLED device, with their numeric IDs and names.",
  { device: z.string() },
  async ({ device }) => {
    try {
      const palettes = await clientFor(device).getPalettes();
      return text(palettes.map((name, id) => ({ id, name })));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "get_effect_info",
  "Get the tunable parameters for a specific effect (speed/intensity/custom slider labels, whether it uses a palette, whether it's 1D/2D/audio-reactive). Useful before calling set_segment with fx/sx/ix/c1/c2/c3 so the values you pick actually mean something for that effect.",
  { device: z.string(), effect: z.union([z.string(), z.number()]).describe("Effect name or numeric ID") },
  async ({ device, effect }) => {
    try {
      const client = clientFor(device);
      const effects = await client.getEffects();
      const id = typeof effect === "number" ? effect : findByName(effects, effect);
      if (id === undefined) return errorText(new Error(`No effect matching "${effect}". Call list_effects first.`));
      const fxdata = await client.getFxData();
      return text({ id, name: effects[id], ...parseFxData(fxdata[id] ?? "") });
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Basic control

server.tool(
  "set_power",
  "Turn a WLED device on, off, or toggle it.",
  { device: z.string(), on: z.union([z.boolean(), z.literal("toggle")]) },
  async ({ device, on }) => {
    try {
      await actions.setPower(device, on);
      return text(`ok`);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "set_brightness",
  "Set overall brightness for a WLED device.",
  { device: z.string(), brightness: z.number().int().min(1).max(255) },
  async ({ device, brightness }) => {
    try {
      await actions.setBrightness(device, brightness);
      return text("ok");
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Scene design

const hexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected a hex color like #FF8800");

server.tool(
  "set_effect",
  "Apply an effect (by name or ID) with speed/intensity/palette/colors to a device. This is the main tool for designing a lighting scene. Omit `segment` to apply to all currently-selected segments; pass a segment id to target just one zone. Use list_effects/list_palettes to see valid names, and get_effect_info to see what speed/intensity/custom sliders actually do for a given effect.",
  {
    device: z.string(),
    effect: z.union([z.string(), z.number()]).describe("Effect name (fuzzy-matched) or numeric ID"),
    segment: z.number().int().min(0).optional().describe("Segment id to target; omit to apply to all selected segments"),
    speed: z.number().int().min(0).max(255).optional(),
    intensity: z.number().int().min(0).max(255).optional(),
    palette: z.union([z.string(), z.number()]).optional().describe("Palette name (fuzzy-matched) or numeric ID"),
    colors: z.array(hexColor).max(3).optional().describe("Up to 3 hex colors, e.g. ['#FF0000', '#00FF00']. Meaning depends on the effect (see get_effect_info)."),
  },
  async ({ device, effect, segment, speed, intensity, palette, colors }) => {
    try {
      const result = await actions.runEffect(device, effect, { segment, speed, intensity, palette, colors });
      return text({ applied: { effect: result.effectName, ...result.applied } });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "set_segment",
  "Directly set any WLED segment fields (advanced/raw control) — e.g. start/stop bounds, grouping/spacing, mirror/reverse, name, per-LED colors. For simple 'apply this effect' use set_effect instead.",
  {
    device: z.string(),
    segment: z.record(z.string(), z.unknown()).describe("A WLED segment object, e.g. {\"id\":0,\"start\":0,\"stop\":300,\"rev\":true}"),
  },
  async ({ device, segment }) => {
    try {
      await clientFor(device).postState({ seg: [segment as WledSegment] });
      return text("ok");
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Presets

server.tool("list_presets", "List saved presets (scenes) on a device.", { device: z.string() }, async ({ device }) => {
  try {
    return text(await clientFor(device).getPresets());
  } catch (err) {
    return errorText(err);
  }
});

server.tool(
  "save_preset",
  "Save the device's current live state as a named preset (scene) in slot 1-250. Design the scene first with set_effect/set_segment/set_brightness, then call this to save it.",
  {
    device: z.string(),
    slot: z.number().int().min(1).max(250),
    name: z.string().max(32),
    includeBrightness: z.boolean().default(true),
    includeBounds: z.boolean().default(true),
    includeSelection: z.boolean().default(true),
  },
  async ({ device, slot, name, includeBrightness, includeBounds, includeSelection }) => {
    try {
      await clientFor(device).postState({
        psave: slot,
        n: name,
        ib: includeBrightness,
        sb: includeBounds,
        sc: includeSelection,
      } as any);
      return text(`Saved preset ${slot}: "${name}"`);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "apply_preset",
  "Activate a saved preset (scene) on a device.",
  { device: z.string(), slot: z.number().int().min(1).max(250), transitionMs: z.number().int().min(0).optional() },
  async ({ device, slot, transitionMs }) => {
    try {
      await actions.applyPreset(device, slot, transitionMs);
      return text("ok");
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "delete_preset",
  "Delete a saved preset from a device.",
  { device: z.string(), slot: z.number().int().min(1).max(250) },
  async ({ device, slot }) => {
    try {
      await clientFor(device).postState({ pdel: slot });
      return text("ok");
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Playlists

server.tool(
  "set_playlist",
  "Play a sequence of saved presets in order, each for a given duration — e.g. cycling through several holiday scenes. Presets must already exist (see save_preset).",
  {
    device: z.string(),
    presetSlots: z.array(z.number().int().min(1).max(250)).min(1),
    durationSeconds: z.union([z.number(), z.array(z.number())]).default(10).describe("Seconds per preset; a single number applies to all"),
    transitionSeconds: z.union([z.number(), z.array(z.number())]).optional(),
    repeat: z.number().int().min(0).default(0).describe("Cycles before stopping; 0 = loop forever"),
    endPresetSlot: z.number().int().min(1).max(250).optional().describe("Preset to switch to once the playlist finishes (ignored if repeat=0)"),
  },
  async ({ device, presetSlots, durationSeconds, transitionSeconds, repeat, endPresetSlot }) => {
    try {
      const toTenths = (s: number | number[]) => (Array.isArray(s) ? s.map((v) => Math.round(v * 10)) : Math.round(s * 10));
      await clientFor(device).postState({
        playlist: {
          ps: presetSlots,
          dur: toTenths(durationSeconds),
          ...(transitionSeconds !== undefined ? { transition: toTenths(transitionSeconds) } : {}),
          repeat,
          ...(endPresetSlot !== undefined ? { end: endPresetSlot } : {}),
        },
      });
      return text("ok");
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Escape hatch

server.tool(
  "set_raw_state",
  "Send a raw JSON object directly to WLED's /json/state endpoint, for anything not covered by the other tools (nightlight, UDP sync, individual per-LED colors via the `i` segment field, etc). Refer to the WLED JSON API docs for the full schema.",
  { device: z.string(), state: z.record(z.string(), z.unknown()) },
  async ({ device, state }) => {
    try {
      const result = await clientFor(device).postState(state as any);
      return text(result ?? "ok");
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Custom scenes (spatially-aware animations, distinct from WLED's built-in effects)
// Rendered against a coordinate map (see calibration/*.json) and streamed live over
// DDP, or previewed by the Mac simulator app via the local preview HTTP server.
// Streaming itself lives in liveStreamController.ts, shared with the HA trigger server.

server.tool(
  "list_scenes",
  "List custom spatially-aware scenes (distinct from WLED's built-in effects — these are authored as code against the device's coordinate map, so they can react to each LED's real physical x/y position). To preview one visually, use the Mac Simulator app. To run one on real hardware, use play_scene_live.",
  {},
  async () => text(scenes.map(({ id, name, description }) => ({ id, name, description })))
);

const rgbChannel = z.number().int().min(0).max(255);
const sceneSpec = z.object({
  name: z.string().optional().describe("Human-readable label for status messages, e.g. 'Date Night'"),
  palette: z.array(z.tuple([rgbChannel, rgbChannel, rgbChannel])).min(1).max(8).describe("1-8 colors as [r,g,b] triples"),
  pattern: z.enum(["solid", "wave", "chase", "twinkle", "pulse", "gradientDrift"]).describe(
    "solid=static color; wave/gradientDrift=smooth drift through the palette (gradientDrift is slower, single-sweep); chase=hard-edged bands cycling through the palette; twinkle=random sparkle over a dim background; pulse=whole-house brightness breathing over a slowly-cycling base color"
  ),
  speed: z.number().positive().optional().describe("Tempo multiplier, default 1"),
  bandWidth: z.number().positive().optional().describe("Fraction of the house per repeating band, for wave/chase — smaller means more bands"),
  direction: z.union([z.literal(1), z.literal(-1)]).optional(),
  sparkleDensity: z.number().min(0).max(1).optional().describe("Fraction of LEDs lit at once, for twinkle. Default 0.12"),
  brightnessMin: z.number().min(0).max(1).optional().describe("Brightness floor for twinkle's background / pulse's breathing range"),
  brightnessMax: z.number().min(0).max(1).optional().describe("Brightness ceiling for pulse's breathing range"),
});

server.tool(
  "play_scene_live",
  "Stream a scene to real WLED hardware in realtime over DDP, bypassing WLED's own effect engine so the scene can use physical LED position. Requires a coordinate map for the device (calibration/<device>.json). Pass either a scene id from list_scenes, or an inline spec (palette + pattern) to compose a one-off scene on the fly — e.g. for a spontaneous request like 'a romantic scene in these colors' — with no code change or release needed. Calls of 20s or less finish before returning; longer or open-ended runs start in the background — use stop_live to cancel those.",
  {
    device: z.string(),
    scene: z.union([z.string().describe("Scene id from list_scenes"), sceneSpec]).describe("A registered scene id, or an inline scene spec"),
    durationSeconds: z.number().positive().optional().describe("Omit to run until stop_live is called"),
    fps: z.number().int().min(1).max(60).default(30),
  },
  async ({ device, scene, durationSeconds, fps }) => {
    try {
      const result = await playSceneLive(device, scene, { durationSeconds, fps });
      if (!result.backgrounded) {
        return text(`Played "${result.scene.name}" on ${device} for ${durationSeconds}s.`);
      }
      return text(
        `Streaming "${result.scene.name}" to ${device} in the background${durationSeconds ? ` for ${durationSeconds}s` : " (call stop_live to cancel)"}.`
      );
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "stop_live",
  "Stop a background live scene stream started by play_scene_live. WLED returns to its own effect engine shortly after streaming stops.",
  { device: z.string() },
  async ({ device }) => text(stopStream(device) ? `Stopped streaming to ${device}.` : `No active stream for ${device}.`)
);

const waypoint = z.object({
  index: z.number().int().describe("LED index local to this run"),
  x: z.number().min(0).max(1).describe("Normalized horizontal position, 0-1"),
  y: z.number().min(0).max(1).describe("Normalized vertical position, 0-1"),
});
const coordinateMapRun = z.object({
  id: z.string().describe("Human-readable run name, e.g. 'lower-roofline'"),
  segment: z.number().int().describe("WLED segment id this run corresponds to"),
  startIndex: z.number().int(),
  endIndex: z.number().int(),
  deviceOffset: z.number().int().describe("Where this run starts in the device's flat DDP pixel buffer"),
  waypoints: z.array(waypoint).min(1).describe("Ordered by index; position between waypoints is linearly interpolated"),
});
const coordinateMap = z.object({
  device: z.string(),
  capturedAt: z.string().describe("Free-text note on how/when this was captured"),
  referenceImage: z.string().optional(),
  imageWidth: z.number().optional(),
  imageHeight: z.number().optional(),
  runs: z.array(coordinateMapRun).min(1),
});

server.tool(
  "get_calibration",
  "Get a device's coordinate map (the physical x/y layout used by custom scenes to react to real LED position). Reads the local calibration/<device>.json used directly by this MCP server. Returns null if the device hasn't been calibrated yet.",
  { device: z.string() },
  async ({ device }) => {
    try {
      return text(tryLoadCoordinateMap(device));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "set_calibration",
  "Save a device's coordinate map (see get_calibration for the shape). Writes both the local calibration/<device>.json (used by this MCP server directly) and the trigger add-on's copy (used for scheduled/ad-hoc scenes), if TRIGGER_SERVER_URL/TOKEN are configured -- a device's calibration generally needs to be saved to both places to work end-to-end.",
  { device: z.string(), map: coordinateMap },
  async ({ device, map }) => {
    try {
      saveCoordinateMap(device, map as CoordinateMap);
      try {
        await triggerServer.setCalibration(device, map);
        return text(`Saved calibration for ${device} locally and on the trigger add-on.`);
      } catch (err) {
        return text(`Saved calibration for ${device} locally, but couldn't reach the trigger add-on: ${(err as Error).message}`);
      }
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Holiday schedule
//
// A small rules engine that runs entirely inside the always-on trigger server (see
// scheduler.ts) -- no Home Assistant automations/helpers involved. Three priority
// tiers, highest first: one-off overrides (special events), holiday windows
// (recurring annual date ranges), default schedule (every other day). onTime/offTime
// accept "HH:MM" or the literal "dusk"/"dawn", resolved daily from the configured
// location. Requires TRIGGER_SERVER_URL and TRIGGER_SERVER_TOKEN in mcp-server/.env.

const timeValue = z.union([z.string().regex(/^\d{2}:\d{2}$/), z.enum(["dusk", "dawn"])]).describe("24h 'HH:MM', or the literal 'dusk'/'dawn' to resolve daily from location");

server.tool(
  "list_schedule",
  "Read the full holiday schedule: location, default schedule, all holiday windows, and all one-off overrides.",
  {},
  async () => {
    try {
      return text(await triggerServer.getSchedule());
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "set_schedule_location",
  "Set the latitude/longitude used to resolve 'dusk'/'dawn' schedule times.",
  { latitude: z.number(), longitude: z.number() },
  async ({ latitude, longitude }) => {
    try {
      return text(await triggerServer.setLocation({ latitude, longitude }));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "set_default_schedule",
  "Set the base everyday schedule (lowest priority — active whenever no holiday window or override applies).",
  {
    onTime: timeValue,
    offTime: timeValue,
    device: z.string(),
    scene: z.string().describe("Name of a custom scene (see list_scenes) to stream live"),
    enabled: z.boolean().default(true),
  },
  async (schedule) => {
    try {
      return text(await triggerServer.setDefaultSchedule(schedule));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "add_holiday_window",
  "Add or update (by id) a recurring annual holiday window — beats the default schedule, loses to any active override.",
  {
    id: z.string().describe("Stable identifier, e.g. 'christmas'. Reuse to update an existing window."),
    name: z.string(),
    seasonStart: z.string().regex(/^\d{2}-\d{2}$/).describe("MM-DD, e.g. '11-20'"),
    seasonEnd: z.string().regex(/^\d{2}-\d{2}$/).describe("MM-DD — may be before seasonStart to wrap the new year, e.g. start=11-20 end=01-05"),
    onTime: timeValue,
    offTime: timeValue,
    device: z.string(),
    scene: z.string(),
    enabled: z.boolean().default(true),
  },
  async (window) => {
    try {
      return text(await triggerServer.upsertWindow(window));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "remove_holiday_window",
  "Remove a holiday window by id.",
  { id: z.string() },
  async ({ id }) => {
    try {
      return text(await triggerServer.removeWindow(id));
    } catch (err) {
      return errorText(err);
    }
  }
);

const dateRule = z.union([
  z.object({
    type: z.literal("nthWeekday"),
    month: z.number().int().min(1).max(12),
    weekday: z.number().int().min(0).max(6).describe("0=Sunday...6=Saturday"),
    n: z.number().int().describe("1=first, 2=second, 3=third, 4=fourth occurrence in the month, -1=last"),
  }),
  z.object({ type: z.literal("easter") }),
]);

server.tool(
  "add_override",
  "Add or update (by id) a one-off special-event override (birthday, anniversary, a specific game day) — highest priority, beats both holiday windows and the default schedule for its date.",
  {
    id: z.string().describe("Stable identifier. Reuse to update an existing override."),
    name: z.string(),
    date: z.string().optional().describe("'YYYY-MM-DD' for a specific one-time date, or 'MM-DD' if recurring is true. Omit if using `rule` instead."),
    recurring: z.boolean().default(false).describe("true for an annual date like a birthday; false for a one-time date like a specific game. Ignored if `rule` is set."),
    rule: dateRule.optional().describe("For holidays that move every year: {type:'nthWeekday', month, weekday, n} for Thanksgiving/Memorial Day/Labor Day, or {type:'easter'}. Computed fresh for the current year; takes precedence over `date`."),
    onTime: timeValue,
    offTime: timeValue,
    device: z.string(),
    scene: z.string(),
    enabled: z.boolean().default(true),
  },
  async (override) => {
    try {
      return text(await triggerServer.upsertOverride({ ...override, date: override.date ?? "" }));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "remove_override",
  "Remove an override by id.",
  { id: z.string() },
  async ({ id }) => {
    try {
      return text(await triggerServer.removeOverride(id));
    } catch (err) {
      return errorText(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
