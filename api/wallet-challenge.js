import {
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual
} from 'node:crypto';

import {
    getAddress
} from 'ethers';

const SESSION_COOKIE =
    'apxn_dashboard_session';

const CHAIN_ID =
    56;

const PURPOSE =
    'link_wallet';

const CHALLENGE_TTL_MS =
    10 * 60 * 1000;

function noStore(res) {
    res.setHeader(
        'Cache-Control',
        'no-store, max-age=0'
    );

    res.setHeader(
        'Pragma',
        'no-cache'
    );

    res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
    );

    res.setHeader(
        'Referrer-Policy',
        'no-referrer'
    );

    res.setHeader(
        'Vary',
        'Cookie'
    );
}

function json(
    res,
    status,
    body
) {
    noStore(res);

    return res
        .status(status)
        .json(body);
}

function getConfig() {
    const telegramClientSecret =
        process.env
            .TELEGRAM_CLIENT_SECRET;

    const supabaseUrl =
        process.env
            .SUPABASE_URL;

    const supabaseKey =
        process.env
            .SUPABASE_SERVICE_ROLE_KEY ||
        process.env
            .SUPABASE_SECRET_KEY;

    if (
        !telegramClientSecret ||
        !supabaseUrl ||
        !supabaseKey
    ) {
        return null;
    }

    return {
        telegramClientSecret:
            String(
                telegramClientSecret
            ),

        supabaseUrl:
            String(
                supabaseUrl
            ).replace(
                /\/$/,
                ''
            ),

        supabaseKey:
            String(
                supabaseKey
            )
    };
}

function parseCookies(req) {
    const header =
        req.headers.cookie || '';

    const cookies = {};

    for (
        const part of
        header.split(';')
    ) {
        const index =
            part.indexOf('=');

        if (
            index === -1
        ) {
            continue;
        }

        const key =
            part
                .slice(
                    0,
                    index
                )
                .trim();

        const rawValue =
            part
                .slice(
                    index + 1
                )
                .trim();

        if (!key) {
            continue;
        }

        try {
            cookies[key] =
                decodeURIComponent(
                    rawValue
                );
        } catch {
            cookies[key] =
                rawValue;
        }
    }

    return cookies;
}

function safeEqual(
    first,
    second
) {
    if (
        typeof first !==
            'string' ||
        typeof second !==
            'string'
    ) {
        return false;
    }

    const a =
        Buffer.from(
            first,
            'utf8'
        );

    const b =
        Buffer.from(
            second,
            'utf8'
        );

    if (
        a.length !==
        b.length
    ) {
        return false;
    }

    return timingSafeEqual(
        a,
        b
    );
}

function sessionKey(
    clientSecret
) {
    return createHash(
        'sha256'
    )
        .update(
            `apxn-dashboard-session-v1:${clientSecret}`,
            'utf8'
        )
        .digest();
}

function verifySession(
    token,
    config
) {
    if (
        typeof token !==
            'string' ||
        !token ||
        token.length >
            4096
    ) {
        return null;
    }

    const parts =
        token.split('.');

    if (
        parts.length !==
        2
    ) {
        return null;
    }

    const [
        encodedPayload,
        receivedSignature
    ] = parts;

    if (
        !encodedPayload ||
        !receivedSignature
    ) {
        return null;
    }

    const expectedSignature =
        createHmac(
            'sha256',
            sessionKey(
                config
                    .telegramClientSecret
            )
        )
            .update(
                encodedPayload,
                'utf8'
            )
            .digest(
                'base64url'
            );

    if (
        !safeEqual(
            receivedSignature,
            expectedSignature
        )
    ) {
        return null;
    }

    let payload = null;

    try {
        payload =
            JSON.parse(
                Buffer
                    .from(
                        encodedPayload,
                        'base64url'
                    )
                    .toString(
                        'utf8'
                    )
            );
    } catch {
        return null;
    }

    if (
        !payload ||
        typeof payload !==
            'object' ||
        Array.isArray(
            payload
        )
    ) {
        return null;
    }

    if (
        payload.version !==
        1
    ) {
        return null;
    }

    const telegramId =
        String(
            payload.telegramId ??
            ''
        ).trim();

    if (
        !/^\d+$/.test(
            telegramId
        )
    ) {
        return null;
    }

    const issuedAt =
        Number(
            payload.issuedAt
        );

    const expiresAt =
        Number(
            payload.expiresAt
        );

    if (
        !Number.isFinite(
            issuedAt
        ) ||
        !Number.isFinite(
            expiresAt
        )
    ) {
        return null;
    }

    const now =
        Math.floor(
            Date.now() /
            1000
        );

    if (
        issuedAt >
            now + 60 ||
        expiresAt <=
            now ||
        expiresAt <=
            issuedAt
    ) {
        return null;
    }

    if (
        expiresAt -
            issuedAt >
        12 * 60 * 60 + 60
    ) {
        return null;
    }

    return {
        telegramId
    };
}

