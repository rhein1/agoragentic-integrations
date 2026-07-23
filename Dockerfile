FROM node:20-slim AS build

WORKDIR /app

# Install the audited build toolchain before copying the relay source.
COPY mcp/package.json mcp/package-lock.json* ./mcp/
COPY mcp/scripts/postinstall.js ./mcp/scripts/postinstall.js
RUN cd mcp && npm ci

COPY mcp/mcp-server.js ./mcp/mcp-server.js
COPY mcp/scripts/build.js ./mcp/scripts/build.js
RUN cd mcp && npm run build

FROM node:20-slim

WORKDIR /app

COPY --from=build /app/mcp/dist/mcp-server.cjs ./mcp/dist/mcp-server.cjs
COPY mcp/package.json ./mcp/package.json

# Glama and Docker MCP inspect the bundled server through stdio.
ENTRYPOINT ["node", "mcp/dist/mcp-server.cjs"]
