
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

export default {
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
      // The original Telegram callback uses apxn.network.
      // Do not start login from a preview domain yet.
      if (url.hostname !== "apxn.network") {
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
