import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { verifyMessage } from 'ethers';

const BSC_CHAIN_ID = 56;
const TELEGRAM_MAX_AGE = 10 * 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NONCE_RE =
  /^[0-9a-f]{64}$/i;

const SIG_RE =
  /^0x[0-9a-f]+$/i;

function reply(
  res,
  status,
  body
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

  return res
    .status(status)
    .json(body);
}

function config() {
  const url =
    process.env.SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (
    !url ||
    !key
  ) {
    return null;
  }

  return {
    url: url.replace(/\/$/, ''),
    key
  };
}

function botToken() {
  return (
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    null
  );
}

async function readBody(
  response
) {
  const text =
    await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function db(
  cfg,
  pathOrUrl,
  {
    method = 'GET',
    body,
    prefer
  } = {}
) {
  const url =
    String(pathOrUrl)
      .startsWith('http')
      ? String(pathOrUrl)
      : `${cfg.url}${pathOrUrl}`;

  const headers = {
    apikey: cfg.key,

    Authorization:
      `Bearer ${cfg.key}`,

    'Content-Type':
      'application/json'
  };

  if (prefer) {
    headers.Prefer =
      prefer;
  }

  const response =
    await fetch(
      url,
      {
        method,

        headers,

        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                body
              )
      }
    );

  const data =
    await readBody(
      response
    );

  if (!response.ok) {
    const error =
      new Error(
        'Supabase request failed'
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  return data;
}

function safeHexEqual(
  a,
  b
) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
    a.length !== b.length
  ) {
    return false;
  }

  if (
    !/^[0-9a-f]+$/i.test(a) ||
    !/^[0-9a-f]+$/i.test(b)
  ) {
    return false;
  }

  const aa =
    Buffer.from(
      a,
      'hex'
    );

  const bb =
    Buffer.from(
      b,
      'hex'
    );

  return (
    aa.length ===
      bb.length &&

    timingSafeEqual(
      aa,
      bb
    )
  );
}

