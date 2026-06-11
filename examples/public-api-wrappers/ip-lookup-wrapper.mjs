/**
 * ip-lookup-wrapper.mjs — Mock IP geolocation lookup wrapper
 *
 * Demonstrates an Agoragentic Agent OS wrapper for GeoJS IP lookup.
 * Mock-first: returns fixture data. No live API calls.
 *
 * Boundaries:
 *   - provider_called: false
 *   - raw_secret_stored: false
 *   - marketplace_listing_published: false
 *   - x402_route_created: false
 *   - official_provider_partnership_claimed: false
 */

/**
 * Mock IP geolocation lookup — no live API call.
 * @param {{ ip?: string }} input
 * @returns {Promise<object>}
 */
export async function ipLookup(input = {}) {
    return {
        ip: input.ip || '203.0.113.1',
        country: 'US',
        country_code: 'US',
        region: 'New York',
        city: 'New York',
        latitude: 40.7128,
        longitude: -74.006,
        timezone: 'America/New_York',
        isp: 'Example ISP',
        source: 'mock',
        candidate_id: 'api_candidate_ip_geojs',
        boundary: {
            provider_called: false,
            raw_secret_stored: false,
            marketplace_listing_published: false,
        },
    };
}

// MCP tool definition
export const ipLookupTool = {
    name: 'ip_geolocation_lookup',
    description: 'Look up geolocation data for an IP address (mock-first, no live API call)',
    inputSchema: {
        type: 'object',
        properties: {
            ip: { type: 'string', description: 'IP address to look up (omit for caller IP)' },
        },
    },
    handler: ipLookup,
};

// Self-test
if (process.argv[1] && process.argv[1].endsWith('ip-lookup-wrapper.mjs')) {
    ipLookup({ ip: '8.8.8.8' }).then(r => {
        console.log(JSON.stringify(r, null, 2));
        console.assert(r.source === 'mock', 'Expected mock source');
        console.assert(r.boundary.provider_called === false, 'No provider call');
        console.log('✅ IP lookup wrapper self-test passed');
    });
}
