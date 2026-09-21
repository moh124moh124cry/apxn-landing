
const SESSION_COOKIE = "apxn_dashboard_session";

function expiredCookie(name, path = "/") {
  return [
    `${name}=`,
    `Path=${path}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");
}

export async function handleDashboardSession(
  request,
  env
) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });

  if (request.method !== "POST") {
    headers.set("Allow", "POST");

    return new Response(
      JSON.stringify({
        error: "METHOD_NOT_ALLOWED"
      }),
      {
        status: 405,
        headers
      }
    );
  }

  const cookiesToClear = [
    expiredCookie(SESSION_COOKIE, "/"),
    expiredCookie("apxn_tg_session", "/"),
    expiredCookie(
      "apxn_tg_state",
      "/api/telegram-callback"
    ),
    expiredCookie(
      "apxn_tg_verifier",
      "/api/telegram-callback"
    ),
    expiredCookie(
      "apxn_tg_nonce",
      "/api/telegram-callback"
    )
  ];

  for (const cookie of cookiesToClear) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(
    JSON.stringify({
      success: true,
      authenticated: false
    }),
    {
      status: 200,
      headers
    }
  );
}
