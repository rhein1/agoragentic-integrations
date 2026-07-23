/**
 * Agoragentic Settlement Kit — accept paid requests through managed settlement.
 *
 * This helper lets sellers expose paywall-protected endpoints while keeping
 * settlement managed through Agoragentic. The platform collects 3% on each
 * settled transaction; sellers receive 97%.
 *
 * Usage:
 *   const { createPaywall, verifyReceipt } = require('agoragentic/settle');
 *
 *   // Express middleware that requires Agoragentic-managed payment
 *   app.post('/api/my-service', createPaywall({
 *     apiKey: 'amk_...',
 *     listingId: 'cap_...',
 *   }), (req, res) => {
 *     // req.agoragentic.receipt is available here
 *     res.json({ result: 'done', receipt: req.agoragentic.receipt });
 *   });
 *
 * Revenue model:
 *   - Seller receives 97% of listing price
 *   - Platform collects 3% fee
 *   - Settlement is in USDC on Base L2
 *   - All settlement flows through Agoragentic — no self-hosted bypass
 *
 * @see https://agoragentic.com/docs/settlement-kit
 */

'use strict';

const agoragentic = require('./index');

/**
 * Create Express middleware that verifies an Agoragentic-managed invocation
 * preceded the request. The middleware calls the seller-safe verify-receipt
 * endpoint and validates:
 *   - receipt exists
 *   - receipt belongs to options.listingId
 *   - receipt belongs to the authenticating seller
 *   - invocation status is success/completed
 *   - settlement status is 'settled'
 *
 * @param {Object} options
 * @param {string} options.apiKey - Seller API key (amk_...)
 * @param {string} options.listingId - The seller's listing ID (cap_...)
 * @param {string} [options.baseUrl] - Base URL (default: https://agoragentic.com)
 * @param {string} [options.receiptHeader] - Header name carrying receipt ID (default: x-agoragentic-receipt)
 * @returns {Function} Express middleware
 */
function createPaywall(options = {}) {
    if (!options.apiKey) {
        throw new Error('[agoragentic/settle] options.apiKey is required');
    }
    if (!options.listingId) {
        throw new Error('[agoragentic/settle] options.listingId is required');
    }

    const client = agoragentic({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
    });

    const receiptHeader = (options.receiptHeader || 'x-agoragentic-receipt').toLowerCase();

    return async function agoragenticPaywall(req, res, next) {
        const receiptId = req.headers[receiptHeader]
            || req.query?.receipt_id
            || req.body?.receipt_id;

        if (!receiptId) {
            return res.status(402).json({
                error: 'payment_required',
                message: 'This endpoint requires payment through Agoragentic. '
                    + 'Invoke this listing via POST /api/invoke/{listing_id} or '
                    + 'POST /api/execute, then include the receipt ID in the '
                    + `"${receiptHeader}" header or "receipt_id" parameter.`,
                listing_id: options.listingId,
                settlement: {
                    managed_by: 'agoragentic',
                    platform_fee: '3%',
                    currency: 'USDC',
                    network: 'base',
                    how_to_pay: `POST https://agoragentic.com/api/invoke/${options.listingId}`,
                },
            });
        }

        try {
            const verification = await verifyReceipt(receiptId, {
                apiKey: options.apiKey,
                baseUrl: options.baseUrl,
                listingId: options.listingId,
            });

            if (!verification.valid) {
                return res.status(402).json({
                    error: 'receipt_verification_failed',
                    reason: verification.reason || 'unknown',
                    message: verification.message || verification.error || 'Receipt verification failed',
                    receipt_id: receiptId,
                    listing_id: options.listingId,
                });
            }

            // Attach verified receipt to request
            req.agoragentic = {
                receipt: verification.receipt,
                receiptId,
                listingId: options.listingId,
                settled: true,
            };

            next();
        } catch (err) {
            return res.status(402).json({
                error: 'receipt_verification_failed',
                message: err.message || 'Could not verify receipt',
                receipt_id: receiptId,
            });
        }
    };
}

/**
 * Standalone receipt verification — uses the seller-safe POST /api/commerce/verify-receipt endpoint.
 *
 * Validates:
 * - receipt exists
 * - receipt belongs to options.listingId (required)
 * - receipt belongs to the authenticating seller
 * - invocation succeeded
 * - settlement is 'settled'
 *
 * @param {string} receiptId
 * @param {Object} options
 * @param {string} options.apiKey - Seller API key
 * @param {string} options.listingId - The seller's listing ID
 * @param {string} [options.baseUrl] - Base URL
 * @returns {Promise<{ valid: boolean, receipt?: Object, reason?: string, message?: string, error?: string }>}
 */
async function verifyReceipt(receiptId, options = {}) {
    if (!options.apiKey) {
        throw new Error('[agoragentic/settle] options.apiKey is required');
    }
    if (!options.listingId) {
        throw new Error('[agoragentic/settle] options.listingId is required for seller verification');
    }

    const client = agoragentic({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
    });

    try {
        const result = await client._post('/api/commerce/verify-receipt', {
            receipt_id: receiptId,
            listing_id: options.listingId,
        });

        if (result.verified) {
            return {
                valid: true,
                receipt: result,
            };
        }

        return {
            valid: false,
            reason: result.reason || 'verification_failed',
            message: result.message || 'Receipt did not pass seller verification',
        };
    } catch (err) {
        return {
            valid: false,
            reason: 'network_error',
            error: err.message || 'Verification request failed',
        };
    }
}

module.exports = { createPaywall, verifyReceipt };
