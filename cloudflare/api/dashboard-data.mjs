
import dashboardDataHandler
  from "../../api/dashboard-data.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

export async function handleDashboardData(
  request,
  env
) {
  // Preserve the original handler's
  // method validation.
  if (request.method !== "GET") {
    return runLegacyHandler(
      request,
      dashboardDataHandler
    );
  }

  // A visitor without a dashboard session
  // does not need Supabase or Telegram
  // configuration merely to see the
  // normal sign-in screen.
  const cookieHeader =
    request.headers.get("cookie") || "";

  const sessionCookie =
    cookieHeader.match(
      /(?:^|;\s*)apxn_dashboard_session\s*=\s*([^;]*)/
    );

  if (
    !sessionCookie ||
    !sessionCookie[1]
  ) {
    return new Response(
      JSON.stringify({
        error: "AUTH_REQUIRED"
      }),
      {
        status: 401,
        headers: {
          "Content-Type":
            "application/json; charset=utf-8",
          "Cache-Control":
            "no-store, max-age=0",
          "Pragma": "no-cache",
          "Vary": "Cookie",
          "X-Content-Type-Options":
            "nosniff",
          "Referrer-Policy":
            "no-referrer"
        }
      }
    );
  }

  // If a session cookie is present,
  // leave authentication and database
  // access to the original APXN handler.
  return runLegacyHandler(
    request,
    dashboardDataHandler
  );
}
