import { createHash, randomBytes, randomUUID } from 'node:crypto';

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_COOLDOWN_MS = 60 * 1000;
const BSC_CHAIN_ID = 56;
const BSC_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

function json(res, status, body) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(status).json(body);
}

function getSupabaseConfig() {
    const url = process.env.SUPABASE_URL;
    const secretKey =
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_SECRET_KEY;

    if (!url || !secretKey) return null;

    return {
        url: url.replace(/\/$/, ''),
        secretKey
    };
}

function supabaseHeaders(secretKey, prefer) {
    const headers = {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
    };

    if (prefer) headers.Prefer = prefer;
    return headers;
}

async function readJsonResponse(response) {
    const text = await response.text();

    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function findWalletBinding(config, walletAddress) {
    const url = new URL(`${config.url}/rest/v1/user_wallets`);

    url.searchParams.set(
        'select',
        'telegram_id,wallet_verified'
    );

    url.searchParams.set(
        'wallet_address',
        `eq.${walletAddress}`
    );

    url.searchParams.set(
        'limit',
        '1'
    );

    const response = await fetch(url, {
        method: 'GET',
        headers: supabaseHeaders(
            config.secretKey
        )
    });

    if (!response.ok) {
        throw new Error(
            'Unable to check wallet binding'
        );
    }

    const data =
        await readJsonResponse(response);

    return (
        Array.isArray(data) &&
        data.length > 0
    )
        ? data[0]
        : null;
}

async function hasRecentChallenge(
    config,
    walletAddress
) {
    const now =
        new Date();

    const cooldownStart =
        new Date(
            now.getTime() -
            CHALLENGE_COOLDOWN_MS
        );

    const url =
        new URL(
            `${config.url}/rest/v1/wallet_challenges`
        );

    url.searchParams.set(
        'select',
        'id'
    );

    url.searchParams.set(
        'wallet_address',
        `eq.${walletAddress}`
    );

    url.searchParams.set(
        'used_at',
        'is.null'
    );

    url.searchParams.set(
        'expires_at',
        `gt.${now.toISOString()}`
    );

    url.searchParams.set(
        'created_at',
        `gte.${cooldownStart.toISOString()}`
    );

    url.searchParams.set(
        'limit',
        '1'
    );

    const response =
        await fetch(
            url,
            {
                method: 'GET',
                headers:
                    supabaseHeaders(
                        config.secretKey
                    )
            }
        );

    if (!response.ok) {
        throw new Error(
            'Unable to check recent wallet challenges'
        );
    }

    const data =
        await readJsonResponse(
            response
        );

    return (
        Array.isArray(data) &&
        data.length > 0
    );
}

async function createChallenge(
    config,
    challenge
) {
    const response =
        await fetch(
            `${config.url}/rest/v1/wallet_challenges`,
            {
                method: 'POST',

                headers:
                    supabaseHeaders(
                        config.secretKey,
                        'return=minimal'
                    ),

                body:
                    JSON.stringify(
                        challenge
                    )
            }
        );

    if (!response.ok) {
        throw new Error(
            'Unable to create wallet challenge'
        );
    }
}

function buildMessage({
    purpose,
    walletAddress,
    challengeId,
    nonce,
    issuedAt,
    expiresAt
}) {
    const purposeLabel =
        purpose === 'bind'
            ? 'Bind Wallet'
            : 'Sign In';

    return [
        'APXN Wallet Verification',
        '',

        'Domain: apxn.network',

        `Purpose: ${purposeLabel}`,

        `Wallet: ${walletAddress}`,

        `Network: BNB Smart Chain (${BSC_CHAIN_ID})`,

        `Challenge ID: ${challengeId}`,

        `Nonce: ${nonce}`,

        `Issued At: ${issuedAt}`,

        `Expires At: ${expiresAt}`,

        '',

        'Sign this message to prove ownership of this wallet.',

        'This request does not create a blockchain transaction and does not cost gas.'
    ].join('\n');
}

export default async function handler(
    req,
    res
) {
    if (
        req.method !== 'POST'
    ) {
        res.setHeader(
            'Allow',
            'POST'
        );

        return json(
            res,
            405,
            {
                error:
                    'METHOD_NOT_ALLOWED'
            }
        );
    }

    const config =
        getSupabaseConfig();

    if (!config) {
        console.error(
            'wallet-challenge: missing Supabase environment variables'
        );

        return json(
            res,
            500,
            {
                error:
                    'SERVER_CONFIGURATION_ERROR'
            }
        );
    }

    const walletAddressRaw =
        req.body?.walletAddress;

    const purpose =
        req.body?.purpose;

    if (
        typeof walletAddressRaw !==
            'string' ||

        !BSC_ADDRESS_REGEX.test(
            walletAddressRaw.trim()
        )
    ) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_WALLET_ADDRESS'
            }
        );
    }

    if (
        purpose !== 'bind' &&
        purpose !== 'login'
    ) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_PURPOSE'
            }
        );
    }

    const walletAddress =
        walletAddressRaw
            .trim()
            .toLowerCase();

    try {
        const binding =
            await findWalletBinding(
                config,
                walletAddress
            );

        if (
            purpose === 'bind' &&
            binding
        ) {
            return json(
                res,
                409,
                {
                    error:
                        'WALLET_ALREADY_LINKED'
                }
            );
        }

        if (
            purpose === 'login' &&
            (
                !binding ||
                binding.wallet_verified !==
                    true
            )
        ) {
            return json(
                res,
                404,
                {
                    error:
                        'WALLET_NOT_LINKED'
                }
            );
        }

        const recentChallenge =
            await hasRecentChallenge(
                config,
                walletAddress
            );

        if (
            recentChallenge
        ) {
            return json(
                res,
                429,
                {
                    error:
                        'CHALLENGE_RATE_LIMITED',

                    retryAfterSeconds:
                        60
                }
            );
        }

        const challengeId =
            randomUUID();

        const nonce =
            randomBytes(32)
                .toString('hex');

        const nonceHash =
            createHash(
                'sha256'
            )
                .update(
                    nonce,
                    'utf8'
                )
                .digest('hex');

        const issuedAtDate =
            new Date();

        const expiresAtDate =
            new Date(
                issuedAtDate.getTime() +
                CHALLENGE_TTL_MS
            );

        const issuedAt =
            issuedAtDate
                .toISOString();

        const expiresAt =
            expiresAtDate
                .toISOString();

        await createChallenge(
            config,
            {
                id:
                    challengeId,

                wallet_address:
                    walletAddress,

                telegram_id:
                    null,

                chain_id:
                    BSC_CHAIN_ID,

                nonce_hash:
                    nonceHash,

                purpose,

                expires_at:
                    expiresAt
            }
        );

        const message =
            buildMessage({
                purpose,
                walletAddress,
                challengeId,
                nonce,
                issuedAt,
                expiresAt
            });

        return json(
            res,
            200,
            {
                challengeId,

                walletAddress,

                chainId:
                    BSC_CHAIN_ID,

                purpose,

                nonce,

                issuedAt,

                expiresAt,

                message
            }
        );
    } catch (error) {
        console.error(
            'wallet-challenge:',
            error
        );

        return json(
            res,
            500,
            {
                error:
                    'CHALLENGE_CREATION_FAILED'
            }
        );
    }
}
