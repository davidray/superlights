## Superlights WLED Trigger

An always-on HTTP endpoint for controlling WLED-based lighting, and the
scheduler behind it — holidays, birthdays, and other recurring or one-off
events, resolved fresh against dusk/dawn at your location.

This add-on is one half of [Superlights](https://github.com/davidray/superlights):
a Claude-driven lighting control system. It runs the always-on side
(scheduling, and an HTTP API for scenes/devices/calibration); the other half
is a local MCP server that Claude talks to directly. See the main repo's
README for the full setup.
