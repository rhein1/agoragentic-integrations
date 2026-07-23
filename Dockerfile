FROM node:18-slim

WORKDIR /app

# Copy package metadata and the lifecycle script before the locked install.
COPY mcp/package.json mcp/package-lock.json* ./mcp/
COPY mcp/scripts/postinstall.js ./mcp/scripts/postinstall.js
RUN cd mcp && npm ci --omit=dev

COPY mcp/ ./mcp/

# Glama inspects the server by running it via stdio
ENTRYPOINT ["node", "mcp/mcp-server.js"]
