import {
    createHash,
    createHmac,
    timingSafeEqual
} from 'node:crypto';


const SESSION_COOKIE =
    'apxn_dashboard_session';


function noStore(
    res
) {
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
    noStore(
        res
    );

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
            )
                .replace(
                    /\/$/,
                    ''
                ),

        supabaseKey:
            String(
                supabaseKey
            )
    };
}


function parseCookies(
    req
) {
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


function clearSessionCookie(
    res
) {
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

                headers: {
                    apikey:
                        config
                            .supabaseKey,

                    Authorization:
                        `Bearer ${config.supabaseKey}`,

                    Accept:
                        'application/json'
                }
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
            'dashboard-data Supabase error:',
            response.status
        );

        throw new Error(
            'SUPABASE_REQUEST_FAILED'
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


        return json(
            res,
            200,
            {
                miningAccount:
                    true,

                user:
                    publicUser(
                        user
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
