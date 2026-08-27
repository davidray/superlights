FROM ghcr.io/home-assistant/base:3.24

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci && npm run build && npm prune --omit=dev

# Defaults only -- seeded into /config on first run by run.sh, never overwritten on
# rebuild, so edits made through the addon_config mount (Config Editor/Studio Code
# Server) persist across updates instead of being baked back to these values.
COPY devices.json holidaySchedule.json ./defaults/
COPY calibration ./defaults/calibration

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
