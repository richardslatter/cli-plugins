FROM golang:1.26.8-bookworm AS teams-builder
WORKDIR /build
COPY apps/teams-cli/reader/go.mod apps/teams-cli/reader/go.sum ./
RUN go mod download
COPY apps/teams-cli/reader/ ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /teams-bridge .

FROM node:22.23.1-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/var/data PORT=10000 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY apps/github-cli/install_gh.py apps/notion-cli/install_ntn.py /tmp/install/
RUN python3 /tmp/install/install_gh.py && python3 /tmp/install/install_ntn.py && gh --version && ntn --version && rm -rf /tmp/install
COPY backend/requirements.lock ./backend/requirements.lock
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r backend/requirements.lock
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY backend/ ./backend/
COPY apps/ ./apps/
COPY public/ ./public/
COPY --from=teams-builder /teams-bridge /app/bin/teams-bridge
RUN mkdir -p /var/data && chown node:node /var/data
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 10000
CMD ["node","backend/src/server.mjs"]
