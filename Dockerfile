# ClipForge — same app as on your laptop, just running on a server.
# ffmpeg comes from Debian (has libass + all the filters we use), so encoding
# happens on CPU unless you build on a host with NVENC.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
# skip the bundled static binaries — we use the system ffmpeg above
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY assets ./assets

ENV NODE_ENV=production \
    PORT=4400 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    HWACCEL=cpu

EXPOSE 4400
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