function supabaseHeaders(
    config,
    extra = {}
) {
    return {
        apikey:
            config.supabaseKey,

        Authorization:
            `Bearer ${config.supabaseKey}`,

        Accept:
            'application/json',

        ...extra
    };
}

async function readJson(
    response
) {
    const text =
        await response.text();

    if (!text) {
        return null;
    }

    try {
        return JSON.parse(
            text
        );
    } catch {
        return null;
    }
}

async function readBody(req) {
    if (
        req.body &&
        typeof req.body ===
            'object' &&
        !Buffer.isBuffer(
            req.body
        )
    ) {
        return req.body;
    }

    if (
        typeof req.body ===
        'string'
    ) {
        try {
            return JSON.parse(
                req.body
            );
        } catch {
            return null;
        }
    }

    const chunks = [];

    for await (
        const chunk of req
    ) {
        chunks.push(
            Buffer.from(
                chunk
            )
        );
    }

    if (
        chunks.length ===
        0
    ) {
        return {};
    }

    try {
        return JSON.parse(
            Buffer
                .concat(
                    chunks
                )
                .toString(
                    'utf8'
                )
        );
    } catch {
        return null;
    }
}

async function miningAccountExists(
    config,
    telegramId
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/users`
        );

    url.searchParams.set(
        'select',
        'telegram_id'
    );

    url.searchParams.set(
        'telegram_id',
        `eq.${telegramId}`
    );

    url.searchParams.set(
        'limit',
        '1'
    );

    const response =
        await fetch(
            url,
            {
                method:
                    'GET',

                headers:
                    supabaseHeaders(
                        config
                    )
            }
        );

    const data =
        await readJson(
            response
        );

    if (!response.ok) {
        throw new Error(
            'SUPABASE_USER_CHECK_FAILED'
        );
    }

    return (
        Array.isArray(
            data
        ) &&
        data.length >
            0
    );
}

async function walletUsedByAnotherAccount(
    config,
    walletAddress,
    telegramId
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/user_wallets`
        );

    url.searchParams.set(
        'select',
        'telegram_id,wallet_address'
    );

    url.searchParams.set(
        'wallet_address',
        `eq.${walletAddress}`
    );

    url.searchParams.set(
        'limit',
        '10'
    );

    const response =
        await fetch(
            url,
            {
                method:
                    'GET',

                headers:
                    supabaseHeaders(
                        config
                    )
            }
        );

    const data =
        await readJson(
            response
        );

    if (!response.ok) {
        throw new Error(
            'SUPABASE_WALLET_CHECK_FAILED'
        );
    }

    if (
        !Array.isArray(
            data
        )
    ) {
        return false;
    }

    return data.some(
        (row) =>
            String(
                row?.telegram_id ??
                ''
            ) !==
            telegramId
    );
}

function normalizeWalletAddress(
    value
) {
    if (
        typeof value !==
        'string'
    ) {
        return null;
    }

    const trimmed =
        value.trim();

    if (!trimmed) {
        return null;
    }

    try {
        return getAddress(
            trimmed
        );
    } catch {
        return null;
    }
}

