import {
    createHmac,
    randomBytes,
    timingSafeEqual
} from 'node:crypto';


const SESSION_COOKIE =
    'apxn_blog_admin_session';

const SESSION_TTL_SECONDS =
    12 * 60 * 60;

const MAX_SECRET_LENGTH =
    512;


/**
 * Prevent browser/proxy caching of admin
 * authentication responses.
 */
function noStore(res) {
    res.setHeader(
        'Cache-Control',
        'no-store, max-age=0, must-revalidate'
    );

    res.setHeader(
        'Pragma',
        'no-cache'
    );

    res.setHeader(
        'Expires',
        '0'
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
        'X-Frame-Options',
        'DENY'
    );
}


/**
 * Read the private administrator password
 * from Vercel environment variables.
 *
 * Never expose this value to frontend code.
 */
function getAdminSecret() {
    const value =
        process.env.BLOG_ADMIN_SECRET;

    if (
        typeof value !== 'string' ||
        value.length < 16
    ) {
        return null;
    }

    return value;
}


/**
 * Constant-time comparison.
 */
function safeEqual(
    first,
    second
) {
    if (
        typeof first !== 'string' ||
        typeof second !== 'string'
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
        a.length !== b.length
    ) {
        return false;
    }

    return timingSafeEqual(
        a,
        b
    );
}


/**
 * Parse request cookies.
 */
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

        const name =
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

        if (!name) {
            continue;
        }

        try {
            cookies[name] =
                decodeURIComponent(
                    rawValue
                );
        } catch {
            cookies[name] =
                rawValue;
        }
    }

    return cookies;
}


/**
 * Create secure administrator session cookie.
 */
