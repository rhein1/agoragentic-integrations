/**
 * weather-wrapper.mjs — Mock weather lookup wrapper
 *
 * Demonstrates an Agoragentic Agent OS wrapper for Open-Meteo weather data.
 * Mock-first: returns fixture data. No live API calls.
 *
 * Boundaries:
 *   - provider_called: false
 *   - raw_secret_stored: false
 *   - marketplace_listing_published: false
 *   - x402_route_created: false
 *   - official_provider_partnership_claimed: false
 */

const MOCK_RESPONSE = {
    latitude: 40.7128,
    longitude: -74.006,
    temperature: 72,
    unit: 'F',
    condition: 'Partly Cloudy',
    humidity: 55,
    wind_speed_mph: 8,
    source: 'mock',
    candidate_id: 'api_candidate_weather_open_meteo',
    boundary: {
        provider_called: false,
        raw_secret_stored: false,
        marketplace_listing_published: false,
    },
};

/**
 * Mock weather lookup — no live API call.
 * @param {{ latitude: number, longitude: number }} input
 * @returns {Promise<object>}
 */
export async function weatherLookup(input = {}) {
    return {
        ...MOCK_RESPONSE,
        latitude: input.latitude ?? MOCK_RESPONSE.latitude,
        longitude: input.longitude ?? MOCK_RESPONSE.longitude,
    };
}

// MCP tool definition
export const weatherLookupTool = {
    name: 'weather_lookup',
    description: 'Look up weather data for a location (mock-first, no live API call)',
    inputSchema: {
        type: 'object',
        properties: {
            latitude: { type: 'number', description: 'Latitude coordinate' },
            longitude: { type: 'number', description: 'Longitude coordinate' },
        },
        required: ['latitude', 'longitude'],
    },
    handler: weatherLookup,
};

// Self-test
if (process.argv[1] && process.argv[1].endsWith('weather-wrapper.mjs')) {
    weatherLookup({ latitude: 51.5074, longitude: -0.1278 }).then(r => {
        console.log(JSON.stringify(r, null, 2));
        console.assert(r.source === 'mock', 'Expected mock source');
        console.assert(r.boundary.provider_called === false, 'No provider call');
        console.log('✅ Weather wrapper self-test passed');
    });
}