function buildMessage({
    walletAddress,
    nonce,
    expiresAt
}) {
    return [
        'Apex Network Wallet Verification',
        '',
        'Sign this message to verify ownership of your BNB Smart Chain wallet.',
        'This request does not authorize a transaction, token approval, or transfer.',
        '',
        `Wallet: ${walletAddress}`,
        `Chain ID: ${CHAIN_ID}`,
        `Nonce: ${nonce}`,
        `Expires: ${expiresAt}`
    ].join('\n');
}

async function createChallenge(
    config,
    {
        telegramId,
        walletAddress,
        nonce,
        expiresAt
    }
) {
    const nonceHash =
        createHash(
            'sha256'
        )
            .update(
                nonce,
                'utf8'
            )
            .digest(
                'hex'
            );

    const response =
        await fetch(
            `${config.supabaseUrl}/rest/v1/wallet_challenges`,
            {
                method:
                    'POST',

                headers:
                    supabaseHeaders(
                        config,
                        {
                            'Content-Type':
                                'application/json',

                            Prefer:
                                'return=representation'
                        }
                    ),

                body:
                    JSON.stringify(
                        {
                            wallet_address:
                                walletAddress,

                            telegram_id:
                                telegramId,

                            chain_id:
                                CHAIN_ID,

                            nonce_hash:
                                nonceHash,

                            purpose:
                                PURPOSE,

                            expires_at:
                                expiresAt
                        }
                    )
            }
        );

    const data =
        await readJson(
            response
        );

    if (
        !response.ok ||
        !Array.isArray(
            data
        ) ||
        !data[0]?.id
    ) {
        console.error(
            'wallet-challenge insert failed:',
            response.status
        );

        throw new Error(
            'SUPABASE_CHALLENGE_INSERT_FAILED'
        );
    }

    return {
        id:
            String(
                data[0].id
            )
    };
}

export default async function handler(
    req,
    res
) {
    noStore(
        res
    );

    if (
        req.method !==
        'POST'
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
        getConfig();

    if (!config) {
        return json(
            res,
            500,
            {
                error:
                    'SERVER_CONFIGURATION_ERROR'
            }
        );
    }

    const sessionToken =
        parseCookies(
            req
        )[
            SESSION_COOKIE
        ];

    const session =
        verifySession(
            sessionToken,
            config
        );

    if (!session) {
        return json(
            res,
            401,
            {
                error:
                    'AUTH_REQUIRED'
            }
        );
    }

    const body =
        await readBody(
            req
        );

    if (!body) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_JSON'
            }
        );
    }

    const walletAddress =
        normalizeWalletAddress(
            body.walletAddress
        );

    if (!walletAddress) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_WALLET_ADDRESS'
            }
        );
    }

    try {
        const hasAccount =
            await miningAccountExists(
                config,
                session.telegramId
            );

        if (!hasAccount) {
            return json(
                res,
                404,
                {
                    error:
                        'MINING_ACCOUNT_NOT_FOUND'
                }
            );
        }

        const alreadyUsed =
            await walletUsedByAnotherAccount(
                config,
                walletAddress,
                session.telegramId
            );

        if (alreadyUsed) {
            return json(
                res,
                409,
                {
                    error:
                        'WALLET_ALREADY_LINKED'
                }
            );
        }

        const nonce =
            randomBytes(
                32
            ).toString(
                'hex'
            );

        const expiresAt =
            new Date(
                Date.now() +
                CHALLENGE_TTL_MS
            ).toISOString();

        const challenge =
            await createChallenge(
                config,
                {
                    telegramId:
                        session.telegramId,

                    walletAddress,
                    nonce,
                    expiresAt
                }
            );

        const message =
            buildMessage(
                {
                    walletAddress,
                    nonce,
                    expiresAt
                }
            );

        return json(
            res,
            200,
            {
                challengeId:
                    challenge.id,

                walletAddress,

                chainId:
                    CHAIN_ID,

                nonce,

                message,

                expiresAt
            }
        );
    } catch (error) {
        console.error(
            'wallet-challenge:',
            error?.message ||
            error
        );

        return json(
            res,
            500,
            {
                error:
                    'WALLET_CHALLENGE_FAILED'
            }
        );
    }
}

