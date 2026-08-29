import "./loadEnv.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listDevices, saveDevice, removeDevice } from "./devices.js";
import { tryLoadCoordinateMap, saveCoordinateMap, type CoordinateMap } from "./coordinateMap.js";
import { findByName, type WledSegment } from "./wledClient.js";
import { parseFxData } from "./fxdata.js";
import { scenes } from "./scenes.js";
import * as actions from "./actions.js";
import { clientFor } from "./actions.js";
import { playSceneLive, stopStream } from "./liveStreamController.js";
import { triggerServer } from "./triggerServerClient.js";

const server = new McpServer({ name: "wled-lights", version: "0.1.0" });

// For tools registered with an outputSchema: the SDK requires structuredContent when
// present, and validates it against that schema before it reaches the client. `content`
// is included too, for older clients that only read text.
function structured(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function errorText(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

// Every tool handler below wants the same try/catch -> errorText(err) boilerplate. Wrap
// once here instead of repeating it in each of the ~29 registerTool calls. Generic over
// the handler's exact argument tuple so it transparently supports both the zero-arg
// handlers (tools with no inputSchema) and the (args, extra) handlers (tools with one),
// preserving whatever parameter types registerTool's contextual typing would have given
// the unwrapped handler.
function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult>
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorText(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Setup

server.registerPrompt(
  "setup",
  {
    title: "Set up Superlights",
    description: "Walk through connecting a new WLED device: registering it, calibrating its physical layout, and configuring the schedule.",
  },
  async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Help me get a WLED device set up with this MCP server. Work through this checklist conversationally, one step at a time -- check real state with tools rather than assuming, and don't ask for information you can discover yourself.

1. **Device**: call list_devices. If nothing is configured, or a host is still a "REPLACE_WITH..." placeholder, ask me for a name and the device's IP/hostname (I should have already flashed it with WLED -- if not, point me to https://kno.wled.ge/basics/getting-started/ first), then call add_device. Confirm it responds with get_device_state.

2. **Calibration**: call get_calibration for the device. If it returns null, explain that custom scenes (list_scenes / play_scene_live) render against each LED's real physical position, described as one or more "runs" (physical sections, e.g. a roofline) with a few hand-placed x/y waypoints, linearly interpolated between them -- and that approximate is fine to start (see mcp-server/calibration/eaves.json for a real, admittedly-approximate example). Offer to flash a striped test pattern via set_raw_state's per-LED "i" field so I can physically count LEDs per run, then ask me to roughly describe or photograph the layout so you can estimate waypoints, and save the result with set_calibration.

   Important gotcha to mention if LED counts ever come up: WLED itself has its own configured total LED count and segment boundaries (visible via get_device_state), separate from this coordinate map -- both need to match and stay in sync, or some LEDs will silently never receive frames.

3. **Schedule**: call list_schedule. If location is unset, ask for my latitude/longitude (or a city to estimate from) and call set_schedule_location. If there's no default schedule, ask what the lights should do on a normal day (e.g. "on at dusk, off at 10:15pm", which scene) and call set_default_schedule.

4. Once the basics work, mention (don't necessarily set up yet) that holiday windows, one-off overrides (birthdays, events), and ad-hoc scene specs (an inline palette + pattern for play_scene_live, for one-off requests like "a romantic scene in these colors" with no code change needed) are also available whenever I want them.

Start by checking current state (list_devices, get_calibration, list_schedule) before asking me anything.`,
        },
      },
    ],
  })
);

// ---------------------------------------------------------------------------
// Discovery

server.registerTool(
  "list_devices",
  {
    annotations: { readOnlyHint: true },
    description: "List the WLED devices configured in devices.json, by name.",
    outputSchema: { devices: z.array(z.object({ name: z.string(), host: z.string() })) },
  },
  withErrorHandling(async () => {
    return structured({ devices: listDevices() });
  })
);

// A numeric id resolved to a human-readable name, e.g. {id: 3, name: "Breathe"} for an
// effect/palette -- or the raw fx/pal value passed through unresolved, for the rare case
// WLED reports something other than a plain index (seen with e.g. randomized selection).
const resolvedRef = z.union([z.object({ id: z.number(), name: z.string() }), z.number(), z.string()]);
const deviceSegmentState = z.object({
  id: z.number().optional(),
  start: z.number().optional(),
  stop: z.number().optional(),
  on: z.boolean().optional(),
  brightness: z.number().optional(),
  effect: resolvedRef.optional(),
  speed: z.union([z.number(), z.string()]).optional(),
  intensity: z.union([z.number(), z.string()]).optional(),
  palette: resolvedRef.optional(),
  colors: z.array(z.union([z.array(z.number()), z.string()])).optional(),
});

server.registerTool(
  "get_device_state",
  {
    annotations: { readOnlyHint: true },
    description:
      "Get a WLED device's current power, brightness, and per-segment state (effect/palette/colors resolved to readable names), plus basic device info (LED count, segment count, firmware version).",
    inputSchema: { device: z.string().describe("Device name, from list_devices") },
    outputSchema: {
      device: z.string(),
      name: z.string().optional(),
      firmware: z.string().optional(),
      ledCount: z.number().optional(),
      power: z.union([z.boolean(), z.literal("t")]).optional(),
      brightness: z.number().optional(),
      currentPreset: z.union([z.number(), z.string()]).optional(),
      segments: z.array(deviceSegmentState),
    },
  },
  withErrorHandling(async ({ device }) => {
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
    return structured({
      device,
      name: info.name,
      firmware: info.ver,
      ledCount: info.leds?.count,
      power: state.on,
      brightness: state.bri,
      currentPreset: state.ps,
      segments,
    });
  })
);

const deviceList = z.array(z.object({ name: z.string(), host: z.string() }));
const deviceWriteOutputSchema = {
  local: deviceList.describe("The local devices.json, after this write"),
  remote: deviceList.optional().describe("The trigger add-on's copy, after this write -- omitted if remoteError is set"),
  remoteError: z.string().optional().describe("Set if the local write succeeded but the trigger add-on couldn't be reached"),
};

server.registerTool(
  "add_device",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Register a WLED device by name and IP/hostname. Writes both the local devices.json (used by this MCP server for direct control) and the trigger add-on's copy (used for scheduling), if TRIGGER_SERVER_URL/TOKEN are configured -- a device generally needs to be registered in both places to work end-to-end.",
    inputSchema: { name: z.string(), host: z.string().describe("IP address or hostname, e.g. 192.168.1.50") },
    outputSchema: deviceWriteOutputSchema,
  },
  withErrorHandling(async ({ name, host }) => {
    const local = saveDevice(name, host);
    try {
      const remote = (await triggerServer.upsertDevice(name, host)) as { name: string; host: string }[];
      return structured({ local, remote });
    } catch (err) {
      return structured({ local, remoteError: `Saved locally, but couldn't reach the trigger add-on: ${(err as Error).message}` });
    }
  })
);

server.registerTool(
  "remove_device",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: "Remove a WLED device by name from both the local devices.json and the trigger add-on's copy, if configured.",
    inputSchema: { name: z.string() },
    outputSchema: deviceWriteOutputSchema,
  },
  withErrorHandling(async ({ name }) => {
    const local = removeDevice(name);
    try {
      const remote = (await triggerServer.removeDevice(name)) as { name: string; host: string }[];
      return structured({ local, remote });
    } catch (err) {
      return structured({ local, remoteError: `Removed locally, but couldn't reach the trigger add-on: ${(err as Error).message}` });
    }
  })
);

