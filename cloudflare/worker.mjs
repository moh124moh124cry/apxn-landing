
import { handleStats } from "./api/stats.mjs";

import {
  handleDashboardSession
} from "./api/dashboard-session.mjs";

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