function makeCookie(
    value,
    maxAge
) {
    return [
        `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
        `Max-Age=${Math.max(
            0,
            Math.floor(maxAge)
        )}`
    ].join('; ');
}


/**
 * Delete administrator session cookie.
 */
function clearCookie() {
    return [
        `${SESSION_COOKIE}=`,
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ].join('; ');
}


/**
 * Sign session payload.
 */
function signValue(
    value,
    secret
) {
    return createHmac(
        'sha256',
        secret
    )
        .update(
            value,
            'utf8'
        )
        .digest(
            'base64url'
        );
}


/**
 * Create a signed administrator session.
 *
 * The administrator password itself is never
 * stored inside the cookie.
 */
function createSessionToken(
    secret
) {
    const now =
        Math.floor(
            Date.now() /
            1000
        );

    const payload = {
        version: 1,

        issuedAt:
            now,

        expiresAt:
            now +
            SESSION_TTL_SECONDS,

        nonce:
            randomBytes(24)
                .toString(
                    'base64url'
                )
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

    const signature =
        signValue(
            encoded,
            secret
        );

    return (
        `${encoded}.${signature}`
    );
}


/**
 * Verify signed administrator session.
 */
function verifySessionToken(
    token,
    secret
) {
    if (
        typeof token !== 'string' ||
        token.length > 2048
    ) {
        return false;
    }

    const separator =
        token.lastIndexOf('.');

    if (
        separator <= 0 ||
        separator ===
            token.length - 1
    ) {
        return false;
    }

    const encoded =
        token.slice(
            0,
            separator
        );

    const signature =
        token.slice(
            separator + 1
        );

    const expectedSignature =
        signValue(
            encoded,
            secret
        );

    if (
        !safeEqual(
            signature,
            expectedSignature
        )
    ) {
        return false;
    }

    let payload;

    try {
        payload =
            JSON.parse(
                Buffer
                    .from(
                        encoded,
                        'base64url'
                    )
                    .toString(
                        'utf8'
                    )
            );
    } catch {
        return false;
    }

    const now =
        Math.floor(
            Date.now() /
            1000
        );

    if (
        payload?.version !== 1 ||

        !Number.isSafeInteger(
            payload.issuedAt
        ) ||

        !Number.isSafeInteger(
            payload.expiresAt
        ) ||

        payload.issuedAt >
            now + 60 ||

        payload.expiresAt <=
            now ||

        payload.expiresAt -
            payload.issuedAt >
            SESSION_TTL_SECONDS ||

        typeof payload.nonce !==
            'string' ||

        payload.nonce.length < 16
    ) {
        return false;
    }

    return true;
}


/**
 * Basic same-origin protection for login/logout
 * requests.
 */
function sameOriginRequest(req) {
    const origin =
        req.headers.origin;

    if (!origin) {
        return true;
    }

    try {
        const url =
            new URL(origin);

        const host =
            String(
                req.headers.host || ''
            ).toLowerCase();

        return (
            url.host.toLowerCase() ===
            host
        );
    } catch {
        return false;
    }
}


/**
 * Extract administrator password from request.
 */
function getSubmittedSecret(req) {
    if (
        !req.body ||
        typeof req.body !== 'object'
    ) {
        return null;
    }

    const value =
        req.body.secret;

    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length >
            MAX_SECRET_LENGTH
    ) {
        return null;
    }

    return value;
}


/**
 * Shared helper for future blog admin APIs.
 *
 * Other API files will be able to import this
 * function and protect publish/upload actions.
 */
export function isBlogAdminAuthenticated(
    req
) {
    const secret =
        getAdminSecret();

    if (!secret) {
        return false;
    }

    const cookies =
        parseCookies(req);

    return verifySessionToken(
        cookies[SESSION_COOKIE],
        secret
    );
}


/**
 * BLOG_ADMIN_SECRET is missing or too short.
 */
function configurationError(res) {
    return res
        .status(503)
        .json({
            success: false,

            authenticated: false,

            error:
                'BLOG_ADMIN_NOT_CONFIGURED'
        });
}


/**
 * GET
 * Check login status.
 *
 * POST
 * Login.
 *
 * DELETE
 * Logout.
 */
export default async function handler(
    req,
    res
) {
    noStore(res);

    const secret =
        getAdminSecret();

    if (!secret) {
        return configurationError(
            res
        );
    }


    // ============================================
    // CHECK SESSION
    // ============================================

    if (
        req.method === 'GET'
    ) {
        return res
            .status(200)
            .json({
                success: true,

                authenticated:
                    isBlogAdminAuthenticated(
                        req
                    )
            });
    }


    // ============================================
    // LOGIN
    // ============================================

    if (
        req.method === 'POST'
    ) {
        if (
            !sameOriginRequest(req)
        ) {
            return res
                .status(403)
                .json({
                    success: false,

                    authenticated: false,

                    error:
                        'INVALID_ORIGIN'
                });
        }

        const submittedSecret =
            getSubmittedSecret(
                req
            );

        if (
            !submittedSecret ||
            !safeEqual(
                submittedSecret,
                secret
            )
        ) {
            return res
                .status(401)
                .json({
                    success: false,

                    authenticated: false,

                    error:
                        'INVALID_CREDENTIALS'
                });
        }

        const token =
            createSessionToken(
                secret
            );

        res.setHeader(
            'Set-Cookie',
            makeCookie(
                token,
                SESSION_TTL_SECONDS
            )
        );

        return res
            .status(200)
            .json({
                success: true,

                authenticated: true
            });
    }


    // ============================================
    // LOGOUT
    // ============================================

    if (
        req.method === 'DELETE'
    ) {
        if (
            !sameOriginRequest(req)
        ) {
            return res
                .status(403)
                .json({
                    success: false,

                    authenticated: false,

                    error:
                        'INVALID_ORIGIN'
                });
        }

        res.setHeader(
            'Set-Cookie',
            clearCookie()
        );

        return res
            .status(200)
            .json({
                success: true,

                authenticated: false
            });
    }


    // ============================================
    // UNSUPPORTED METHOD
    // ============================================

    res.setHeader(
        'Allow',
        'GET, POST, DELETE'
    );

    return res
        .status(405)
        .json({
            success: false,

            authenticated: false,

            error:
                'METHOD_NOT_ALLOWED'
        });
}
