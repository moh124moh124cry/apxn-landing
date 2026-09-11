import {
    createHash,
    createHmac,
    timingSafeEqual
} from 'node:crypto';

const SESSION_COOKIE =
    'apxn_dashboard_session';

const TASK_SLOTS = [
    {
        key: 'x_points_post',
        category: 'task',
        title: 'APXN Points X Post',
        reward: 50,
        urlEnv: 'APXN_TASK_X_POINTS_URL'
    },
    {
        key: 'x_network_post',
        category: 'task',
        title: 'Apex Network X Post',
        reward: 50,
        urlEnv: 'APXN_TASK_X_NETWORK_URL'
    },
    {
        key: 'telegram_post',
        category: 'task',
        title: 'Telegram Post',
        reward: 50,
        urlEnv: 'APXN_TASK_TELEGRAM_URL'
    },
    {
        key: 'article',
        category: 'task',
        title: 'APXN Article',
        reward: 50,
        urlEnv: 'APXN_TASK_ARTICLE_URL'
    },
    {
        key: 'join_x_points',
        category: 'join',
        title: 'Follow APXN Points',
        reward: 100,
        urlEnv: 'APXN_JOIN_X_POINTS_URL'
    },
    {
        key: 'join_x_network',
        category: 'join',
        title: 'Follow Apex Network',
        reward: 100,
        urlEnv: 'APXN_JOIN_X_NETWORK_URL'
    },
    {
        key: 'join_telegram_channel',
        category: 'join',
        title: 'Join Telegram Channel',
        reward: 100,
        urlEnv: 'APXN_JOIN_TELEGRAM_CHANNEL_URL'
    },
    {
        key: 'join_telegram_group',
        category: 'join',
        title: 'Join Telegram Group',
        reward: 100,
        urlEnv: 'APXN_JOIN_TELEGRAM_GROUP_URL'
    },
    {
        key: 'join_website',
        category: 'join',
        title: 'Open APXN Website',
        reward: 100,
        urlEnv: 'APXN_JOIN_WEBSITE_URL'
    }
];

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

    const now =
        Math.floor(
            Date.now() /
            1000
        );

    if (
        !Number.isFinite(
            issuedAt
        ) ||
        !Number.isFinite(
            expiresAt
        ) ||
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

function cleanEnv(name) {
    const value =
        process.env[
            name
        ];

    if (
        typeof value !==
            'string'
    ) {
        return '';
    }

    return value.trim();
}

function normalizeUrl(value) {
    try {
        const url =
            new URL(
                value
            );

        if (
            url.protocol !==
                'https:' &&
            url.protocol !==
                'http:'
        ) {
            return '';
        }

        return url.toString();
    } catch {
        return '';
    }
}

function makeClaimKey(
    slot,
    url
) {
    const urlHash =
        createHash(
            'sha256'
        )
            .update(
                url,
                'utf8'
            )
            .digest(
                'hex'
            )
            .slice(
                0,
                32
            );

    return `${slot.key}:${urlHash}`;
}

function resolveSlot(
    slot
) {
    const url =
        normalizeUrl(
            cleanEnv(
                slot.urlEnv
            )
        );

    if (!url) {
        return null;
    }

    return {
        key:
            slot.key,

        category:
            slot.category,

        title:
            slot.title,

        reward:
            slot.reward,

        url,

        claimKey:
            makeClaimKey(
                slot,
                url
            )
    };
}

function getPublicTasks() {
    return TASK_SLOTS
        .map(
            resolveSlot
        )
        .filter(Boolean)
        .map(
            (task) => ({
                key:
                    task.key,

                category:
                    task.category,

                title:
                    task.title,

                reward:
                    task.reward,

                url:
                    task.url
            })
        );
}

function findTask(
    key
) {
    const slot =
        TASK_SLOTS.find(
            (item) =>
                item.key === key
        );

    if (!slot) {
        return null;
    }

    return resolveSlot(
        slot
    );
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
            'application/json',

        'Content-Type':
            'application/json'
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

async function claimReward(
    config,
    telegramId,
    task
) {
    const response =
        await fetch(
            `${config.supabaseUrl}/rest/v1/rpc/claim_website_reward`,
            {
                method:
                    'POST',

                headers:
                    supabaseHeaders(
                        config
                    ),

                body:
                    JSON.stringify({
                        p_telegram_id:
                            telegramId,

                        p_claim_key:
                            task.claimKey,

                        p_reward:
                            task.reward
                    })
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
            'earn-tasks rpc error:',
            response.status
        );

        throw new Error(
            'CLAIM_RPC_FAILED'
        );
    }

    if (
        !Array.isArray(
            data
        ) ||
        data.length ===
            0
    ) {
        throw new Error(
            'EMPTY_CLAIM_RESPONSE'
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
        req.method ===
        'GET'
    ) {
        return json(
            res,
            200,
            {
                tasks:
                    getPublicTasks()
            }
        );
    }

    if (
        req.method !==
        'POST'
    ) {
        res.setHeader(
            'Allow',
            'GET, POST'
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

    const cookies =
        parseCookies(
            req
        );

    const session =
        verifySession(
            cookies[
                SESSION_COOKIE
            ],
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

    const key =
        String(
            req.body?.key ??
            ''
        ).trim();

    const task =
        findTask(
            key
        );

    if (!task) {
        return json(
            res,
            404,
            {
                error:
                    'TASK_NOT_AVAILABLE'
            }
        );
    }

    try {
        const result =
            await claimReward(
                config,
                session.telegramId,
                task
            );

        if (
            result?.already_claimed ===
            true
        ) {
            return json(
                res,
                200,
                {
                    success:
                        false,

                    alreadyClaimed:
                        true,

                    reward:
                        result.reward,

                    balance:
                        result.balance
                }
            );
        }

        if (
            result?.success !==
            true
        ) {
            const message =
                String(
                    result?.message ??
                    ''
                );

            if (
                message ===
                'USER_NOT_FOUND'
            ) {
                return json(
                    res,
                    404,
                    {
                        error:
                            'MINING_ACCOUNT_NOT_FOUND'
                    }
                );
            }

            return json(
                res,
                400,
                {
                    error:
                        message ||
                        'CLAIM_REJECTED'
                }
            );
        }

        return json(
            res,
            200,
            {
                success:
                    true,

                alreadyClaimed:
                    false,

                reward:
                    result.reward,

                balance:
                    result.balance
            }
        );

    } catch (error) {
        console.error(
            'earn-tasks:',
            error?.message ||
            error
        );

        return json(
            res,
            500,
            {
                error:
                    'CLAIM_FAILED'
            }
        );
    }
}
