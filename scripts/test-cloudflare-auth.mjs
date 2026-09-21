
import assert from "node:assert/strict";

import worker from "../cloudflare/worker.mjs";

// A fake password used only during this test.
const TEST_SECRET =
  "apxn-local-test-secret-not-real-2026";

process.env.BLOG_ADMIN_SECRET =
  TEST_SECRET;

const env = {
  BLOG_ADMIN_SECRET: TEST_SECRET,

  ASSETS: {
    fetch: async () =>
      new Response("ASSETS_OK")
  }
};

async function request(
  method,
  path,
  options = {}
) {
  return worker.fetch(
    new Request(
      `https://preview.apxn.test${path}`,
      {
        method,
        ...options
      }
    ),
    env
  );
}

// No session: the administrator is logged out.
const initial = await request(
  "GET",
  "/api/blog-admin-auth"
);

assert.equal(initial.status, 200);

assert.equal(
  (await initial.json()).authenticated,
  false
);

// An incorrect password must be rejected.
const incorrect = await request(
  "POST",
  "/api/blog-admin-auth",
  {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: "incorrect-test-password"
    })
  }
);

assert.equal(incorrect.status, 401);

// The fake test password creates a session.
const login = await request(
  "POST",
  "/api/blog-admin-auth",
  {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: TEST_SECRET
    })
  }
);

assert.equal(login.status, 200);

assert.equal(
  (await login.json()).authenticated,
  true
);

const setCookie =
  login.headers.get("Set-Cookie");

assert.ok(setCookie);

const cookie =
  setCookie.split(";")[0];

// The signed session must be accepted.
const authenticated = await request(
  "GET",
  "/api/blog-admin-auth",
  {
    headers: {
      Cookie: cookie
    }
  }
);

assert.equal(
  (await authenticated.json()).authenticated,
  true
);

// Without a session, article drafts stay private.
const privateArticles = await request(
  "GET",
  "/api/blog-admin-articles"
);

assert.equal(
  privateArticles.status,
  401
);

// Logging out must instruct the browser
// to remove the session cookie.
const logout = await request(
  "DELETE",
  "/api/blog-admin-auth",
  {
    headers: {
      Cookie: cookie
    }
  }
);

assert.equal(logout.status, 200);

assert.match(
  logout.headers.get("Set-Cookie") || "",
  /Max-Age=0/i
);

assert.equal(
  (await logout.json()).authenticated,
  false
);

delete process.env.BLOG_ADMIN_SECRET;

console.log(
  "APXN blog admin authentication tests passed."
);
