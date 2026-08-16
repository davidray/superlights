#!/usr/bin/with-contenv bashio

export TRIGGER_SERVER_TOKEN="$(bashio::config 'trigger_token')"
export TRIGGER_SERVER_PORT="8788"

cd /app
exec node dist/triggerServer.js
