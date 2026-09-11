import {
    createHash,
    createHmac,
    createPublicKey,
    randomBytes,
    timingSafeEqual,
    verify as verifySignature
} from 'node:crypto';


const TELEGRAM_ISSUER =
    'https://oauth.telegram.org';

const TELEGRAM_AUTH_URL =
    'https://oauth.telegram.org/auth';

const TELEGRAM_TOKEN_URL =
    'https://oauth.telegram.org/token';

const TELEGRAM_JWKS_URL =
    'https://oauth.telegram.org/.well-known/jwks.json';


const REDIRECT_URI =
    'https://apxn.network/api/dashboard-login';


const AUTH_TTL_SECONDS =
    10 * 60;

const SESSION_TTL_SECONDS =
    12 * 60 * 60;


const STATE_COOKIE =
    'apxn_dashboard_state';

const VERIFIER_COOKIE =
    'apxn_dashboard_verifier';

const SESSION_COOKIE =
    'apxn_dashboard_session';


let jwksCache = {
    keys: null,
    expiresAt: 0
};


function getConfig() {
    const clientId =
        process.env.TELEGRAM_CLIENT_ID;

    const clientSecret =
        process.env.TELEGRAM_CLIENT_SECRET;

    if (
        !clientId ||
        !clientSecret
    ) {
        return null;
    }

    return {
        clientId:
            String(clientId),

        clientSecret:
            String(clientSecret)
    };
}


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
}


function randomValue(
    bytes = 32
) {
    return randomBytes(bytes)
        .toString('base64url');
}


function sha256Base64Url(
    value
) {
    return createHash('sha256')
        .update(
            value,
            'utf8'
        )
        .digest(
            'base64url'
        );
}


function parseCookies(req) {
    const header =
        req.headers.cookie || '';

    const result = {};

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
            result[key] =
                decodeURIComponent(
                    rawValue
                );
        } catch {
            result[key] =
                rawValue;
        }
    }

    return result;
}


