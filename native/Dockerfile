# The upstream Lingxi code is MIT-licensed and pinned to a reviewed commit.
# This is an embedded engine; no separate original-gateway deployment is required.
FROM node:22-alpine AS upstream
RUN apk add --no-cache git ca-certificates
RUN mkdir -p /src/lingxi && cd /src/lingxi \
  && git init -q && git remote add origin https://github.com/chaos-cl/lingxi-gateway.git \
  && git fetch --depth 1 origin df76aa618dfe8c3999e9ede7e76211eae36e701f \
  && git checkout -q --detach FETCH_HEAD \
  && rm -rf .git

FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs child.mjs ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY --from=upstream /src/lingxi/gateway ./vendor/lingxi-gateway/gateway
COPY --from=upstream /src/lingxi/package.json ./vendor/lingxi-gateway/package.json
COPY --from=upstream /src/lingxi/LICENSE ./vendor/lingxi-gateway/LICENSE
RUN addgroup -S -g 10001 app && adduser -S -D -H -u 10001 -G app app \
  && mkdir -p /app/data && chown app:app /app/data
# Explicitly remove the original unprotected admin HTML; internal admin API still authenticates.
RUN node -e 'const fs=require("fs");const p="/app/vendor/lingxi-gateway/gateway/app.mjs";let s=fs.readFileSync(p,"utf8");const n="if (req.method === \"GET\" && (path === \"/admin\" || path === \"/panel\")) {";if(!s.includes(n))throw new Error("Upstream admin guard changed; review before building");fs.writeFileSync(p,s.replace(n,n.replace("if (","if (false && ")));'
# Git may checkout code using umask 077. This image must be readable by uid 10001.
RUN chmod -R a+rX /app/server.mjs /app/child.mjs /app/package.json /app/lib /app/public /app/scripts /app/vendor \
  && su app -s /bin/sh -c 'node --check /app/server.mjs'
USER app
ENV NODE_ENV=production DATA_DIR=/app/data HOST=127.0.0.1 PORT=8323 COOKIE_SECURE=1
CMD ["node", "server.mjs"]
