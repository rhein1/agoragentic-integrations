/**
 * currency-wrapper.mjs — Mock currency conversion wrapper
 *
 * Demonstrates an Agoragentic Agent OS wrapper for Frankfurter currency exchange.
 * Mock-first: returns fixture data. No live API calls.
 *
 * Boundaries:
 *   - provider_called: false
 *   - raw_secret_stored: false
 *   - marketplace_listing_published: false
 *   - x402_route_created: false
 *   - official_provider_partnership_claimed: false
 */

const MOCK_RATES = {
    USD_EUR: 0.925,
    USD_GBP: 0.795,
    EUR_USD: 1.081,
    EUR_GBP: 0.859,
    GBP_USD: 1.258,
    GBP_EUR: 1.164,
};

/**
 * Mock currency conversion — no live API call.
 * @param {{ from: string, to: string, amount?: number }} input
 * @returns {Promise<object>}
 */
export async function currencyConversion(input = {}) {
    const from = (input.from || 'USD').toUpperCase();
    const to = (input.to || 'EUR').toUpperCase();
    const amount = input.amount ?? 1;
    const key = `${from}_${to}`;
    const rate = MOCK_RATES[key] ?? 1.0;

    return {
        from,
        to,
        amount,
        converted: Math.round(amount * rate * 100) / 100,
        rate,
        source: 'mock',
        candidate_id: 'api_candidate_currency_frankfurter',
        boundary: {
            provider_called: false,
            raw_secret_stored: false,
            marketplace_listing_published: false,
        },
    };
}

// MCP tool definition
export const currencyConversionTool = {
    name: 'currency_conversion',
    description: 'Convert currency amounts (mock-first, no live API call)',
    inputSchema: {
        type: 'object',
        properties: {
            from: { type: 'string', description: 'Source currency code (e.g. USD)' },
            to: { type: 'string', description: 'Target currency code (e.g. EUR)' },
            amount: { type: 'number', description: 'Amount to convert', default: 1 },
        },
        required: ['from', 'to'],
    },
    handler: currencyConversion,
};

// Self-test
if (process.argv[1] && process.argv[1].endsWith('currency-wrapper.mjs')) {
    currencyConversion({ from: 'USD', to: 'EUR', amount: 100 }).then(r => {
        console.log(JSON.stringify(r, null, 2));
        console.assert(r.source === 'mock', 'Expected mock source');
        console.assert(r.converted === 92.5, 'Expected 92.5');
        console.assert(r.boundary.provider_called === false, 'No provider call');
        console.log('✅ Currency wrapper self-test passed');
    });
}
