# Changelog

Versions here match `config.yaml`'s `version` — every bump is server-side code
(`triggerServer.ts` or something it imports) that only takes effect once the
add-on rebuilds. Local-only changes (`index.ts`, `triggerServerClient.ts`)
don't need a bump and aren't listed here.

## 0.10.1

- Version-only bump, no functional change — HA's Supervisor wasn't picking up
  the 0.10.0 update, so this nudges it to notice.

## 0.10.0

- Schedule multiple devices independently. Rules were previously evaluated to a
  single global winner, so at most one device could ever be on: a rule for one
  device (e.g. a new lamp) would preempt another's schedule (e.g. the house)
  and turn it off. Rules are now evaluated per device — each device gets its
  own winner through the same three priority tiers, and the scheduler
  reconciles every device each tick. `defaultSchedule` (one global) becomes
  `defaultSchedules` (one per device, upserted by device); an existing config
  file in the old shape is migrated automatically on first read. Adds
  `remove_default_schedule` and `DELETE /schedule/default/<device>`. One
  device failing to transition (unplugged, mid-reboot) no longer blocks the
  others.

## 0.9.0

- Fix `roofline-sparkle` rendering as a solid blue house: the blue-white tint
  was applied to every LED (off pixels included), leaving a constant blue
  floor. Off pixels are now true black, sparkles are about half as bright,
  denser (with a base density so ground-level runs participate too), and fade
  in/out on per-LED clocks instead of snapping at 8 fps.

## 0.8.0

- Add a watchdog that force-stops any duration-bound live scene if it outlives
  its own stop timer by more than 30s — a backstop against whatever caused a
  scene to keep streaming for hours past its configured duration.

## 0.7.0

- Add six new `play_scene_live` scene-spec patterns: `fireworks`, `comet`,
  `rain`, `bounce`, `aurora`, `strobe`.

## 0.6.0

- **Security:** reject calibration paths that escape the calibration directory
  (path traversal), reject device hosts that aren't a bare hostname/IP (SSRF),
  compare the bearer token in constant time, and enforce on the HTTP trigger
  API the same input validation the MCP tools already enforce (brightness/
  preset/effect bounds, schedule window/override formats).
- Fix the scheduler leaving a device's stream/power on indefinitely when the
  active rule hands off to a different device.
- Fix a race where a short scene's deferred stop could kill a longer scene
  that had since replaced it on the same device.
- Add a best-effort check/stop so a live scene started from one process (the
  local MCP server or this add-on) can be noticed and stopped from the other.
- Remove the `byu-game-day` built-in scene in favor of a documented inline
  scene-spec example (see the main README's "Impromptu scenes" section).
- Reuse DDP frame buffers instead of allocating fresh ones every frame;
  parallelize independent WLED HTTP calls.
- Dedupe HTTP-client and JSON-config-store boilerplate; centralize MCP tool
  error handling; remove dead code.

## 0.5.0

- Add device and calibration management tools (`add_device`, `remove_device`,
  `get_calibration`, `set_calibration`), writing to both the local config and
  this add-on.

## 0.4.0

- `play_scene_live` accepts an inline palette+pattern spec (`solid`, `wave`,
  `chase`, `twinkle`, `pulse`, `gradientDrift`) instead of only a registered
  scene id, so a one-off scene request needs no code change.

## 0.3.1

- Add the `byu-game-day` scene. (Removed in 0.6.0.)

## 0.3.0

- Support rule-based (movable) holiday dates — nth-weekday-of-month and
  Easter — instead of only fixed `MM-DD` dates.

## 0.2.2

- Add new holiday scenes.

## 0.2.1

- Add the birthday scene.

## 0.2.0

- Replace Home Assistant helper-entity/automation scheduling with a
  self-hosted scheduler (`scheduler.ts`, ticking every 30s) against a JSON
  config, three priority tiers — override beats holiday window beats default
  schedule. HA Core no longer makes any scheduling decisions; this add-on
  does.

## 0.1.4

- Log auth-mismatch diagnostics (header presence, length) without exposing
  the actual token, for debugging trigger-token mismatches.

## 0.1.3

- Move `devices.json`/`holidaySchedule.json`/`calibration/*.json` out of the
  Docker image and into the add-on's persistent config storage, seeded once
  on first run — editable afterward without a rebuild.

## 0.1.2

- No code change — version bump only, to force a rebuild that picks up a
  corrected `devices.json`.

## 0.1.1

- No code change — version bump only, to surface an update prompt in the Home
  Assistant add-on store.

## 0.1.0

- Initial release: the trigger server packaged as a Home Assistant add-on.
