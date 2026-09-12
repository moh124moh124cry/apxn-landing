import {
    createHash,
    createHmac,
    timingSafeEqual
} from 'node:crypto';

import {
    getAddress,
    verifyMessage
} from 'ethers';

const SESSION_COOKIE =
    'apxn_dashboard_session';

const CHAIN_ID =
    56;

const PURPOSE =
    'link_wallet';

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
        ) ||
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
            issuedAt ||
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

function normalizeUuid(value) {
    if (
        typeof value !==
        'string'
    ) {
        return null;
    }

    const trimmed =
        value.trim();

    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(
                trimmed
            )
    ) {
        return null;
    }

    return trimmed;
}

function normalizeNonce(value) {
    if (
        typeof value !==
        'string'
    ) {
        return null;
    }

    const trimmed =
        value.trim();

    if (
        !/^[0-9a-f]{64}$/i
            .test(
                trimmed
            )
    ) {
        return null;
    }

    return trimmed.toLowerCase();
}

function normalizeSignature(value) {
    if (
        typeof value !==
        'string'
    ) {
        return null;
    }

    const trimmed =
        value.trim();

    if (
        !/^0x[0-9a-f]{130}$/i
            .test(
                trimmed
            )
    ) {
        return null;
    }

    return trimmed;
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

async function getChallenge(
    config,
    {
        challengeId,
        telegramId
    }
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/wallet_challenges`
        );

    url.searchParams.set(
        'select',
        [
            'id',
            'wallet_address',
            'telegram_id',
            'chain_id',
            'nonce_hash',
            'purpose',
            'expires_at',
            'used_at'
        ].join(',')
    );

    url.searchParams.set(
        'id',
        `eq.${challengeId}`
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
            'SUPABASE_CHALLENGE_READ_FAILED'
        );
    }

    if (
        !Array.isArray(
            data
        ) ||
        !data[0]
    ) {
        return null;
    }

    return data[0];
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

async function consumeChallenge(
    config,
    {
        challengeId,
        telegramId,
        usedAt
    }
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/wallet_challenges`
        );

    url.searchParams.set(
        'id',
        `eq.${challengeId}`
    );

    url.searchParams.set(
        'telegram_id',
        `eq.${telegramId}`
    );

    url.searchParams.set(
        'used_at',
        'is.null'
    );

    url.searchParams.set(
        'expires_at',
        `gt.${usedAt}`
    );

    const response =
        await fetch(
            url,
            {
                method:
                    'PATCH',

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
                            used_at:
                                usedAt
                        }
                    )
            }
        );

    const data =
        await readJson(
            response
        );

    if (!response.ok) {
        throw new Error(
            'SUPABASE_CHALLENGE_UPDATE_FAILED'
        );
    }

    return (
        Array.isArray(
            data
        ) &&
        data.length ===
            1
    );
}