// ---------------------------------------------------------------------------
// Effects & palettes catalog

server.registerTool(
  "list_effects",
  {
    annotations: { readOnlyHint: true },
    description: "List all effects available on a WLED device, with their numeric IDs (needed for set_segment) and names.",
    inputSchema: { device: z.string() },
    outputSchema: { effects: z.array(z.object({ id: z.number(), name: z.string() })) },
  },
  withErrorHandling(async ({ device }) => {
    const effects = await clientFor(device).getEffects();
    return structured({ effects: effects.map((name, id) => ({ id, name })).filter((e) => e.name !== "RSVD" && e.name !== "-") });
  })
);

server.registerTool(
  "list_palettes",
  {
    annotations: { readOnlyHint: true },
    description: "List all color palettes available on a WLED device, with their numeric IDs and names.",
    inputSchema: { device: z.string() },
    outputSchema: { palettes: z.array(z.object({ id: z.number(), name: z.string() })) },
  },
  withErrorHandling(async ({ device }) => {
    const palettes = await clientFor(device).getPalettes();
    return structured({ palettes: palettes.map((name, id) => ({ id, name })) });
  })
);

server.registerTool(
  "get_effect_info",
  {
    annotations: { readOnlyHint: true },
    description:
      "Get the tunable parameters for a specific effect (speed/intensity/custom slider labels, whether it uses a palette, whether it's 1D/2D/audio-reactive). Useful before calling set_segment with fx/sx/ix/c1/c2/c3 so the values you pick actually mean something for that effect.",
    inputSchema: { device: z.string(), effect: z.union([z.string(), z.number()]).describe("Effect name or numeric ID") },
    outputSchema: {
      id: z.number(),
      name: z.string(),
      raw: z.string().describe("The unparsed WLED fxdata string this was derived from"),
      sliders: z.array(z.object({ key: z.string(), label: z.string() })).describe("Which of sx/ix/c1/c2/c3 this effect uses, and what each one means"),
      checkboxes: z.array(z.object({ key: z.string(), label: z.string() })).describe("Which of o1/o2/o3 this effect uses, and what each one means"),
      colors: z.array(z.string()).describe("Meaning of each slot in set_effect's `colors` array, for this effect"),
      paletteEnabled: z.boolean(),
      flags: z.object({ oneD: z.boolean(), twoD: z.boolean(), audioVolume: z.boolean(), audioFrequency: z.boolean() }),
      defaults: z.record(z.string(), z.string()),
    },
  },
  withErrorHandling(async ({ device, effect }) => {
    const client = clientFor(device);
    // getFxData doesn't depend on the resolved effect id, so fetch it alongside
    // getEffects instead of waiting on effect resolution first.
    const [effects, fxdata] = await Promise.all([client.getEffects(), client.getFxData()]);

    let id: number;
    if (typeof effect === "number") {
      if (!Number.isInteger(effect) || effect < 0 || effect >= effects.length) {
        return errorText(new Error(`Effect id ${effect} is out of range (must be 0-${effects.length - 1}). Call list_effects first.`));
      }
      id = effect;
    } else {
      const found = findByName(effects, effect);
      if (found === undefined) return errorText(new Error(`No effect matching "${effect}". Call list_effects first.`));
      id = found;
    }

    return structured({ id, name: effects[id], ...parseFxData(fxdata[id] ?? "") });
  })
);