function makeCookie(
    name,
    value,
    {
        maxAge,
        path = '/'
    } = {}
) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${path}`,
        'HttpOnly',
        'Secure',
        'SameSite=Lax'
    ];

    if (
        Number.isFinite(
            maxAge
        )
    ) {
        parts.push(
            `Max-Age=${Math.max(
                0,
                Math.floor(
                    maxAge
                )
            )}`
        );
    }

    return parts.join('; ');
}


function clearCookie(
    name,
    path = '/'
) {
    return makeCookie(
        name,
        '',
        {
            maxAge: 0,
            path
        }
    );
}


function setCookies(
    res,
    cookies
) {
    res.setHeader(
        'Set-Cookie',
        cookies
    );
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


function redirect(
    res,
    location
) {
    noStore(res);

    res.statusCode =
        302;

    res.setHeader(
        'Location',
        location
    );

    res.end();
}


function clearAuthCookies(
    res,
    extraCookies = []
) {
    setCookies(
        res,
        [
            clearCookie(
                STATE_COOKIE,
                '/api/dashboard-login'
            ),

            clearCookie(
                VERIFIER_COOKIE,
                '/api/dashboard-login'
            ),

            ...extraCookies
        ]
    );
}


function dashboardError(
    res,
    error
) {
    clearAuthCookies(
        res
    );

    return redirect(
        res,
        `/dashboard.html?error=${encodeURIComponent(
            error
        )}`
    );
}


function startLogin(
    res,
    config
) {
    const state =
        randomValue(32);

    const verifier =
        randomValue(64);

    const challenge =
        sha256Base64Url(
            verifier
        );


    setCookies(
        res,
        [
            makeCookie(
                STATE_COOKIE,
                state,
                {
                    maxAge:
                        AUTH_TTL_SECONDS,

                    path:
                        '/api/dashboard-login'
                }
            ),

            makeCookie(
                VERIFIER_COOKIE,
                verifier,
                {
                    maxAge:
                        AUTH_TTL_SECONDS,

                    path:
                        '/api/dashboard-login'
                }
            )
        ]
    );


    const url =
        new URL(
            TELEGRAM_AUTH_URL
        );


    url.searchParams.set(
        'client_id',
        config.clientId
    );

    url.searchParams.set(
        'redirect_uri',
        REDIRECT_URI
    );

    url.searchParams.set(
        'response_type',
        'code'
    );

    url.searchParams.set(
        'scope',
        'openid profile'
    );

    url.searchParams.set(
        'state',
        state
    );

    url.searchParams.set(
        'code_challenge',
        challenge
    );

    url.searchParams.set(
        'code_challenge_method',
        'S256'
    );


    return redirect(
        res,
        url.toString()
    );
}


async function exchangeCode(
    config,
    code,
    verifier
) {
    const credentials =
        Buffer
            .from(
                `${config.clientId}:${config.clientSecret}`,
                'utf8'
            )
            .toString(
                'base64'
            );


    const body =
        new URLSearchParams();

    body.set(
        'grant_type',
        'authorization_code'
    );

    body.set(
        'code',
        code
    );

    body.set(
        'redirect_uri',
        REDIRECT_URI
    );

    body.set(
        'client_id',
        config.clientId
    );

    body.set(
        'code_verifier',
        verifier
    );


    const response =
        await fetch(
            TELEGRAM_TOKEN_URL,
            {
                method:
                    'POST',

                headers: {
                    Authorization:
                        `Basic ${credentials}`,

                    'Content-Type':
                        'application/x-www-form-urlencoded',

                    Accept:
                        'application/json'
                },

                body:
                    body.toString()
            }
        );


    const text =
        await response.text();

    let data = null;

    try {
        data =
            text
                ? JSON.parse(
                    text
                )
                : null;
    } catch {
        data = null;
    }


    if (
        !response.ok ||
        !data?.id_token
    ) {
        console.error(
            'dashboard-login token exchange failed',
            response.status
        );

        throw new Error(
            'TOKEN_EXCHANGE_FAILED'
        );
    }


    return data;
}


function decodeJwtPart(
    value
) {
    try {
        return JSON.parse(
            Buffer
                .from(
                    value,
                    'base64url'
                )
                .toString(
                    'utf8'
                )
        );
    } catch {
        throw new Error(
            'INVALID_ID_TOKEN'
        );
    }
}


async function getTelegramKeys(
    forceRefresh = false
) {
    const now =
        Date.now();


    if (
        !forceRefresh &&
        Array.isArray(
            jwksCache.keys
        ) &&
        now <
            jwksCache.expiresAt
    ) {
        return jwksCache.keys;
    }


    const response =
        await fetch(
            TELEGRAM_JWKS_URL,
            {
                headers: {
                    Accept:
                        'application/json'
                }
            }
        );


    if (
        !response.ok
    ) {
        throw new Error(
            'JWKS_FETCH_FAILED'
        );
    }


    const data =
        await response.json();


    if (
        !data ||
        !Array.isArray(
            data.keys
        )
    ) {
        throw new Error(
            'INVALID_JWKS'
        );
    }


    jwksCache = {
        keys:
            data.keys,

        expiresAt:
            now +
            60 * 60 * 1000
    };


    return data.keys;
}


async function getSigningKey(
    kid
) {
    let keys =
        await getTelegramKeys();

    let key =
        keys.find(
            (item) =>
                item?.kid ===
                kid
        );


    if (!key) {
        keys =
            await getTelegramKeys(
                true
            );

        key =
            keys.find(
                (item) =>
                    item?.kid ===
                    kid
            );
    }


    if (!key) {
        throw new Error(
            'SIGNING_KEY_NOT_FOUND'
        );
    }


    return key;
}


function audienceMatches(
    audience,
    clientId
) {
    if (
        typeof audience ===
        'string'
    ) {
        return (
            audience ===
            clientId
        );
    }


    if (
        Array.isArray(
            audience
        )
    ) {
        return audience
            .map(String)
            .includes(
                clientId
            );
    }


    return false;
}


async function verifyTelegramToken(
    idToken,
    config
) {
    if (
        typeof idToken !==
        'string'
    ) {
        throw new Error(
            'INVALID_ID_TOKEN'
        );
    }


    const parts =
        idToken.split('.');


    if (
        parts.length !== 3
    ) {
        throw new Error(
            'INVALID_ID_TOKEN'
        );
    }


    const [
        encodedHeader,
        encodedPayload,
        encodedSignature
    ] = parts;


    const header =
        decodeJwtPart(
            encodedHeader
        );

    const payload =
        decodeJwtPart(
            encodedPayload
        );


    if (
        header.alg !==
        'RS256'
    ) {
        throw new Error(
            'UNSUPPORTED_ALGORITHM'
        );
    }


    if (
        typeof header.kid !==
            'string' ||
        !header.kid
    ) {
        throw new Error(
            'MISSING_KEY_ID'
        );
    }


    const jwk =
        await getSigningKey(
            header.kid
        );


    const publicKey =
        createPublicKey({
            key: jwk,
            format: 'jwk'
        });


    const valid =
        verifySignature(
            'RSA-SHA256',

            Buffer.from(
                `${encodedHeader}.${encodedPayload}`,
                'utf8'
            ),

            publicKey,

            Buffer.from(
                encodedSignature,
                'base64url'
            )
        );


    if (!valid) {
        throw new Error(
            'INVALID_SIGNATURE'
        );
    }


    const now =
        Math.floor(
            Date.now() / 1000
        );


    if (
        payload.iss !==
        TELEGRAM_ISSUER
    ) {
        throw new Error(
            'INVALID_ISSUER'
        );
    }


    if (
        !audienceMatches(
            payload.aud,
            config.clientId
        )
    ) {
        throw new Error(
            'INVALID_AUDIENCE'
        );
    }


    if (
        !Number.isFinite(
            payload.exp
        ) ||
        payload.exp <=
            now - 30
    ) {
        throw new Error(
            'TOKEN_EXPIRED'
        );
    }


    if (
        Number.isFinite(
            payload.iat
        ) &&
        payload.iat >
            now + 60
    ) {
        throw new Error(
            'INVALID_TOKEN_TIME'
        );
    }


    const telegramId =
        String(
            payload.id ?? ''
        ).trim();


    if (
        !/^\d+$/.test(
            telegramId
        )
    ) {
        throw new Error(
            'INVALID_TELEGRAM_ID'
        );
    }


    const username =
        typeof payload
            .preferred_username ===
            'string'
            ? payload
                .preferred_username
                .trim()
            : null;


    const name =
        typeof payload.name ===
            'string'
            ? payload
                .name
                .trim()
            : null;


    return {
        telegramId,
        username,
        name
    };
}


function createSessionToken(
    user,
    config
) {
    const now =
        Math.floor(
            Date.now() /
            1000
        );


    const payload = {
        version: 1,

        telegramId:
            user.telegramId,

        username:
            user.username ||
            null,

        name:
            user.name ||
            null,

        issuedAt:
            now,

        expiresAt:
            now +
            SESSION_TTL_SECONDS
    };


    const encoded =
        Buffer
            .from(
                JSON.stringify(
                    payload
                ),
                'utf8'
            )
            .toString(
                'base64url'
            );


    const key =
        createHash(
            'sha256'
        )
            .update(
                `apxn-dashboard-session-v1:${config.clientSecret}`,
                'utf8'
            )
            .digest();


    const signature =
        createHmac(
            'sha256',
            key
        )
            .update(
                encoded,
                'utf8'
            )
            .digest(
                'base64url'
            );


    return (
        `${encoded}.${signature}`
    );
}


async function finishLogin(
    req,
    res,
    config
) {
    const cookies =
        parseCookies(req);


    const code =
        typeof req.query
            ?.code ===
            'string'
            ? req.query
                .code
                .trim()
            : '';


    const returnedState =
        typeof req.query
            ?.state ===
            'string'
            ? req.query
                .state
                .trim()
            : '';


    const storedState =
        cookies[
            STATE_COOKIE
        ] || '';


    const verifier =
        cookies[
            VERIFIER_COOKIE
        ] || '';


    if (
        !code ||
        !returnedState ||
        !storedState ||
        !verifier
    ) {
        return dashboardError(
            res,
            'missing_login_data'
        );
    }


    if (
        !safeEqual(
            returnedState,
            storedState
        )
    ) {
        return dashboardError(
            res,
            'invalid_login_state'
        );
    }


    try {
        const tokenResponse =
            await exchangeCode(
                config,
                code,
                verifier
            );


        const telegramUser =
            await verifyTelegramToken(
                tokenResponse
                    .id_token,
                config
            );


        const sessionToken =
            createSessionToken(
                telegramUser,
                config
            );


        clearAuthCookies(
            res,
            [
                makeCookie(
                    SESSION_COOKIE,
                    sessionToken,
                    {
                        maxAge:
                            SESSION_TTL_SECONDS,

                        path: '/'
                    }
                )
            ]
        );


        return redirect(
            res,
            '/dashboard.html?login=success'
        );

    } catch (error) {
        console.error(
            'dashboard-login:',
            error?.message ||
            error
        );


        return dashboardError(
            res,
            'telegram_login_failed'
        );
    }
}


export default async function handler(
    req,
    res
) {
    noStore(res);


    if (
        req.method !== 'GET'
    ) {
        res.setHeader(
            'Allow',
            'GET'
        );

        return res
            .status(405)
            .json({
                error:
                    'METHOD_NOT_ALLOWED'
            });
    }


    const config =
        getConfig();


    if (!config) {
        console.error(
            'dashboard-login: missing Telegram environment variables'
        );

        return res
            .status(500)
            .json({
                error:
                    'SERVER_CONFIGURATION_ERROR'
            });
    }


    if (
        typeof req.query
            ?.error ===
            'string'
    ) {
        return dashboardError(
            res,
            'telegram_authorization_cancelled'
        );
    }


    if (
        typeof req.query
            ?.code ===
            'string'
    ) {
        return finishLogin(
            req,
            res,
            config
        );
    }


    return startLogin(
        res,
        config
    );
}
