# syntax=docker/dockerfile:1
# Build context: docker/sandbox-runner. Chạy bằng root nhưng bỏ mọi capability trừ CHOWN, SETUID, SETGID (xem docker-compose.yml).
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
# Công cụ agent cần để build/test mã nguồn. Không có curl/wget; mạng cũng bị cô lập ở tầng Docker.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/lib/sandbox /worktrees
WORKDIR /srv/sandbox-runner
COPY server.mjs ./server.mjs
EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
