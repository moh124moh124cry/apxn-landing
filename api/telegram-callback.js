import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifyCryptoSignature
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
  'https://apxn.network/api/telegram-callback';

const AUTH_TTL_SECONDS =
  10 * 60;

const SESSION_TTL_SECONDS =
  15 * 60;

const STATE_COOKIE =
  'apxn_tg_state';

const VERIFIER_COOKIE =
  'apxn_tg_verifier';

const NONCE_COOKIE =
  'apxn_tg_nonce';

const SESSION_COOKIE =
  'apxn_tg_session';

let jwksCache = {
  keys: null,
  expiresAt: 0
};

function getConfig() {
  const clientId =
    process.env.TELEGRAM_CLIENT_ID;

  const clientSecret =
    process.env.TELEGRAM_CLIENT_SECRET;

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (
    !clientId ||
    !clientSecret ||
    !supabaseUrl ||
    !supabaseKey
  ) {
    return null;
  }

  return {
    clientId: String(clientId),
    clientSecret,
    supabaseUrl:
      supabaseUrl.replace(/\/$/, ''),
    supabaseKey
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

function base64Url(
  value
) {
  return Buffer
    .from(value)
    .toString('base64url');
}

function randomValue(
  size = 32
) {
  return randomBytes(size)
    .toString('base64url');
}

function sha256Base64Url(
  value
) {
  return createHash('sha256')
    .update(value, 'utf8')
    .digest('base64url');
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

    if (index === -1) {
      continue;
    }

    const name =
      part
        .slice(0, index)
        .trim();

    const value =
      part
        .slice(index + 1)
        .trim();

    if (!name) {
      continue;
    }

    try {
      cookies[name] =
        decodeURIComponent(value);
    } catch {
      cookies[name] =
        value;
    }
  }

  return cookies;
}

function makeCookie(
  name,
  value,
  {
    maxAge,
    path = '/',
    sameSite = 'Lax'
  } = {}
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`
  ];

  if (
    Number.isFinite(maxAge)
  ) {
    parts.push(
      `Max-Age=${Math.max(
        0,
        Math.floor(maxAge)
      )}`
    );
  }

  return parts.join('; ');
}

function clearCookie(
  name,
  path
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
  a,
  b
) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string'
  ) {
    return false;
  }

  const aa =
    Buffer.from(
      a,
      'utf8'
    );

  const bb =
    Buffer.from(
      b,
      'utf8'
    );

  if (
    aa.length !== bb.length
  ) {
    return false;
  }

  return timingSafeEqual(
    aa,
    bb
  );
}

function redirect(
  res,
  location,
  status = 302
) {
  noStore(res);

  res.statusCode =
    status;

  res.setHeader(
    'Location',
    location
  );

  res.end();
}

function errorRedirect(
  res,
  code
) {
  setCookies(
    res,
    [
      clearCookie(
        STATE_COOKIE,
        '/api/telegram-callback'
      ),

      clearCookie(
        VERIFIER_COOKIE,
        '/api/telegram-callback'
      ),

      clearCookie(
        NONCE_COOKIE,
        '/api/telegram-callback'
      )
    ]
  );

  return redirect(
    res,
    `/?telegram_error=${encodeURIComponent(
      code
    )}`
  );
}

async function startLogin(
  res,
  config
) {
  const state =
    randomValue(32);

  const verifier =
    randomValue(64);

  const nonce =
    randomValue(32);

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
            '/api/telegram-callback'
        }
      ),

      makeCookie(
        VERIFIER_COOKIE,
        verifier,
        {
          maxAge:
            AUTH_TTL_SECONDS,

          path:
            '/api/telegram-callback'
        }
      ),

      makeCookie(
        NONCE_COOKIE,
        nonce,
        {
          maxAge:
            AUTH_TTL_SECONDS,

          path:
            '/api/telegram-callback'
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

  url.searchParams.set(
    'nonce',
    nonce
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
        method: 'POST',

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
        ? JSON.parse(text)
        : null;
  } catch {
    data = null;
  }

  if (
    !response.ok ||
    !data?.id_token
  ) {
    throw new Error(
      'TOKEN_EXCHANGE_FAILED'
    );
  }

  return data;
}

function decodeJwtPart(
  part
) {
  try {
    return JSON.parse(
      Buffer
        .from(
          part,
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

async function fetchJwks(
  forceRefresh = false
) {
  const now =
    Date.now();

  if (
    !forceRefresh &&
    jwksCache.keys &&
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

  if (!response.ok) {
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

async function findSigningKey(
  kid
) {
  let keys =
    await fetchJwks();

  let key =
    keys.find(
      (item) =>
        item?.kid === kid
    );

  if (!key) {
    keys =
      await fetchJwks(
        true
      );

    key =
      keys.find(
        (item) =>
          item?.kid === kid
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
  aud,
  clientId
) {
  if (
    typeof aud === 'string'
  ) {
    return aud === clientId;
  }

  if (
    Array.isArray(aud)
  ) {
    return aud.includes(
      clientId
    );
  }

  return false;
}

async function verifyIdToken(
  idToken,
  config,
  expectedNonce
) {
  if (
    typeof idToken !== 'string'
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
    header.alg !== 'RS256'
  ) {
    throw new Error(
      'UNSUPPORTED_ID_TOKEN_ALGORITHM'
    );
  }

  if (
    typeof header.kid !==
      'string' ||
    !header.kid
  ) {
    throw new Error(
      'MISSING_ID_TOKEN_KID'
    );
  }

  const jwk =
    await findSigningKey(
      header.kid
    );

  const publicKey =
    createPublicKey({
      key: jwk,
      format: 'jwk'
    });

  const signingInput =
    `${encodedHeader}.${encodedPayload}`;

  const signature =
    Buffer.from(
      encodedSignature,
      'base64url'
    );

  const validSignature =
    verifyCryptoSignature(
      'RSA-SHA256',

      Buffer.from(
        signingInput,
        'utf8'
      ),

      publicKey,

      signature
    );

  if (!validSignature) {
    throw new Error(
      'INVALID_ID_TOKEN_SIGNATURE'
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
      'INVALID_ID_TOKEN_ISSUER'
    );
  }

  if (
    !audienceMatches(
      payload.aud,
      config.clientId
    )
  ) {
    throw new Error(
      'INVALID_ID_TOKEN_AUDIENCE'
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
      'ID_TOKEN_EXPIRED'
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
      'INVALID_ID_TOKEN_TIME'
    );
  }

  if (
    typeof expectedNonce ===
      'string' &&
    expectedNonce
  ) {
    if (
      typeof payload.nonce !==
        'string' ||
      !safeEqual(
        payload.nonce,
        expectedNonce
      )
    ) {
      throw new Error(
        'INVALID_ID_TOKEN_NONCE'
      );
    }
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

  return {
    telegramId,

    username:
      typeof payload
        .preferred_username ===
        'string'
        ? payload
            .preferred_username
            .trim()
        : null,

    name:
      typeof payload.name ===
        'string'
        ? payload.name.trim()
        : null,

    picture:
      typeof payload.picture ===
        'string'
        ? payload.picture
        : null
  };
}

async function userExists(
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
        headers: {
          apikey:
            config.supabaseKey,

          Authorization:
            `Bearer ${config.supabaseKey}`,

          Accept:
            'application/json'
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      'SUPABASE_USER_LOOKUP_FAILED'
    );
  }

  const rows =
    await response.json();

  return (
    Array.isArray(rows) &&
    rows.length === 1
  );
}

function createSessionToken(
  config,
  user
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const payload = {
    v: 1,

    tid:
      user.telegramId,

    username:
      user.username || null,

    iat:
      now,

    exp:
      now +
      SESSION_TTL_SECONDS
  };

  const encodedPayload =
    base64Url(
      JSON.stringify(
        payload
      )
    );

  const sessionKey =
    createHash(
      'sha256'
    )
      .update(
        `apxn-telegram-session-v1:${config.clientSecret}`,
        'utf8'
      )
      .digest();

  const signature =
    createHmac(
      'sha256',
      sessionKey
    )
      .update(
        encodedPayload,
        'utf8'
      )
      .digest(
        'base64url'
      );

  return (
    `${encodedPayload}.${signature}`
  );
}

async function finishLogin(
  req,
  res,
  config
) {
  const cookies =
    parseCookies(req);

  const queryState =
    typeof req.query?.state ===
      'string'
      ? req.query.state
      : '';

  const code =
    typeof req.query?.code ===
      'string'
      ? req.query.code
      : '';

  const storedState =
    cookies[
      STATE_COOKIE
    ] || '';

  const verifier =
    cookies[
      VERIFIER_COOKIE
    ] || '';

  const nonce =
    cookies[
      NONCE_COOKIE
    ] || '';

  if (
    !code ||
    !queryState ||
    !storedState ||
    !verifier ||
    !nonce
  ) {
    return errorRedirect(
      res,
      'missing_auth_data'
    );
  }

  if (
    !safeEqual(
      queryState,
      storedState
    )
  ) {
    return errorRedirect(
      res,
      'invalid_state'
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
      await verifyIdToken(
        tokenResponse.id_token,
        config,
        nonce
      );

    const exists =
      await userExists(
        config,
        telegramUser
          .telegramId
      );

    if (!exists) {
      return errorRedirect(
        res,
        'telegram_user_not_found'
      );
    }

    const sessionToken =
      createSessionToken(
        config,
        telegramUser
      );

    setCookies(
      res,
      [
        clearCookie(
          STATE_COOKIE,
          '/api/telegram-callback'
        ),

        clearCookie(
          VERIFIER_COOKIE,
          '/api/telegram-callback'
        ),

        clearCookie(
          NONCE_COOKIE,
          '/api/telegram-callback'
        ),

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
      '/?telegram_login=success'
    );
  } catch (error) {
    console.error(
      'telegram-callback:',
      error
    );

    return errorRedirect(
      res,
      'telegram_verification_failed'
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
      'telegram-callback: missing environment configuration'
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
      ?.error === 'string'
  ) {
    return errorRedirect(
      res,
      'telegram_authorization_cancelled'
    );
  }

  if (
    typeof req.query
      ?.code === 'string'
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
