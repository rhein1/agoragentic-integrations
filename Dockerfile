FROM node:18-slim

WORKDIR /app

# Copy MCP server files
COPY mcp/package.json mcp/package-lock.json* ./mcp/
RUN cd mcp && npm install --production

COPY mcp/ ./mcp/

# Glama inspects the server by running it via stdio
ENTRYPOINT ["node", "mcp/mcp-server.js"]