// ---------------------------------------------------------------------------
// Basic control

const ok = { ok: z.literal(true) };

server.registerTool(
  "set_power",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description: "Turn a WLED device on, off, or toggle it.",
    inputSchema: { device: z.string(), on: z.union([z.boolean(), z.literal("toggle")]) },
    outputSchema: ok,
  },
  withErrorHandling(async ({ device, on }) => {
    await actions.setPower(device, on);
    return structured({ ok: true });
  })
);

server.registerTool(
  "set_brightness",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: "Set overall brightness for a WLED device.",
    inputSchema: { device: z.string(), brightness: z.number().int().min(1).max(255) },
    outputSchema: ok,
  },
  withErrorHandling(async ({ device, brightness }) => {
    await actions.setBrightness(device, brightness);
    return structured({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Scene design

const hexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected a hex color like #FF8800");

server.registerTool(
  "set_effect",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Apply an effect (by name or ID) with speed/intensity/palette/colors to a device. This is the main tool for designing a lighting scene. Omit `segment` to apply to all currently-selected segments; pass a segment id to target just one zone. Use list_effects/list_palettes to see valid names, and get_effect_info to see what speed/intensity/custom sliders actually do for a given effect.",
    inputSchema: {
      device: z.string(),
      effect: z.union([z.string(), z.number()]).describe("Effect name (fuzzy-matched) or numeric ID"),
      segment: z.number().int().min(0).optional().describe("Segment id to target; omit to apply to all selected segments"),
      speed: z.number().int().min(0).max(255).optional(),
      intensity: z.number().int().min(0).max(255).optional(),
      palette: z.union([z.string(), z.number()]).optional().describe("Palette name (fuzzy-matched) or numeric ID"),
      colors: z.array(hexColor).max(3).optional().describe("Up to 3 hex colors, e.g. ['#FF0000', '#00FF00']. Meaning depends on the effect (see get_effect_info)."),
    },
    outputSchema: {
      applied: z.object({
        effect: z.string().describe("Resolved effect name"),
        fx: z.number().describe("Resolved effect id"),
        sx: z.number().optional().describe("Speed, if set"),
        ix: z.number().optional().describe("Intensity, if set"),
        pal: z.number().optional().describe("Resolved palette id, if set"),
        col: z.array(z.union([z.array(z.number()), z.string()])).optional().describe("Colors, if set"),
      }),
    },
  },
  withErrorHandling(async ({ device, effect, segment, speed, intensity, palette, colors }) => {
    const result = await actions.runEffect(device, effect, { segment, speed, intensity, palette, colors });
    return structured({ applied: { effect: result.effectName, ...result.applied } });
  })
);

server.registerTool(
  "set_segment",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Directly set any WLED segment fields (advanced/raw control) — e.g. start/stop bounds, grouping/spacing, mirror/reverse, name, per-LED colors. For simple 'apply this effect' use set_effect instead.",
    inputSchema: {
      device: z.string(),
      segment: z.record(z.string(), z.unknown()).describe("A WLED segment object, e.g. {\"id\":0,\"start\":0,\"stop\":300,\"rev\":true}"),
    },
    outputSchema: ok,
  },
  withErrorHandling(async ({ device, segment }) => {
    await clientFor(device).postState({ seg: [segment as WledSegment] });
    return structured({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Presets

// WLED preset entries otherwise mirror set_segment/set_raw_state's freeform state shape
// (whatever was live when saved) -- only `n`/`ql` are called out since those are the
// fields callers typically care about (display name, quick-load label).
const presetEntry = z.union([z.null(), z.object({ n: z.string().optional(), ql: z.string().optional() }).catchall(z.unknown())]);

server.registerTool(
  "list_presets",
  {
    annotations: { readOnlyHint: true },
    description: "List saved presets (scenes) on a device.",
    inputSchema: { device: z.string() },
    outputSchema: { presets: z.record(z.string(), presetEntry).describe("Keyed by preset slot number, as a string") },
  },
  withErrorHandling(async ({ device }) => {
    return structured({ presets: await clientFor(device).getPresets() });
  })
);

server.registerTool(
  "save_preset",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description:
      "Save the device's current live state as a named preset (scene) in slot 1-250. Design the scene first with set_effect/set_segment/set_brightness, then call this to save it.",
    inputSchema: {
      device: z.string(),
      slot: z.number().int().min(1).max(250),
      name: z.string().max(32),
      includeBrightness: z.boolean().default(true),
      includeBounds: z.boolean().default(true),
      includeSelection: z.boolean().default(true),
    },
    outputSchema: { ok: z.literal(true), slot: z.number(), name: z.string() },
  },
  withErrorHandling(async ({ device, slot, name, includeBrightness, includeBounds, includeSelection }) => {
    await clientFor(device).postState({
      psave: slot,
      n: name,
      ib: includeBrightness,
      sb: includeBounds,
      sc: includeSelection,
    } as any);
    return structured({ ok: true, slot, name });
  })
);

server.registerTool(
  "apply_preset",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: "Activate a saved preset (scene) on a device.",
    inputSchema: { device: z.string(), slot: z.number().int().min(1).max(250), transitionMs: z.number().int().min(0).optional() },
    outputSchema: ok,
  },
  withErrorHandling(async ({ device, slot, transitionMs }) => {
    await actions.applyPreset(device, slot, transitionMs);
    return structured({ ok: true });
  })
);

server.registerTool(
  "delete_preset",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: "Delete a saved preset from a device.",
    inputSchema: { device: z.string(), slot: z.number().int().min(1).max(250) },
    outputSchema: ok,
  },
  withErrorHandling(async ({ device, slot }) => {
    await clientFor(device).postState({ pdel: slot });
    return structured({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Playlists

server.registerTool(
  "set_playlist",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Play a sequence of saved presets in order, each for a given duration — e.g. cycling through several holiday scenes. Presets must already exist (see save_preset).",
    inputSchema: {
      device: z.string(),
      presetSlots: z.array(z.number().int().min(1).max(250)).min(1),
      durationSeconds: z.union([z.number(), z.array(z.number())]).default(10).describe("Seconds per preset; a single number applies to all"),
      transitionSeconds: z.union([z.number(), z.array(z.number())]).optional(),
      repeat: z.number().int().min(0).default(0).describe("Cycles before stopping; 0 = loop forever"),
      endPresetSlot: z.number().int().min(1).max(250).optional().describe("Preset to switch to once the playlist finishes (ignored if repeat=0)"),
    },
    outputSchema: ok,
  },
  withErrorHandling(async ({ device, presetSlots, durationSeconds, transitionSeconds, repeat, endPresetSlot }) => {
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
    return structured({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Escape hatch

server.registerTool(
  "set_raw_state",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    description:
      "Send a raw JSON object directly to WLED's /json/state endpoint, for anything not covered by the other tools (nightlight, UDP sync, individual per-LED colors via the `i` segment field, etc). Refer to the WLED JSON API docs for the full schema.",
    inputSchema: { device: z.string(), state: z.record(z.string(), z.unknown()) },
    // Freeform by design -- this tool exists precisely for state fields the other tools
    // don't model, so `response` is whatever WLED's /json/state happens to hand back
    // (often the full post-write state, but that varies by firmware version).
    outputSchema: { response: z.unknown().describe("Whatever WLED's /json/state endpoint returned, or `true` if it returned nothing") },
  },
  withErrorHandling(async ({ device, state }) => {
    const result = await clientFor(device).postState(state as any);
    return structured({ response: result ?? true });
  })
);

// ---------------------------------------------------------------------------
// Custom scenes (spatially-aware animations, distinct from WLED's built-in effects)
// Rendered against a coordinate map (see calibration/*.json) and streamed live over
// DDP, or previewed by the Mac simulator app via the local preview HTTP server.
// Streaming itself lives in liveStreamController.ts. NOTE: this MCP server and the HA
// trigger add-on are separate OS processes (see CONTRIBUTING.md) that each get their
// own private in-memory stream state -- it is NOT actually shared between them. A
// stream started by one process can only be stopped/observed by that same process
// directly; play_scene_live/stop_live below best-effort proxy to the other process
// over HTTP (via triggerServerClient.ts) so starting checks for -- and stopping
// reaches -- a stream the other side started, whenever TRIGGER_SERVER_URL is configured.

server.registerTool(
  "list_scenes",
  {
    annotations: { readOnlyHint: true },
    description:
      "List custom spatially-aware scenes (distinct from WLED's built-in effects — these are authored as code against the device's coordinate map, so they can react to each LED's real physical x/y position). Use play_scene_live to run one on real hardware.",
    outputSchema: { scenes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })) },
  },
  withErrorHandling(async () => structured({ scenes: scenes.map(({ id, name, description }) => ({ id, name, description })) }))
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

server.registerTool(
  "play_scene_live",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Stream a scene to real WLED hardware in realtime over DDP, bypassing WLED's own effect engine so the scene can use physical LED position. Requires a coordinate map for the device (calibration/<device>.json). Pass either a scene id from list_scenes, or an inline spec (palette + pattern) to compose a one-off scene on the fly — e.g. for a spontaneous request like 'a romantic scene in these colors' — with no code change or release needed. Calls of 20s or less finish before returning; longer or open-ended runs start in the background — use stop_live to cancel those.",
    inputSchema: {
      device: z.string(),
      scene: z.union([z.string().describe("Scene id from list_scenes"), sceneSpec]).describe("A registered scene id, or an inline scene spec"),
      durationSeconds: z.number().positive().optional().describe("Omit to run until stop_live is called"),
      fps: z.number().int().min(1).max(60).default(30),
    },
    outputSchema: {
      scene: z.string().describe("Name of the scene that started playing"),
      backgrounded: z.boolean().describe("true if still streaming after this call returned -- call stop_live to cancel; false if the call already finished (durationSeconds <= 20)"),
      durationSeconds: z.number().optional().describe("Echoed back from the request, if given"),
    },
  },
  withErrorHandling(async ({ device, scene, durationSeconds, fps }) => {
    // Best-effort: this process can't see a stream the trigger add-on started (see
    // note above), so ask it directly before starting a second, conflicting stream
    // to the same device. If the add-on isn't configured or isn't reachable, proceed
    // anyway -- this check is a courtesy, not a hard dependency.
    try {
      const remote = await triggerServer.streamActive(device);
      if (remote.active) {
        return errorText(
          new Error(`The trigger add-on already has an active stream for "${device}". Stop it first (stop_live also stops the add-on's stream).`)
        );
      }
    } catch {
      // Not configured, or unreachable -- proceed with the local-only check below.
    }
    const result = await playSceneLive(device, scene, { durationSeconds, fps });
    return structured({ scene: result.scene.name, backgrounded: result.backgrounded, ...(durationSeconds !== undefined ? { durationSeconds } : {}) });
  })
);

server.registerTool(
  "stop_live",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Stop a background live scene stream started by play_scene_live, whether it was started from here or (best-effort) from the HA trigger add-on. WLED returns to its own effect engine shortly after streaming stops.",
    inputSchema: { device: z.string() },
    outputSchema: {
      stopped: z.boolean().describe("true if a stream was stopped locally, on the trigger add-on, or both"),
      remoteError: z.string().optional().describe("Set if the trigger add-on couldn't be reached to check for/stop its own stream"),
    },
  },
  withErrorHandling(async ({ device }) => {
    const local = stopStream(device);
    try {
      const remote = await triggerServer.stopScene(device);
      return structured({ stopped: local || remote.stopped });
    } catch (err) {
      return structured({ stopped: local, remoteError: (err as Error).message });
    }
  })
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
const coordinateMap = z
  .object({
    device: z.string(),
    capturedAt: z.string().describe("Free-text note on how/when this was captured"),
    referenceImage: z.string().optional(),
    imageWidth: z.number().optional(),
    imageHeight: z.number().optional(),
    runs: z.array(coordinateMapRun).min(1),
  })
  // Calibration files often carry extra ad-hoc notes (e.g. "placeholder", "note") not
  // in this shape -- allow them through rather than rejecting real calibration data.
  .passthrough();

server.registerTool(
  "get_calibration",
  {
    annotations: { readOnlyHint: true },
    description:
      "Get a device's coordinate map (the physical x/y layout used by custom scenes to react to real LED position). Reads the local calibration/<device>.json used directly by this MCP server. `calibration` is null if the device hasn't been calibrated yet.",
    inputSchema: { device: z.string() },
    outputSchema: { calibration: coordinateMap.nullable() },
  },
  withErrorHandling(async ({ device }) => {
    return structured({ calibration: tryLoadCoordinateMap(device) });
  })
);

server.registerTool(
  "set_calibration",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description:
      "Save a device's coordinate map (see get_calibration for the shape). Writes both the local calibration/<device>.json (used by this MCP server directly) and the trigger add-on's copy (used for scheduled/ad-hoc scenes), if TRIGGER_SERVER_URL/TOKEN are configured -- a device's calibration generally needs to be saved to both places to work end-to-end.",
    inputSchema: { device: z.string(), map: coordinateMap },
    outputSchema: {
      ok: z.literal(true),
      savedRemote: z.boolean().describe("false if the local save succeeded but the trigger add-on couldn't be reached"),
      remoteError: z.string().optional(),
    },
  },
  withErrorHandling(async ({ device, map }) => {
    saveCoordinateMap(device, map as CoordinateMap);
    try {
      await triggerServer.setCalibration(device, map);
      return structured({ ok: true, savedRemote: true });
    } catch (err) {
      return structured({ ok: true, savedRemote: false, remoteError: (err as Error).message });
    }
  })
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

const dateRule = z.union([
  z.object({
    type: z.literal("nthWeekday"),
    month: z.number().int().min(1).max(12),
    weekday: z.number().int().min(0).max(6).describe("0=Sunday...6=Saturday"),
    n: z.number().int().describe("1=first, 2=second, 3=third, 4=fourth occurrence in the month, -1=last"),
  }),
  z.object({ type: z.literal("easter") }),
]);

// Mirrors the individual params add_holiday_window/add_override take, but as the
// object shapes list_schedule actually returns (one holistic read of the config the
// scheduler in scheduler.ts evaluates against).
const scheduleLocation = z.object({ latitude: z.number(), longitude: z.number() });
const defaultScheduleShape = z.object({ onTime: timeValue, offTime: timeValue, device: z.string(), scene: z.string(), enabled: z.boolean() });
const holidayWindowShape = z.object({
  id: z.string(),
  name: z.string(),
  seasonStart: z.string().describe("MM-DD"),
  seasonEnd: z.string().describe("MM-DD — may be before seasonStart to wrap the new year"),
  onTime: timeValue,
  offTime: timeValue,
  device: z.string(),
  scene: z.string(),
  enabled: z.boolean(),
});
const overrideShape = z.object({
  id: z.string(),
  name: z.string(),
  date: z.string().describe("'YYYY-MM-DD', or 'MM-DD' if recurring — empty string if `rule` is set instead"),
  recurring: z.boolean(),
  rule: dateRule.optional(),
  onTime: timeValue,
  offTime: timeValue,
  device: z.string(),
  scene: z.string(),
  enabled: z.boolean(),
});

// Every schedule read/write below returns the full post-write config -- same shape as
// list_schedule -- so callers can see the result of their change without a second round trip.
const scheduleConfigOutputSchema = {
  location: scheduleLocation.nullable(),
  defaultSchedule: defaultScheduleShape.nullable(),
  windows: z.array(holidayWindowShape),
  overrides: z.array(overrideShape),
};

server.registerTool(
  "list_schedule",
  {
    annotations: { readOnlyHint: true },
    description: "Read the full holiday schedule: location, default schedule, all holiday windows, and all one-off overrides.",
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async () => {
    return structured((await triggerServer.getSchedule()) as Record<string, unknown>);
  })
);

server.registerTool(
  "set_schedule_location",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: "Set the latitude/longitude used to resolve 'dusk'/'dawn' schedule times.",
    inputSchema: { latitude: z.number(), longitude: z.number() },
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async ({ latitude, longitude }) => {
    return structured((await triggerServer.setLocation({ latitude, longitude })) as Record<string, unknown>);
  })
);

server.registerTool(
  "set_default_schedule",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: "Set the base everyday schedule (lowest priority — active whenever no holiday window or override applies).",
    inputSchema: {
      onTime: timeValue,
      offTime: timeValue,
      device: z.string(),
      scene: z.string().describe("Name of a custom scene (see list_scenes) to stream live"),
      enabled: z.boolean().default(true),
    },
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async (schedule) => {
    return structured((await triggerServer.setDefaultSchedule(schedule)) as Record<string, unknown>);
  })
);

server.registerTool(
  "add_holiday_window",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: "Add or update (by id) a recurring annual holiday window — beats the default schedule, loses to any active override.",
    inputSchema: {
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
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async (window) => {
    return structured((await triggerServer.upsertWindow(window)) as Record<string, unknown>);
  })
);

server.registerTool(
  "remove_holiday_window",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: "Remove a holiday window by id.",
    inputSchema: { id: z.string() },
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async ({ id }) => {
    return structured((await triggerServer.removeWindow(id)) as Record<string, unknown>);
  })
);

server.registerTool(
  "add_override",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Add or update (by id) a one-off special-event override (birthday, anniversary, a specific game day) — highest priority, beats both holiday windows and the default schedule for its date.",
    inputSchema: {
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
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async (override) => {
    return structured((await triggerServer.upsertOverride({ ...override, date: override.date ?? "" })) as Record<string, unknown>);
  })
);

server.registerTool(
  "remove_override",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: "Remove an override by id.",
    inputSchema: { id: z.string() },
    outputSchema: scheduleConfigOutputSchema,
  },
  withErrorHandling(async ({ id }) => {
    return structured((await triggerServer.removeOverride(id)) as Record<string, unknown>);
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
