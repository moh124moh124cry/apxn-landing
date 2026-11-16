/**
 * APXN Blog Administration — Cloudflare management API adapter.
 *
 * GitHub target path:
 *   cloudflare/api/blog-admin-manage.mjs
 *
 * This file bridges POST /api/blog-admin-manage to the protected
 * management handler in api/blog-admin-manage.js.
 *
 * It does not modify article content or write to GitHub by itself.
 * The frontend and the API handler both remain responsible for
 * their own validation. Do not expose secrets to the browser.
 */

import blogAdminManageHandler from "../../api/blog-admin-manage.js";
import { runLegacyHandler } from "./legacy-adapter.mjs";

const REPOSITORY = "moh124moh124cry/apxn-landing";
const BRANCH = "cloudflare-migration";

// The same permitted hosts as the existing blog-publish endpoint.
const ALLOWED_HOSTS = new Set([
  "apxn.network",
  "apxn-landing.apxn-network.workers.dev"
]);

// Accommodates a 3 MB image after Base64 encoding and JSON metadata.
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;

function json(data, status, additionalHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...additionalHeaders
    }
  });
}

function getEnvironment(name, env) {
  const workerValue = String(env?.[name] ?? "").trim();
  const handlerValue = String(process.env?.[name] ?? "").trim();
  return { workerValue, handlerValue };
}

/**
 * A dedicated, guarded route for editing blog articles.
 *
 * Required runtime configuration (already used by the existing
 * publisher):
 *   BLOG_GITHUB_REPO, BLOG_GITHUB_BRANCH, BLOG_GITHUB_TOKEN,
 *   BLOG_ADMIN_SECRET.
 *
 * The imported handler validates the authenticated admin session,
 * the Origin, the article fields, and GitHub's current state.
 */
export async function handleBlogAdminManage(request, env) {
  if (request.method !== "POST") {
    return json(
      { success: false, error: "METHOD_NOT_ALLOWED" },
      405,
      { Allow: "POST" }
    );
  }

  let hostname;
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    return json({ success: false, error: "INVALID_REQUEST_URL" }, 400);
  }

  if (!ALLOWED_HOSTS.has(hostname)) {
    return json(
      { success: false, error: "BLOG_MANAGE_HOST_NOT_ALLOWED" },
      403
    );
  }

  const configuredRepo = getEnvironment("BLOG_GITHUB_REPO", env);
  const configuredBranch = getEnvironment("BLOG_GITHUB_BRANCH", env);

  if (
    configuredRepo.workerValue !== REPOSITORY ||
    configuredRepo.handlerValue !== REPOSITORY ||
    configuredBranch.workerValue !== BRANCH ||
    configuredBranch.handlerValue !== BRANCH
  ) {
    return json(
      { success: false, error: "BLOG_MANAGE_BRANCH_MISMATCH" },
      503
    );
  }

  const configuredToken = getEnvironment("BLOG_GITHUB_TOKEN", env);
  if (
    configuredToken.workerValue.length < 20 ||
    configuredToken.handlerValue.length < 20 ||
    configuredToken.workerValue !== configuredToken.handlerValue
  ) {
    return json(
      { success: false, error: "BLOG_GITHUB_TOKEN_NOT_CONFIGURED" },
      503
    );
  }

  const contentType = String(request.headers.get("content-type") || "")
    .toLowerCase();

  if (!contentType.includes("application/json")) {
    return json(
      { success: false, error: "JSON_CONTENT_TYPE_REQUIRED" },
      415
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REQUEST_BYTES
  ) {
    return json(
      { success: false, error: "REQUEST_TOO_LARGE" },
      413
    );
  }

  // The legacy adapter preserves request cookies, method, JSON body,
  // response status, and authorization checks of the existing handler.
  return runLegacyHandler(request, blogAdminManageHandler);
}

