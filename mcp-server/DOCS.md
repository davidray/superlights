# Documentation

## What this does

Two things, both always-on:

1. **A scheduler** that decides what should be running on your WLED devices
   right now, re-evaluated on a timer. Three priority tiers — a one-off or
   recurring **override** (a birthday, an event) beats a recurring annual
   **holiday window**, which beats the daily **default schedule**. Times can
   be fixed (`"22:15"`) or resolve daily from your location (`"dusk"`,
   `"dawn"`).
2. **An HTTP API** for everything else: triggering a scene or effect
   on-demand, and managing devices/calibration/schedule — the same
   operations the paired local MCP server exposes to Claude, available here
   too so they keep working when nothing else is running.

## Configuration

| Option | Description |
|---|---|
| `trigger_token` | Bearer token required on every request (`Authorization: Bearer <token>`). Generate one with `openssl rand -hex 32` — don't leave it as `changeme`. |

## Setup

This add-on doesn't do anything useful by itself — pair it with the local MCP
server from the same repo, pointed at this add-on's address and the token
above (`TRIGGER_SERVER_URL`/`TRIGGER_SERVER_TOKEN` in its `.env`). See the
[main repo README](https://github.com/davidray/superlights) for the full
walkthrough, including flashing WLED, registering a device, and calibrating
its physical layout.

## Configuration storage

`devices.json`, `holidaySchedule.json`, and `calibration/*.json` live under
this add-on's own config storage, seeded once from the repo's committed
examples on first run and never overwritten afterward — so anything you (or
the MCP tools) change here persists across updates.

## Security

This add-on runs with host networking rather than Docker's usual isolation,
so its HTTP API binds directly to your Home Assistant host. Keep it on your
LAN; the bearer-token check isn't hardened for exposure to the internet.
