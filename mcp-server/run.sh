#!/usr/bin/with-contenv bashio

CONFIG_DIR=/config

# Seed on first run only -- never clobber files edited through the addon_config mount.
[ -f "$CONFIG_DIR/devices.json" ] || cp /app/defaults/devices.json "$CONFIG_DIR/devices.json"
[ -f "$CONFIG_DIR/holidaySchedule.json" ] || cp /app/defaults/holidaySchedule.json "$CONFIG_DIR/holidaySchedule.json"
[ -d "$CONFIG_DIR/calibration" ] || cp -r /app/defaults/calibration "$CONFIG_DIR/calibration"

export TRIGGER_SERVER_TOKEN="$(bashio::config 'trigger_token')"
export TRIGGER_SERVER_PORT="8788"
export WLED_DEVICES_CONFIG="$CONFIG_DIR/devices.json"
export WLED_HOLIDAY_SCHEDULE_CONFIG="$CONFIG_DIR/holidaySchedule.json"
export WLED_CALIBRATION_DIR="$CONFIG_DIR/calibration"

cd /app
exec node dist/triggerServer.js
