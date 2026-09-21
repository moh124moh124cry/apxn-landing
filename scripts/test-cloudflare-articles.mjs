
import assert from "node:assert/strict";

import worker from "../cloudflare/worker.mjs";

const TEST_SECRET =
  "apxn-articles-test-secret-not-real-2026";

process.env.BLOG_ADMIN_SECRET =
  TEST_SECRET;

const env = {
  BLOG_ADMIN_SECRET: TEST_SECRET,
  BLOG_GITHUB_REPO:
    "moh124moh124cry/apxn-landing",
  BLOG_GITHUB_BRANCH:
    "cloudflare-migration",
  BLOG_GITHUB_TOKEN:
    "fake-github-token-for-test-only",

  ASSETS: {
    fetch: async () =>
      new Response("ASSETS_OK")
  }
};

async function endpoint(
  path,
  options = {}
) {
  return worker.fetch(
    new Request(
      `https://preview.apxn.test${path}`,
      options
    ),
    env
  );
}

const originalFetch = globalThis.fetch;

try {
  // A visitor without an administrator
  // session must not see article drafts.
  const unauthorized = await endpoint(
    "/api/blog-admin-articles"
  );

  assert.equal(
    unauthorized.status,
    401
  );

  // Sign in using a fake test password.
  const login = await endpoint(
    "/api/blog-admin-auth",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        secret: TEST_SECRET
      })
    }
  );

  assert.equal(login.status, 200);

  const cookie = (
    login.headers.get("Set-Cookie") || ""
  ).split(";")[0];

  assert.ok(cookie);

  // Replace GitHub's network response with
  // two fake articles used only in this test.
  const fakeManifest = {
    articles: [
      {
        id: "test-draft",
        slug: "test-draft",
        title: "Unpublished APXN Test Draft",
        status: "draft",
        language: "en",
        content: {
          introduction:
            "Private test introduction"
        }
      },
      {
        id: "test-published",
        slug: "test-published",
        title: "Published APXN Test Article",
        status: "published",
        language: "en"
      }
    ]
  };

  globalThis.fetch = async (
    url,
    options = {}
  ) => {
    assert.match(
      String(url),
      /\/contents\/data\/blog-articles\.json/
    );

    assert.match(
      String(url),
      /ref=cloudflare-migration/
    );

    assert.equal(
      options.headers?.Authorization,
      "Bearer fake-github-token-for-test-only"
    );

    return new Response(
      JSON.stringify({
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify(fakeManifest)
        ).toString("base64")
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json"
        }
      }
    );
  };

  const articlesResponse =
    await endpoint(
      "/api/blog-admin-articles",
      {
        headers: {
          Cookie: cookie
        }
      }
    );

  assert.equal(
    articlesResponse.status,
    200
  );

  const result =
    await articlesResponse.json();

  assert.equal(
    result.authenticated,
    true
  );

  assert.equal(
    result.stats.total,
    2
  );

  assert.equal(
    result.stats.drafts,
    1
  );

  assert.equal(
    result.stats.published,
    1
  );

  assert.equal(
    result.articles[0].title,
    "Unpublished APXN Test Draft"
  );

  assert.equal(
    result.articles[0].content.introduction,
    "Private test introduction"
  );

  console.log(
    "APXN blog article access tests passed."
  );

} finally {
  globalThis.fetch = originalFetch;
  delete process.env.BLOG_ADMIN_SECRET;
}
