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
// weather-wrapper.mjs — mock-first weather wrapper shape
async function mockWeatherLookup({ latitude, longitude }) {
  return {
    latitude,
    longitude,
    condition: 'clear',
    temperature_c: 22,
    source: 'mock',
    boundary: {
      provider_called: false,
      live_execute_called: false,
      spend_authorized: false,
    },
  };
}

const result = await mockWeatherLookup({ latitude: 40.7128, longitude: -74.0060 });
console.log(result);
```

### Python SDK

```python
# currency_wrapper.py — mock-first currency wrapper shape
def mock_currency_conversion(payload):
    return {
        "from": payload["from"],
        "to": payload["to"],
        "amount": payload["amount"],
        "converted": 92.0,
        "source": "mock",
        "boundary": {
            "provider_called": False,
            "live_execute_called": False,
            "spend_authorized": False,
        },
    }

result = mock_currency_conversion({"from": "USD", "to": "EUR", "amount": 100})
print(result)
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
