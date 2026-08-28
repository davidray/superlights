# Contributing

This is a small hobby project, but the same conventions matter whether you're
extending it by hand or through an AI coding assistant. Most of the existing
code was built with [Claude Code](https://claude.com/claude-code) — the last
section documents the workflow that's worked well.

## Dev setup

Follow the README's steps 1-3. For pure code changes you don't need the add-on
running — `npm run build` is enough to type-check. You do need a real add-on
(or a local `npm run trigger`) to exercise the scheduler or `/trigger` HTTP
routes end-to-end, and real WLED hardware to see anything actually light up.

## Architecture conventions

- **Two processes, one codebase.** `src/index.ts` (local MCP server) and
  `src/triggerServer.ts` (the always-on add-on) share most of their code —
  the split is about where something runs, not different logic.
- **New tool + remote route pattern.** Anything that needs to be manageable
  both locally and on the always-on add-on follows this shape: MCP tool in
  `index.ts` (zod schema) → HTTP client method in `triggerServerClient.ts` →
  route in `triggerServer.ts`'s route list → read/write functions in the
  relevant domain module (`holidaySchedule.ts`, `devices.ts`,
  `coordinateMap.ts`). Follow the existing tools (`add_holiday_window`,
  `add_device`, `set_calibration`) as templates.
- **Scenes.** The streaming loop only ever calls `Scene.render(ctx, t): RGB`
  at runtime — `id`/`name`/`description` are just metadata for `list_scenes`
  and status messages. A new *pattern* (genuinely new rendering math) belongs
  in `scenes.ts` (compiled in) or `sceneSpec.ts` (parameterized, data-driven).
  Prefer expressing a one-off ask as a `sceneSpec` palette+pattern combo over
  writing a new `scenes.ts` entry — it needs no release.

## The deploy loop

- Code under `mcp-server/src/` that `triggerServer.ts` imports (transitively)
  is server-side: it only takes effect once you bump `config.yaml`'s
  `version` and the add-on is updated in Home Assistant (triggering a Docker
  rebuild). `index.ts` and `triggerServerClient.ts` are local-only — no
  version bump, just `npm run build`.
- A running Claude Code session's MCP tool definitions are a snapshot from
  when it connected. If you change a tool's schema or behavior, either start
  a fresh session to actually call it through the tools, or bypass that
  during development by `curl`-ing the add-on's HTTP routes directly (same
  routes `triggerServerClient.ts` calls), using `TRIGGER_SERVER_URL`/
  `TRIGGER_SERVER_TOKEN` from `.env`.
- **Two copies of `devices.json`/`calibration/*.json` exist**: the local one
  under `mcp-server/` and the add-on's live copy under its `addon_config`
  mount. `add_device`/`set_calibration` write both; editing files by hand
  means keeping both in sync yourself.
- **WLED has its own configured LED count and segment boundaries**, entirely
  separate from the coordinate map in `calibration/*.json`. Changing a
  device's LED count means updating both.

## Verifying changes

- `npm test` (build + run the suite) — covers the pure-logic modules:
  `dateRules.ts` (movable-holiday math), `holidaySchedule.ts`'s
  `evaluateSchedule` (the 3-tier priority resolution), and `sceneSpec.ts`
  (the pattern interpreter). Add cases here for any change to that logic —
  this is what CI runs on every push/PR.
- Note: `node --test dist` (bare directory) can hang on this project — it
  ends up loading `index.ts`/`triggerServer.ts` as a side effect, and
  `triggerServer.ts` opens a listening socket that never closes. Always run
  against an explicit glob (`node --test dist/*.test.js`, i.e. `npm test`)
  instead.
- For logic not yet covered by the suite, a quick Node script importing
  straight from `mcp-server/dist/*.js` (write in, read back, assert) is
  still faster than round-tripping through a real device — consider adding
  it as a real `*.test.ts` instead, though, so it doesn't have to be redone
  next time.
- For anything that needs actual hardware, prefer a short, bounded live test
  (a few seconds of a live scene, a round-trip write+read against a
  throwaway device/calibration name) over guessing from code review alone —
  the test suite can't cover this part.

## Working with Claude Code on this repo

A pattern that's worked well building this:

- For anything non-trivial — a new tool, a new route, a schema change, more
  than a one-file fix — ask for a plan before code gets written. Claude
  Code's plan mode explores the relevant files, proposes a concrete
  approach referencing the conventions above, and waits for approval before
  touching anything.
- Once a plan's approved, it's reasonable to let it drive the whole loop
  autonomously — implement, build, verify, bump the version if needed,
  commit, and push — checking in mainly before the push itself, or before
  anything that touches the live add-on or real hardware directly. ("Set
  this up and drive it" works as a prompt for exactly that.)
- Point it at this file and the README at the start of a session — both
  describe the actual conventions in use, not aspirational ones.
