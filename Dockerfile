# discord-mcp container image. Runs the Streamable HTTP transport as a
# non-root user. The server refuses to start on a non-loopback bind
# without DISCORD_MCP_HTTP_TOKEN, so a container with no token set fails
# fast with a clear message instead of exposing the bot.
#
# Only the bind address is set here. The port is left to the server's own
# default (3414), so an override under either the current DISCORD_MCP_PORT
# or the pre-2.0 OMNICORD_PORT name still takes effect.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN addgroup -S discord-mcp && adduser -S discord-mcp -G discord-mcp
WORKDIR /app
ENV NODE_ENV=production \
    DISCORD_MCP_HTTP_HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER discord-mcp
EXPOSE 3414
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3414/healthz || exit 1
CMD ["node", "dist/index.js", "--http"]
