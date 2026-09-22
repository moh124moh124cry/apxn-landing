import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import earnTasksHandler from "../../api/earn-tasks.js";
import { runLegacyHandler } from "./legacy-adapter.mjs";

// This Cloudflare-only adapter preserves the original APXN GET/POST
// reward handler. The extra GET field reports previously claimed
// tasks for the authenticated Telegram account.
function telegramIdFromSession(request, env) {
  const secret = env.TELEGRAM_CLIENT_SECRET;
  if (!secret) return null;

  const cookieHeader = request.headers.get("cookie") || "";
  const rawCookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("apxn_dashboard_session="));

  if (!rawCookie) return null;

  let token;
  try {
    token = decodeURIComponent(rawCookie.slice("apxn_dashboard_session=".length));
  } catch {
    return null;
  }

  if (!token || token.length > 4096) return null;

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [encodedPayload, receivedSignature] = parts;
  const sessionKey = createHash("sha256")
    .update(`apxn-dashboard-session-v1:${secret}`, "utf8")
    .digest();
  const expectedSignature = createHmac("sha256", sessionKey)
    .update(encodedPayload, "utf8")
    .digest("base64url");

  const actual = Buffer.from(receivedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
  } catch {
    return null;
  }

  const telegramId = String(payload?.telegramId ?? "").trim();
  const issuedAt = Number(payload?.issuedAt);
  const expiresAt = Number(payload?.expiresAt);
  const now = Math.floor(Date.now() / 1000);

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.version !== 1 ||
    !/^\d+$/.test(telegramId) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 60 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 12 * 60 * 60 + 60
  ) {
    return null;
  }

  return telegramId;
}

function taskClaimId(task) {
  // Match the original makeClaimKey() in api/earn-tasks.js.
  const canonicalUrl = new URL(task.url).toString();
  const hash = createHash("sha256")
    .update(canonicalUrl, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${task.key}:${hash}`;
}

function withJson(baseResponse, data) {
  const headers = new Headers(baseResponse.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Vary", "Cookie");
  return new Response(JSON.stringify(data), {
    status: baseResponse.status,
    headers
  });
}

export async function handleEarnTasks(request, env) {
  // POST (actual point crediting) is unchanged, as are all original
  // authentication, reward, duplicate-claim, and RPC checks.
  const originalResponse = await runLegacyHandler(
    request,
    earnTasksHandler
  );

  if (request.method !== "GET" || !originalResponse.ok) {
    return originalResponse;
  }

  const telegramId = telegramIdFromSession(request, env);
  if (!telegramId) return originalResponse;

  let originalBody;
  try {
    originalBody = await originalResponse.clone().json();
  } catch {
    return originalResponse;
  }

  const tasks = Array.isArray(originalBody?.tasks)
    ? originalBody.tasks
    : [];
  if (!tasks.length) {
    return withJson(originalResponse, {
      ...originalBody,
      claimedKeys: [],
      claimStatusLoaded: true
    });
  }

  const supabaseUrl = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey =
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return withJson(originalResponse, {
      ...originalBody,
      claimStatusLoaded: false
    });
  }

  try {
    const idsByKey = new Map(tasks.map((task) => [
      task.key,
      taskClaimId(task)
    ]));

    const queryUrl = new URL(`${supabaseUrl}/rest/v1/website_task_claims`);
    queryUrl.searchParams.set("select", "task_id");
    queryUrl.searchParams.set("telegram_id", `eq.${telegramId}`);
    queryUrl.searchParams.set(
      "task_id",
      `in.(${[...idsByKey.values()].map((id) => `"${id}"`).join(",")})`
    );

    const result = await fetch(queryUrl.toString(), {
      method: "GET",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: "application/json"
      }
    });

    if (!result.ok) {
      console.error("APXN claim history fetch failed:", result.status);
      throw new Error("CLAIM_HISTORY_FETCH_FAILED");
    }

    const rows = await result.json();
    if (!Array.isArray(rows)) {
      throw new Error("INVALID_CLAIM_HISTORY_RESPONSE");
    }

    const claimedIds = new Set(rows.map((row) => row.task_id));
    const claimedKeys = tasks
      .filter((task) => claimedIds.has(idsByKey.get(task.key)))
      .map((task) => task.key);

    return withJson(originalResponse, {
      ...originalBody,
      claimedKeys,
      claimStatusLoaded: true
    });
  } catch (error) {
    console.error(
      "APXN claim history unavailable:",
      error?.message || "Unknown error"
    );
    // Never pretend an error means the user has not claimed a reward.
    return withJson(originalResponse, {
      ...originalBody,
      claimStatusLoaded: false
    });
  }
}

