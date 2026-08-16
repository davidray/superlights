import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listDevices, resolveDevice } from "./devices.js";
import { WledClient, findByName, type WledSegment } from "./wledClient.js";
import { parseFxData } from "./fxdata.js";
import { scenes } from "./scenes.js";
import * as actions from "./actions.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";
import { getSchedule, setSchedule } from "./schedule.js";

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

server.tool(
  "play_scene_live",
  "Stream a custom scene to real WLED hardware in realtime over DDP, bypassing WLED's own effect engine so the scene can use physical LED position. Requires a coordinate map for the device (calibration/<device>.json). Calls of 20s or less finish before returning; longer or open-ended runs start in the background — use stop_live to cancel those.",
  {
    device: z.string(),
    scene: z.string().describe("Scene id from list_scenes"),
    durationSeconds: z.number().positive().optional().describe("Omit to run until stop_live is called"),
    fps: z.number().int().min(1).max(60).default(30),
  },
  async ({ device, scene: sceneId, durationSeconds, fps }) => {
    try {
      const result = await playSceneLive(device, sceneId, { durationSeconds, fps });
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

// ---------------------------------------------------------------------------
// Schedule (delegated to Home Assistant — see mcp-server/schedule.json)
//
// WLED's own timers can't be reached over its API and have no date-range concept, so the
// actual scheduling engine is Home Assistant: a handful of generic automations there read
// their timing from a few helper entities instead of hardcoded values, and these two tools
// just read/write those helpers over HA's REST API. Requires HA_BASE_URL and HA_TOKEN.

server.tool(
  "get_schedule",
  "Read the current lighting schedule (on/off times, holiday date range, which scene, and whether the schedule is enabled at all) from Home Assistant's helper entities.",
  {},
  async () => {
    try {
      return text(await getSchedule());
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "set_schedule",
  "Update the lighting schedule by writing to Home Assistant's helper entities. Only the fields you provide are changed. Requires the generic schedule automations to already be set up in HA (see mcp-server/deploy).",
  {
    onTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("24h HH:MM, e.g. '17:30'"),
    offTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("24h HH:MM"),
    seasonStart: z.string().regex(/^\d{2}-\d{2}$/).optional().describe("MM-DD, e.g. '11-20' — current year is assumed"),
    seasonEnd: z.string().regex(/^\d{2}-\d{2}$/).optional().describe("MM-DD"),
    scene: z.string().optional().describe("Name of a WLED preset, effect, or custom scene for the automation to apply"),
    enabled: z.boolean().optional().describe("Turn the whole schedule on/off without touching its other settings"),
  },
  async (update) => {
    try {
      await setSchedule(update);
      return text({ updated: update, current: await getSchedule() });
    } catch (err) {
      return errorText(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