async function saveVerifiedWallet(
    config,
    {
        telegramId,
        walletAddress,
        verifiedAt
    }
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/user_wallets`
        );

    url.searchParams.set(
        'on_conflict',
        'telegram_id'
    );

    const response =
        await fetch(
            url,
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
                                [
                                    'resolution=merge-duplicates',
                                    'return=representation'
                                ].join(',')
                        }
                    ),

                body:
                    JSON.stringify(
                        {
                            telegram_id:
                                telegramId,

                            wallet_address:
                                walletAddress,

                            chain_id:
                                CHAIN_ID,

                            wallet_verified:
                                true,

                            verified_at:
                                verifiedAt,

                            last_login_at:
                                verifiedAt
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
        !data[0]
    ) {
        console.error(
            'wallet verify upsert failed:',
            response.status
        );

        throw new Error(
            'SUPABASE_WALLET_SAVE_FAILED'
        );
    }

    return data[0];
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

    const challengeId =
        normalizeUuid(
            body.challengeId
        );

    const nonce =
        normalizeNonce(
            body.nonce
        );

    const signature =
        normalizeSignature(
            body.signature
        );

    if (!challengeId) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_CHALLENGE_ID'
            }
        );
    }

    if (!nonce) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_NONCE'
            }
        );
    }

    if (!signature) {
        return json(
            res,
            400,
            {
                error:
                    'INVALID_SIGNATURE'
            }
        );
    }

    try {
        const challenge =
            await getChallenge(
                config,
                {
                    challengeId,
                    telegramId:
                        session.telegramId
                }
            );

        if (!challenge) {
            return json(
                res,
                404,
                {
                    error:
                        'CHALLENGE_NOT_FOUND'
                }
            );
        }

        if (
            challenge.used_at
        ) {
            return json(
                res,
                409,
                {
                    error:
                        'CHALLENGE_ALREADY_USED'
                }
            );
        }

        if (
            Number(
                challenge.chain_id
            ) !==
                CHAIN_ID ||
            String(
                challenge.purpose ??
                ''
            ) !==
                PURPOSE
        ) {
            return json(
                res,
                400,
                {
                    error:
                        'INVALID_CHALLENGE'
                }
            );
        }

        const expiresDate =
            new Date(
                challenge.expires_at
            );

        if (
            !Number.isFinite(
                expiresDate.getTime()
            ) ||
            expiresDate.getTime() <=
                Date.now()
        ) {
            return json(
                res,
                410,
                {
                    error:
                        'CHALLENGE_EXPIRED'
                }
            );
        }

        const expectedNonceHash =
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

        if (
            !safeEqual(
                expectedNonceHash,
                String(
                    challenge.nonce_hash ??
                    ''
                )
            )
        ) {
            return json(
                res,
                400,
                {
                    error:
                        'NONCE_MISMATCH'
                }
            );
        }

        let walletAddress = null;

        try {
            walletAddress =
                getAddress(
                    String(
                        challenge.wallet_address
                    )
                );
        } catch {
            return json(
                res,
                400,
                {
                    error:
                        'INVALID_CHALLENGE_WALLET'
                }
            );
        }

        const expiresAt =
            expiresDate
                .toISOString();

        const message =
            buildMessage(
                {
                    walletAddress,
                    nonce,
                    expiresAt
                }
            );

        let recoveredAddress =
            null;

        try {
            recoveredAddress =
                getAddress(
                    verifyMessage(
                        message,
                        signature
                    )
                );
        } catch {
            return json(
                res,
                400,
                {
                    error:
                        'SIGNATURE_VERIFICATION_FAILED'
                }
            );
        }

        if (
            recoveredAddress
                .toLowerCase() !==
            walletAddress
                .toLowerCase()
        ) {
            return json(
                res,
                403,
                {
                    error:
                        'SIGNER_DOES_NOT_MATCH_WALLET'
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

        const verifiedAt =
            new Date()
                .toISOString();

        const consumed =
            await consumeChallenge(
                config,
                {
                    challengeId,
                    telegramId:
                        session.telegramId,
                    usedAt:
                        verifiedAt
                }
            );

        if (!consumed) {
            return json(
                res,
                409,
                {
                    error:
                        'CHALLENGE_NO_LONGER_AVAILABLE'
                }
            );
        }

        const wallet =
            await saveVerifiedWallet(
                config,
                {
                    telegramId:
                        session.telegramId,

                    walletAddress,

                    verifiedAt
                }
            );

        return json(
            res,
            200,
            {
                success:
                    true,

                wallet: {
                    walletAddress:
                        String(
                            wallet.wallet_address
                        ),

                    chainId:
                        Number(
                            wallet.chain_id
                        ),

                    verified:
                        Boolean(
                            wallet.wallet_verified
                        ),

                    verifiedAt:
                        wallet.verified_at ||
                        null
                }
            }
        );
    } catch (error) {
        console.error(
            'wallet-verify:',
            error?.message ||
            error
        );

        return json(
            res,
            500,
            {
                error:
                    'WALLET_VERIFICATION_FAILED'
            }
        );
    }
}

