import { handleStats } from "./api/stats.mjs";

import {
  handleDashboardSession
} from "./api/dashboard-session.mjs";

import {
  handleDashboardData
} from "./api/dashboard-data.mjs";

import {
  handleDashboardLogin
} from "./api/dashboard-login.mjs";

import {
  handleEarnTasks
} from "./api/earn-tasks.mjs";

import {
  handleBlogAdminAuth
} from "./api/blog-admin-auth.mjs";

import {
  handleBlogAdminArticles
} from "./api/blog-admin-articles.mjs";

import {
  handleBlogAdminKnowledge
} from "./api/blog-admin-knowledge.mjs";

import {
  handleBlogAdminPublish
} from "./api/blog-admin-publish.mjs";

// Cloudflare invokes this handler only after Cron Triggers are configured.
// Article writing remains in GitHub Actions; publishing remains manual.
const BLOG_GENERATION_CRONS = new Set([
  "17 8 * * 1",
  "17 8 * * 3",
  "17 8 * * 6"
]);

async function dispatchReadyBlogGeneration(env) {
  const repository = String(env.BLOG_GITHUB_REPO || "").trim();
  const branch = String(env.BLOG_GITHUB_BRANCH || "").trim();

  // Never trigger the writer on main or an unexpected repository.
  if (
    repository !== "moh124moh124cry/apxn-landing" ||
    branch !== "cloudflare-migration"
  ) {
    throw new Error("APXN_BLOG_CRON_REPOSITORY_OR_BRANCH_MISMATCH");
  }

  // Separate, least-privilege token: GitHub Actions permission = write.
  // Configure BLOG_ACTIONS_TOKEN as a Cloudflare secret, not in this file.
  const token = String(env.BLOG_ACTIONS_TOKEN || "").trim();
  if (!token) {
    throw new Error("APXN_BLOG_CRON_ACTIONS_TOKEN_MISSING");
  }

  const response = await fetch(
    "https://api.github.com/repos/moh124moh124cry/apxn-landing" +
      "/actions/workflows/blog-writer.yml/dispatches",
    {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "APXN-Cloudflare-Blog-Cron",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ ref: "cloudflare-migration" })
    }
  );

  if (!response.ok) {
    throw new Error(
      `APXN_BLOG_CRON_DISPATCH_FAILED_HTTP_${response.status}`
    );
  }

  console.log("APXN ready-article generation dispatched to GitHub Actions.");
}

export default {
  async scheduled(controller, env) {
    // Do not run any other scheduled task through this blog trigger.
    if (!BLOG_GENERATION_CRONS.has(controller.cron)) {
      console.log("Ignoring unrecognized APXN blog cron trigger.");
      return;
    }

    await dispatchReadyBlogGeneration(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // APXN public statistics API.
    if (url.pathname === "/api/stats") {
      return handleStats(request, env);
    }

    // APXN dashboard logout.
    if (
      url.pathname === "/api/dashboard-session"
    ) {
      return handleDashboardSession(request, env);
    }

    // APXN dashboard data.
    if (
      url.pathname === "/api/dashboard-data"
    ) {
      return handleDashboardData(request, env);
    }

    // APXN dashboard Telegram login.
    if (
      url.pathname === "/api/dashboard-login"
    ) {
      // Fail closed unless the registered redirect URI belongs
      // to the host that received this request. Never silently
      // send a preview-domain login callback to apxn.network.
      const expectedRedirectUri =
        `${url.origin}/api/dashboard-login`;

      const configuredRedirectUri =
        env.TELEGRAM_REDIRECT_URI ||
        (url.hostname === "apxn.network"
          ? "https://apxn.network/api/dashboard-login"
          : "");

      if (
        configuredRedirectUri !== expectedRedirectUri ||
        !env.TELEGRAM_CLIENT_ID ||
        !env.TELEGRAM_CLIENT_SECRET
      ) {
        return new Response(
          JSON.stringify({
            error: "PREVIEW_LOGIN_NOT_CONFIGURED"
          }),
          {
            status: 503,
            headers: {
              "Content-Type":
                "application/json; charset=utf-8",
              "Cache-Control": "no-store"
            }
          }
        );
      }

      return handleDashboardLogin(request, env);
    }

    // APXN earning tasks.
    if (
      url.pathname === "/api/earn-tasks"
    ) {
      return handleEarnTasks(request, env);
    }

    // APXN blog administrator authentication.
    if (
      url.pathname === "/api/blog-admin-auth"
    ) {
      return handleBlogAdminAuth(request, env);
    }

    // Authenticated blog article list.
    if (
      url.pathname === "/api/blog-admin-articles"
    ) {
      return handleBlogAdminArticles(request, env);
    }

    // APXN blog knowledge bank.
    if (
      url.pathname === "/api/blog-admin-knowledge"
    ) {
      return handleBlogAdminKnowledge(request, env);
    }

    // APXN blog article publishing.
    if (
      url.pathname === "/api/blog-admin-publish"
    ) {
      return handleBlogAdminPublish(request, env);
    }

    // Remaining API endpoints are not migrated yet.
    if (
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/")
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "APXN API migration is not complete."
        }),
        {
          status: 503,
          headers: {
            "Content-Type":
              "application/json; charset=utf-8",
            "Cache-Control": "no-store"
          }
        }
      );
    }

    // Serve the prepared public website assets.
    return env.ASSETS.fetch(request);
  }
};