function verifyTelegram(
  auth,
  token
) {
  if (
    !auth ||
    typeof auth !== 'object' ||
    Array.isArray(auth)
  ) {
    return {
      ok: false,

      error:
        'TELEGRAM_AUTH_REQUIRED'
    };
  }

  const id =
    String(
      auth.id ?? ''
    ).trim();

  const hash =
    String(
      auth.hash ?? ''
    )
      .trim()
      .toLowerCase();

  const authDate =
    Number(
      auth.auth_date
    );

  if (
    !/^\d+$/.test(id)
  ) {
    return {
      ok: false,

      error:
        'INVALID_TELEGRAM_ID'
    };
  }

  if (
    !/^[0-9a-f]{64}$/.test(
      hash
    )
  ) {
    return {
      ok: false,

      error:
        'INVALID_TELEGRAM_HASH'
    };
  }

  if (
    !Number.isFinite(
      authDate
    )
  ) {
    return {
      ok: false,

      error:
        'INVALID_TELEGRAM_AUTH_DATE'
    };
  }

  const age =
    Math.floor(
      Date.now() /
        1000
    ) -
    authDate;

  if (
    age < -60 ||
    age >
      TELEGRAM_MAX_AGE
  ) {
    return {
      ok: false,

      error:
        'TELEGRAM_AUTH_EXPIRED'
    };
  }

  const checkString =
    Object.entries(auth)
      .filter(
        ([key, value]) =>
          key !== 'hash' &&
          value !==
            undefined &&
          value !== null
      )
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${String(
            value
          )}`
      )
      .join('\n');

  const secret =
    createHash(
      'sha256'
    )
      .update(
        token,
        'utf8'
      )
      .digest();

  const expected =
    createHmac(
      'sha256',
      secret
    )
      .update(
        checkString,
        'utf8'
      )
      .digest('hex');

  if (
    !safeHexEqual(
      expected,
      hash
    )
  ) {
    return {
      ok: false,

      error:
        'INVALID_TELEGRAM_AUTH'
    };
  }

  return {
    ok: true,
    id
  };
}

function challengeUrl(
  cfg,
  id
) {
  const url =
    new URL(
      `${cfg.url}/rest/v1/wallet_challenges`
    );

  url.searchParams.set(
    'select',

    [
      'id',
      'wallet_address',
      'chain_id',
      'nonce_hash',
      'purpose',
      'expires_at',
      'used_at',
      'created_at'
    ].join(',')
  );

  url.searchParams.set(
    'id',
    `eq.${id}`
  );

  url.searchParams.set(
    'limit',
    '1'
  );

  return url;
}

async function getChallenge(
  cfg,
  id
) {
  const rows =
    await db(
      cfg,
      challengeUrl(
        cfg,
        id
      )
    );

  return (
    Array.isArray(rows) &&
    rows[0]
  )
    ? rows[0]
    : null;
}

function validateMessage(
  message,
  challenge,
  nonce
) {
  if (
    typeof message !==
      'string' ||
    message.length < 1 ||
    message.length >
      2048
  ) {
    return false;
  }

  const lines =
    message.split('\n');

  if (
    lines.length !== 13
  ) {
    return false;
  }

  const purposeLabel =
    challenge.purpose ===
      'bind'
      ? 'Bind Wallet'
      : 'Sign In';

  const fixed =
    lines[0] ===
      'APXN Wallet Verification' &&

    lines[1] === '' &&

    lines[2] ===
      'Domain: apxn.network' &&

    lines[3] ===
      `Purpose: ${purposeLabel}` &&

    lines[4] ===
      `Wallet: ${challenge.wallet_address}` &&

    lines[5] ===
      `Network: BNB Smart Chain (${BSC_CHAIN_ID})` &&

    lines[6] ===
      `Challenge ID: ${challenge.id}` &&

    lines[7] ===
      `Nonce: ${nonce}` &&

    lines[10] === '' &&

    lines[11] ===
      'Sign this message to prove ownership of this wallet.' &&

    lines[12] ===
      'This request does not create a blockchain transaction and does not cost gas.';

  if (
    !fixed ||
    !lines[8].startsWith(
      'Issued At: '
    ) ||
    !lines[9].startsWith(
      'Expires At: '
    )
  ) {
    return false;
  }

  const issuedAt =
    Date.parse(
      lines[8].slice(11)
    );

  const messageExpiry =
    Date.parse(
      lines[9].slice(12)
    );

  const storedExpiry =
    Date.parse(
      challenge.expires_at
    );

  const createdAt =
    Date.parse(
      challenge.created_at
    );

  if (
    ![
      issuedAt,
      messageExpiry,
      storedExpiry,
      createdAt
    ].every(
      Number.isFinite
    )
  ) {
    return false;
  }

  if (
    Math.abs(
      messageExpiry -
        storedExpiry
    ) >
    1000
  ) {
    return false;
  }

  if (
    Math.abs(
      issuedAt -
        createdAt
    ) >
    30000
  ) {
    return false;
  }

  return (
    issuedAt <
    messageExpiry
  );
}

async function getUser(
  cfg,
  telegramId
) {
  const url =
    new URL(
      `${cfg.url}/rest/v1/users`
    );

  url.searchParams.set(
    'select',

    [
      'telegram_id',
      'username',
      'first_name',
      'balance',
      'created_at',
      'country',
      'checkin_streak'
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

  const rows =
    await db(
      cfg,
      url
    );

  return (
    Array.isArray(rows) &&
    rows[0]
  )
    ? rows[0]
    : null;
}

async function getWalletBy(
  cfg,
  field,
  value
) {
  const url =
    new URL(
      `${cfg.url}/rest/v1/user_wallets`
    );

  url.searchParams.set(
    'select',

    [
      'id',
      'telegram_id',
      'wallet_address',
      'chain_id',
      'wallet_verified',
      'verified_at',
      'last_login_at'
    ].join(',')
  );

  url.searchParams.set(
    field,
    `eq.${value}`
  );

  url.searchParams.set(
    'limit',
    '1'
  );

  const rows =
    await db(
      cfg,
      url
    );

  return (
    Array.isArray(rows) &&
    rows[0]
  )
    ? rows[0]
    : null;
}

async function consumeChallenge(
  cfg,
  challenge,
  telegramId
) {
  const now =
    new Date()
      .toISOString();

  const url =
    new URL(
      `${cfg.url}/rest/v1/wallet_challenges`
    );

  url.searchParams.set(
    'id',
    `eq.${challenge.id}`
  );

  url.searchParams.set(
    'used_at',
    'is.null'
  );

  url.searchParams.set(
    'expires_at',
    `gt.${now}`
  );

  const rows =
    await db(
      cfg,
      url,
      {
        method: 'PATCH',

        prefer:
          'return=representation',

        body: {
          used_at: now,

          telegram_id:
            telegramId
        }
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length === 1
  );
}

async function createWallet(
  cfg,
  telegramId,
  walletAddress
) {
  const now =
    new Date()
      .toISOString();

  const rows =
    await db(
      cfg,
      '/rest/v1/user_wallets',
      {
        method: 'POST',

        prefer:
          'return=representation',

        body: {
          telegram_id:
            telegramId,

          wallet_address:
            walletAddress,

          chain_id:
            BSC_CHAIN_ID,

          wallet_verified:
            true,

          verified_at:
            now,

          last_login_at:
            now
        }
      }
    );

  return (
    Array.isArray(rows) &&
    rows[0]
  )
    ? rows[0]
    : null;
}

async function touchWallet(
  cfg,
  wallet,
  forceVerified = false
) {
  const now =
    new Date()
      .toISOString();

  const url =
    new URL(
      `${cfg.url}/rest/v1/user_wallets`
    );

  url.searchParams.set(
    'id',
    `eq.${wallet.id}`
  );

  const body = {
    last_login_at:
      now
  };

  if (
    forceVerified
  ) {
    body.wallet_verified =
      true;

    if (
      !wallet.verified_at
    ) {
      body.verified_at =
        now;
    }
  }

  const rows =
    await db(
      cfg,
      url,
      {
        method:
          'PATCH',

        prefer:
          'return=representation',

        body
      }
    );

  return (
    Array.isArray(rows) &&
    rows[0]
  )
    ? rows[0]
    : wallet;
}

async function dashboard(
  cfg,
  telegramId,
  wallet
) {
  const badgesUrl =
    new URL(
      `${cfg.url}/rest/v1/user_badges`
    );

  badgesUrl.searchParams.set(
    'select',
    'badge_code,awarded_at'
  );

  badgesUrl.searchParams.set(
    'telegram_id',
    `eq.${telegramId}`
  );

  badgesUrl.searchParams.set(
    'order',
    'awarded_at.desc'
  );

  const allocationsUrl =
    new URL(
      `${cfg.url}/rest/v1/user_allocations`
    );

  allocationsUrl.searchParams.set(
    'select',

    [
      'allocation_type',
      'amount',
      'asset_symbol',
      'status',
      'created_at'
    ].join(',')
  );

  allocationsUrl.searchParams.set(
    'telegram_id',
    `eq.${telegramId}`
  );

  allocationsUrl.searchParams.set(
    'status',
    'neq.cancelled'
  );

  allocationsUrl.searchParams.set(
    'order',
    'created_at.desc'
  );

  const [
    user,
    badges,
    allocations
  ] =
    await Promise.all([
      getUser(
        cfg,
        telegramId
      ),

      db(
        cfg,
        badgesUrl
      ),

      db(
        cfg,
        allocationsUrl
      )
    ]);

  if (!user) {
    return null;
  }

  return {
    telegram: {
      id:
        user.telegram_id,

      username:
        user.username,

      firstName:
        user.first_name
    },

    wallet: {
      address:
        wallet.wallet_address,

      chainId:
        wallet.chain_id,

      verified:
        wallet.wallet_verified ===
        true,

      verifiedAt:
        wallet.verified_at,

      lastLoginAt:
        wallet.last_login_at
    },

    points:
      user.balance,

    miningSince:
      user.created_at,

    country:
      user.country,

    checkinStreak:
      user.checkin_streak,

    badges:
      Array.isArray(
        badges
      )
        ? badges
        : [],

    allocations:
      Array.isArray(
        allocations
      )
        ? allocations
        : []
  };
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

    return reply(
      res,
      405,
      {
        error:
          'METHOD_NOT_ALLOWED'
      }
    );
  }

  const cfg =
    config();

  if (!cfg) {
    return reply(
      res,
      500,
      {
        error:
          'SERVER_CONFIGURATION_ERROR'
      }
    );
  }

  const challengeId =
    typeof req.body
      ?.challengeId ===
      'string'
      ? req.body
          .challengeId
          .trim()
      : '';

  const nonce =
    typeof req.body
      ?.nonce ===
      'string'
      ? req.body
          .nonce
          .trim()
          .toLowerCase()
      : '';

  const message =
    typeof req.body
      ?.message ===
      'string'
      ? req.body.message
      : '';

  const signature =
    typeof req.body
      ?.signature ===
      'string'
      ? req.body
          .signature
          .trim()
      : '';

  if (
    !UUID_RE.test(
      challengeId
    )
  ) {
    return reply(
      res,
      400,
      {
        error:
          'INVALID_CHALLENGE_ID'
      }
    );
  }

  if (
    !NONCE_RE.test(
      nonce
    )
  ) {
    return reply(
      res,
      400,
      {
        error:
          'INVALID_NONCE'
      }
    );
  }

  if (
    !SIG_RE.test(
      signature
    ) ||
    signature.length <
      100 ||
    signature.length >
      200
  ) {
    return reply(
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
        cfg,
        challengeId
      );

    if (!challenge) {
      return reply(
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
      return reply(
        res,
        409,
        {
          error:
            'CHALLENGE_ALREADY_USED'
        }
      );
    }

    if (
      challenge.chain_id !==
      BSC_CHAIN_ID
    ) {
      return reply(
        res,
        400,
        {
          error:
            'INVALID_CHALLENGE'
        }
      );
    }

    if (
      ![
        'bind',
        'login'
      ].includes(
        challenge.purpose
      )
    ) {
      return reply(
        res,
        400,
        {
          error:
            'INVALID_CHALLENGE'
        }
      );
    }

    if (
      Date.parse(
        challenge.expires_at
      ) <=
      Date.now()
    ) {
      return reply(
        res,
        410,
        {
          error:
            'CHALLENGE_EXPIRED'
        }
      );
    }

    const nonceHash =
      createHash(
        'sha256'
      )
        .update(
          nonce,
          'utf8'
        )
        .digest('hex');

    if (
      !safeHexEqual(
        nonceHash,
        challenge.nonce_hash
      )
    ) {
      return reply(
        res,
        400,
        {
          error:
            'INVALID_NONCE'
        }
      );
    }

    if (
      !validateMessage(
        message,
        challenge,
        nonce
      )
    ) {
      return reply(
        res,
        400,
        {
          error:
            'INVALID_SIGNED_MESSAGE'
        }
      );
    }

    let recovered;

    try {
      recovered =
        verifyMessage(
          message,
          signature
        ).toLowerCase();
    } catch {
      return reply(
        res,
        401,
        {
          error:
            'SIGNATURE_VERIFICATION_FAILED'
        }
      );
    }

    if (
      recovered !==
      challenge
        .wallet_address
        .toLowerCase()
    ) {
      return reply(
        res,
        401,
        {
          error:
            'WALLET_SIGNATURE_MISMATCH'
        }
      );
    }

    if (
      challenge.purpose ===
      'bind'
    ) {
      const token =
        botToken();

      if (!token) {
        return reply(
          res,
          500,
          {
            error:
              'TELEGRAM_AUTH_NOT_CONFIGURED'
          }
        );
      }

      const tg =
        verifyTelegram(
          req.body
            ?.telegramAuth,
          token
        );

      if (!tg.ok) {
        return reply(
          res,
          401,
          {
            error:
              tg.error
          }
        );
      }

      const user =
        await getUser(
          cfg,
          tg.id
        );

      if (!user) {
        return reply(
          res,
          404,
          {
            error:
              'TELEGRAM_USER_NOT_FOUND'
          }
        );
      }

      const existingForUser =
        await getWalletBy(
          cfg,
          'telegram_id',
          tg.id
        );

      if (
        existingForUser &&
        existingForUser
          .wallet_address
          .toLowerCase() !==
          challenge
            .wallet_address
            .toLowerCase()
      ) {
        return reply(
          res,
          409,
          {
            error:
              'TELEGRAM_ACCOUNT_ALREADY_LINKED'
          }
        );
      }

      const existingForWallet =
        await getWalletBy(
          cfg,
          'wallet_address',
          challenge
            .wallet_address
            .toLowerCase()
        );

      if (
        existingForWallet &&
        existingForWallet
          .telegram_id !==
          tg.id
      ) {
        return reply(
          res,
          409,
          {
            error:
              'WALLET_ALREADY_LINKED'
          }
        );
      }

      const consumed =
        await consumeChallenge(
          cfg,
          challenge,
          tg.id
        );

      if (!consumed) {
        return reply(
          res,
          409,
          {
            error:
              'CHALLENGE_ALREADY_USED'
          }
        );
      }

      let wallet =
        existingForUser ||
        existingForWallet;

      if (!wallet) {
        try {
          wallet =
            await createWallet(
              cfg,
              tg.id,

              challenge
                .wallet_address
                .toLowerCase()
            );
        } catch (error) {
          if (
            error?.status ===
            409
          ) {
            return reply(
              res,
              409,
              {
                error:
                  'WALLET_BINDING_CONFLICT'
              }
            );
          }

          throw error;
        }
      } else {
        wallet =
          await touchWallet(
            cfg,
            wallet,
            true
          );
      }

      return reply(
        res,
        200,
        {
          success: true,

          action:
            'bound',

          dashboard:
            await dashboard(
              cfg,
              tg.id,
              wallet
            )
        }
      );
    }

    const wallet =
      await getWalletBy(
        cfg,
        'wallet_address',

        challenge
          .wallet_address
          .toLowerCase()
      );

    if (
      !wallet ||
      wallet.wallet_verified !==
        true
    ) {
      return reply(
        res,
        404,
        {
          error:
            'WALLET_NOT_LINKED'
        }
      );
    }

    const consumed =
      await consumeChallenge(
        cfg,
        challenge,
        wallet.telegram_id
      );

    if (!consumed) {
      return reply(
        res,
        409,
        {
          error:
            'CHALLENGE_ALREADY_USED'
        }
      );
    }

    const updatedWallet =
      await touchWallet(
        cfg,
        wallet,
        false
      );

    const data =
      await dashboard(
        cfg,
        wallet.telegram_id,
        updatedWallet
      );

    if (!data) {
      return reply(
        res,
        404,
        {
          error:
            'TELEGRAM_USER_NOT_FOUND'
        }
      );
    }

    return reply(
      res,
      200,
      {
        success: true,

        action:
          'login',

        dashboard:
          data
      }
    );
  } catch (error) {
    console.error(
      'wallet-verify:',
      error
    );

    return reply(
      res,
      500,
      {
        error:
          'WALLET_VERIFICATION_FAILED'
      }
    );
  }
}
