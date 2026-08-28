# Superlights

Control WLED-based house lighting from Claude, with a self-hosted scheduler for
holidays, birthdays, and other recurring or one-off events — no cloud service,
no vendor app.

## Architecture

Two processes, one codebase (`mcp-server/`):

- **Local MCP server** (`src/index.ts`) — runs on your own machine via `claude mcp
  add`. This is what Claude talks to directly: designing scenes, previewing
  effects, calibrating devices, managing the schedule.
- **Trigger add-on** (`src/triggerServer.ts`) — a small always-on HTTP server,
  packaged as a Home Assistant add-on, that runs on whatever box is never
  asleep (a Raspberry Pi, an old Mac mini, etc.). It runs the holiday
  scheduler itself and exposes the same scene/schedule/device/calibration
  operations over HTTP, so they keep working even when your laptop is closed.

Both processes share the same source (`liveStreamController.ts`, `scenes.ts`,
`holidaySchedule.ts`, `coordinateMap.ts`, `devices.ts`, ...) — the split is
about *where* each thing runs, not different code.

Scenes render against each LED's real physical position (see **Calibration**
below) and stream over DDP, bypassing WLED's own effect engine entirely.

## Requirements

- A [WLED](https://kno.wled.ge/)-flashed LED controller on your network.
- A Home Assistant instance, for the always-on trigger add-on.
- Node.js, for the local MCP server.
- [Claude Code](https://claude.com/claude-code), to talk to it.

## Setup

Steps 1-2 below need to happen by hand (flashing hardware, installing the
add-on). After that, the MCP server ships a `setup` prompt that walks
through the rest conversationally — registering your device, calibrating
it, and configuring the schedule — checking real state instead of assuming.
Run it any time after step 3.

### 1. Flash WLED

Flash your controller with WLED and note its IP (a DHCP reservation is
recommended, since IPs get baked into config). See the
[WLED docs](https://kno.wled.ge/basics/getting-started/) if you haven't done
this before.

### 2. Install the trigger add-on

In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**,
add this repo's URL. Install **Superlights WLED Trigger**, set a
`trigger_token` in its Configuration tab (any long random string — e.g.
`openssl rand -hex 32`), and start it.

### 3. Set up the local MCP server

```bash
cd mcp-server
npm install
npm run build
cp .env.example .env   # fill in TRIGGER_SERVER_URL (the add-on host + port)
                        # and TRIGGER_SERVER_TOKEN (same value as step 2)
claude mcp add wled-lights -- node "$(pwd)/dist/index.js"
```

### 4. Register your device

Ask Claude to `add_device` with a name and the WLED IP from step 1 — this
writes both the local `devices.json` (used by this MCP server directly) and
the add-on's copy (used for scheduling), so control works from either side.

### 5. Calibrate

Custom scenes (as opposed to WLED's built-in effects) render against each
LED's real physical x/y position on the house, not just its index in the
strip. A device's coordinate map describes this as a list of *runs*
(physical sections, e.g. "lower-roofline") each with a few hand-placed
*waypoints* — positions are linearly interpolated between them. See
`mcp-server/calibration/eaves.json` for a real worked example (this is one
author's actual house, not a template — every layout is different).

The practical process: flash a striped test pattern (e.g. via `set_raw_state`
using the `i` per-LED field) so you can physically count LEDs per run, trace
rough x/y positions from a photo of the house, and save the result with
`set_calibration`. `get_calibration` reads it back.

**A real gotcha to know about going in:** WLED itself has its own configured
total LED count and segment boundaries (visible via `get_device_state`),
*separate* from this coordinate map. If your physical LED count changes (a
recount, an added section), you need to update **both** — WLED's own LED
Preferences (Config → LED Preferences → Length, then reboot) *and* the
coordinate map via `set_calibration`. Miss the WLED side and the extra LEDs
will silently never receive any frames, live or scheduled, regardless of what
the coordinate map says.

## Scheduling model

Three priority tiers, evaluated in order — first match wins:

1. **Overrides** — one-off or recurring single-day events (birthdays,
   anniversaries, a sports schedule). Can be a fixed date, or a `rule` for
   holidays that move every year (`nthWeekday` for Thanksgiving/Memorial
   Day/Labor Day-style holidays, `easter` for the computus calculation).
2. **Holiday windows** — recurring annual date ranges (e.g. Nov 20 – Jan 5
   for Christmas).
3. **Default schedule** — the daily baseline (e.g. dusk to 10:15pm) when
   nothing else applies.

`onTime`/`offTime` accept `"HH:MM"` or the literal `"dusk"`/`"dawn"`, resolved
fresh each evaluation from the configured `latitude`/`longitude`
(`set_schedule_location`). Manage all of this with `list_schedule`,
`set_default_schedule`, `add_holiday_window`/`remove_holiday_window`, and
`add_override`/`remove_override`.

## Scenes

`list_scenes` shows the built-in library (spatially-aware, coded against the
coordinate map). `play_scene_live` runs one by `id` — or, instead of an `id`,
you can pass an inline **scene spec**: a color palette plus a pattern
(`solid`, `wave`, `chase`, `twinkle`, `pulse`, `gradientDrift`) with a few
tunable knobs. This lets you compose a one-off scene from a plain-language
request ("a romantic scene in these colors") with no code change and no
add-on release — it's interpreted live against the same rendering pipeline as
the built-in scenes.

## Security note

The add-on runs with `host_network: true`, binding its HTTP server directly
to the host's network rather than through Docker's usual isolation. Keep it
on your LAN; don't port-forward it to the internet without adding your own
layer in front (a reverse proxy, VPN, etc.) — the bearer-token auth alone
isn't hardened for public exposure.

## License

MIT — see [LICENSE](LICENSE).
