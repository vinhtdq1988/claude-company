# syntax=docker/dockerfile:1
# Build context: docker/egress-proxy. Allowlist đặt qua EGRESS_ALLOWLIST (mặc định chỉ api.anthropic.com).
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /srv/egress-proxy
COPY proxy.mjs ./proxy.mjs
USER node
EXPOSE 3128
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD node -e "require('net').connect(3128,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "proxy.mjs"]
