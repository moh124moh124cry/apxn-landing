import {
    createHash,
    createHmac,
    timingSafeEqual
} from 'node:crypto';

const SESSION_COOKIE =
    'apxn_dashboard_session';

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

function clearSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',

        [
            `${SESSION_COOKIE}=`,
            'Path=/',
            'HttpOnly',
            'Secure',
            'SameSite=Lax',
            'Max-Age=0'
        ].join('; ')
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
            now + 60
    ) {
        return null;
    }

    if (
        expiresAt <=
        now
    ) {
        return null;
    }

    if (
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

function supabaseHeaders(
    config
) {
    return {
        apikey:
            config.supabaseKey,

        Authorization:
            `Bearer ${config.supabaseKey}`,

        Accept:
            'application/json'
    };
}

async function getMiningUser(
    config,
    telegramId
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/users`
        );

    url.searchParams.set(
        'select',

        [
            'telegram_id',
            'username',
            'first_name',
            'balance',
            'mining_rate',
            'checkin_streak',
            'country',
            'created_at',
            'last_claim'
        ].join(',')
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

    if (
        !response.ok
    ) {
        console.error(
            'dashboard-data users error:',
            response.status
        );

        throw new Error(
            'SUPABASE_USERS_REQUEST_FAILED'
        );
    }

    if (
        !Array.isArray(
            data
        ) ||
        data.length ===
            0
    ) {
        return null;
    }

    return data[0];
}

async function getUserAllocations(
    config,
    telegramId
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/user_allocations`
        );

    url.searchParams.set(
        'select',

        [
            'id',
            'allocation_type',
            'amount',
            'asset_symbol',
            'status',
            'note',
            'created_at',
            'updated_at'
        ].join(',')
    );

    url.searchParams.set(
        'telegram_id',
        `eq.${telegramId}`
    );

    url.searchParams.set(
        'order',
        'created_at.desc'
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

    if (
        !response.ok
    ) {
        console.error(
            'dashboard-data allocations error:',
            response.status
        );

        throw new Error(
            'SUPABASE_ALLOCATIONS_REQUEST_FAILED'
        );
    }

    return Array.isArray(
        data
    )
        ? data
        : [];
}

async function getUserWallet(
    config,
    telegramId
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/user_wallets`
        );

    url.searchParams.set(
        'select',

        [
            'wallet_address',
            'chain_id',
            'wallet_verified',
            'verified_at',
            'created_at',
            'updated_at'
        ].join(',')
    );

    url.searchParams.set(
        'telegram_id',
        `eq.${telegramId}`
    );

    url.searchParams.set(
        'order',
        'updated_at.desc'
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

    if (
        !response.ok
    ) {
        console.error(
            'dashboard-data wallet error:',
            response.status
        );

        throw new Error(
            'SUPABASE_WALLET_REQUEST_FAILED'
        );
    }

    if (
        !Array.isArray(
            data
        ) ||
        data.length ===
            0
    ) {
        return null;
    }

    return data[0];
}

async function getUserBadges(
    config,
    telegramId
) {
    const url =
        new URL(
            `${config.supabaseUrl}/rest/v1/user_badges`
        );

    url.searchParams.set(
        'select',

        [
            'badge_code',
            'awarded_at',
            'note'
        ].join(',')
    );

    url.searchParams.set(
        'telegram_id',
        `eq.${telegramId}`
    );

    url.searchParams.set(
        'order',
        'awarded_at.desc'
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

    if (
        !response.ok
    ) {
        console.error(
            'dashboard-data badges error:',
            response.status
        );

        throw new Error(
            'SUPABASE_BADGES_REQUEST_FAILED'
        );
    }

    return Array.isArray(
        data
    )
        ? data
        : [];
}

function cleanUsername(
    value
) {
    if (
        typeof value !==
        'string'
    ) {
        return null;
    }

    const username =
        value.trim();

    if (!username) {
        return null;
    }

    return username
        .replace(
            /^@/,
            ''
        );
}

function cleanText(
    value
) {
    if (
        typeof value !==
        'string'
    ) {
        return null;
    }

    const text =
        value.trim();

    return text || null;
}

function publicUser(
    row
) {
    return {
        telegramId:
            String(
                row.telegram_id
            ),

        username:
            cleanUsername(
                row.username
            ),

        firstName:
            typeof row.first_name ===
                'string'
                ? row
                    .first_name
                    .trim()
                : null,

        balance:
            row.balance ??
            0,

        miningRate:
            row.mining_rate ??
            null,

        checkinStreak:
            row.checkin_streak ??
            0,

        country:
            typeof row.country ===
                'string'
                ? row
                    .country
                    .trim()
                : null,

        createdAt:
            row.created_at ??
            null,

        lastClaim:
            row.last_claim ??
            null
    };
}

function isIcoAllocation(
    row
) {
    const type =
        String(
            row?.allocation_type ??
            ''
        )
            .trim()
            .toLowerCase();

    if (!type) {
        return false;
    }

    return (
        type.includes('ico') ||
        type.includes('voucher') ||
        type.includes('ticket')
    );
}

function publicIcoVoucher(
    row
) {
    if (!row) {
        return null;
    }

    return {
        allocationType:
            cleanText(
                row.allocation_type
            ) ||
            'ICO Voucher',

        amount:
            row.amount ??
            null,

        assetSymbol:
            cleanText(
                row.asset_symbol
            ) ||
            'APXN',

        status:
            cleanText(
                row.status
            ) ||
            'reserved',

        note:
            cleanText(
                row.note
            ),

        createdAt:
            row.created_at ??
            null,

        updatedAt:
            row.updated_at ??
            null
    };
}

function publicWallet(
    row
) {
    if (!row) {
        return null;
    }

    return {
        address:
            cleanText(
                row.wallet_address
            ),

        chainId:
            Number.isFinite(
                Number(
                    row.chain_id
                )
            )
                ? Number(
                    row.chain_id
                )
                : 56,

        verified:
            row.wallet_verified ===
                true,

        verifiedAt:
            row.verified_at ??
            null,

        createdAt:
            row.created_at ??
            null,

        updatedAt:
            row.updated_at ??
            null
    };
}

function publicBadge(
    row
) {
    if (!row) {
        return null;
    }

    return {
        badgeCode:
            cleanText(
                row.badge_code
            ),

        awardedAt:
            row.awarded_at ??
            null,

        note:
            cleanText(
                row.note
            )
    };
}

function buildStageStatus(
    allocations,
    wallet
) {
    const allocationCount =
        Array.isArray(
            allocations
        )
            ? allocations.length
            : 0;

    return {
        identity: {
            status:
                'verified'
        },

        points: {
            status:
                'active'
        },

        eligibility: {
            status:
                'not_active'
        },

        allocation: {
            status:
                allocationCount >
                    0
                    ? 'record_found'
                    : 'no_record',

            recordCount:
                allocationCount
        },

        wallet: {
            status:
                wallet
                    ? (
                        wallet
                            .wallet_verified ===
                            true
                            ? 'verified'
                            : 'linked'
                    )
                    : 'not_linked'
        },

        withdrawal: {
            status:
                'not_active'
        }
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
        'GET'
    ) {
        res.setHeader(
            'Allow',
            'GET'
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
        console.error(
            'dashboard-data: missing server configuration'
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

    const cookies =
        parseCookies(
            req
        );

    const sessionToken =
        cookies[
            SESSION_COOKIE
        ];

    if (!sessionToken) {
        return json(
            res,
            401,
            {
                error:
                    'AUTH_REQUIRED'
            }
        );
    }

    const session =
        verifySession(
            sessionToken,
            config
        );

    if (!session) {
        clearSessionCookie(
            res
        );

        return json(
            res,
            401,
            {
                error:
                    'INVALID_OR_EXPIRED_SESSION'
            }
        );
    }

    try {
        const user =
            await getMiningUser(
                config,
                session
                    .telegramId
            );

        if (!user) {
            return json(
                res,
                404,
                {
                    miningAccount:
                        false
                }
            );
        }

        const [
            allocations,
            wallet,
            badges
        ] =
            await Promise.all([
                getUserAllocations(
                    config,
                    session.telegramId
                ),

                getUserWallet(
                    config,
                    session.telegramId
                ),

                getUserBadges(
                    config,
                    session.telegramId
                )
            ]);

        const icoAllocation =
            allocations.find(
                isIcoAllocation
            ) || null;

        return json(
            res,
            200,
            {
                miningAccount:
                    true,

                user:
                    publicUser(
                        user
                    ),

                icoVoucher:
                    publicIcoVoucher(
                        icoAllocation
                    ),

                wallet:
                    publicWallet(
                        wallet
                    ),

                badges:
                    badges
                        .map(
                            publicBadge
                        )
                        .filter(
                            Boolean
                        ),

                stages:
                    buildStageStatus(
                        allocations,
                        wallet
                    )
            }
        );

    } catch (error) {
        console.error(
            'dashboard-data:',
            error?.message ||
            error
        );

        return json(
            res,
            500,
            {
                error:
                    'DASHBOARD_DATA_FAILED'
            }
        );
    }
}


