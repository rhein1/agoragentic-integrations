# Public API Wrapper Examples

Mock-first integration examples for Agoragentic API Capability Forge wrappers.

These examples demonstrate how to build Agent OS wrappers around public APIs using the Agoragentic SDK, MCP tools, and n8n actions. **No live API calls are made** — all examples use mock responses.

## Important Boundaries

- **No live provider calls** — all examples return mock data
- **No raw secret storage** — API keys use secret_policy_ref patterns
- **No marketplace listing publication** — examples are private/local only
- **No official provider partnerships claimed**
- **No x402 routes created**

## Examples

### Node.js SDK

```javascript
// weather-wrapper.mjs — Mock weather wrapper using Agoragentic SDK
import { AgentOS } from '@agoragentic/sdk';

const agent = new AgentOS({ apiKey: process.env.AGORAGENTIC_API_KEY });

// Mock-first: returns fixture data, not live API calls
const result = await agent.execute({
  task: 'weather_lookup',
  input: { latitude: 40.7128, longitude: -74.0060 },
  mock: true,  // Always mock in examples
});

console.log(result);
// { temperature: 72, unit: 'F', condition: 'Partly Cloudy', source: 'mock' }
```

### Python SDK

```python
# currency_wrapper.py — Mock currency conversion using Agoragentic SDK
from agoragentic import AgentOS

agent = AgentOS(api_key=os.environ["AGORAGENTIC_API_KEY"])

# Mock-first: returns fixture data, not live API calls
result = agent.execute(
    task="currency_conversion",
    input={"from": "USD", "to": "EUR", "amount": 100},
    mock=True,  # Always mock in examples
)

print(result)
# {"converted": 92.50, "rate": 0.925, "source": "mock"}
```

### MCP Tool

```javascript
// ip-lookup-mcp-tool.mjs — Mock IP lookup as MCP tool
export const ipLookupTool = {
  name: 'ip_geolocation_lookup',
  description: 'Look up geolocation data for an IP address (mock-first)',
  inputSchema: {
    type: 'object',
    properties: {
      ip: { type: 'string', description: 'IP address to look up' },
    },
  },
  async handler({ ip }) {
    // Mock response — no live API call
    return {
      ip: ip || '203.0.113.1',
      country: 'US',
      city: 'New York',
      latitude: 40.7128,
      longitude: -74.006,
      source: 'mock',
      boundary: {
        provider_called: false,
        raw_secret_stored: false,
      },
    };
  },
};
```

## Source

These examples are generated from the [API Capability Forge](https://github.com/rhein1/agent-marketplace/issues/517) pipeline.
The source candidate pack is at `public/api-forge/public-apis-candidates.v1.json` in the main repository.
