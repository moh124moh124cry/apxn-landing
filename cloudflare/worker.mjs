
import { handleStats } from "./api/stats.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // APXN public statistics API.
    if (url.pathname === "/api/stats") {
      return handleStats(request, env);
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
