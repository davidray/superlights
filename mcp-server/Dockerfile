FROM ghcr.io/home-assistant/base:3.24

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY devices.json schedule.json ./
COPY calibration ./calibration

RUN npm ci && npm run build && npm prune --omit=dev

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
