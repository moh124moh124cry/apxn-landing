
import blogAdminPublishHandler
  from "../../api/blog-admin-publish.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

const TEST_REPOSITORY =
  "moh124moh124cry/apxn-landing";

const TEST_BRANCH =
  "cloudflare-migration";

function json(data, status) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

export async function handleBlogAdminPublish(
  request,
  env
) {
  // Do not permit the migration preview
  // to publish to the production branch.

  const workerBranch =
    env.BLOG_GITHUB_BRANCH;

  const originalHandlerBranch =
    process.env.BLOG_GITHUB_BRANCH;

  const workerRepository =
    env.BLOG_GITHUB_REPO ||
    TEST_REPOSITORY;

  const originalHandlerRepository =
    process.env.BLOG_GITHUB_REPO ||
    TEST_REPOSITORY;

  if (
    workerBranch !== TEST_BRANCH ||
    originalHandlerBranch !== TEST_BRANCH ||
    workerRepository !== TEST_REPOSITORY ||
    originalHandlerRepository !== TEST_REPOSITORY
  ) {
    return json(
      {
        success: false,
        error:
          "MIGRATION_TEST_CONFIGURATION_REQUIRED"
      },
      503
    );
  }

  const workerToken =
    String(
      env.BLOG_GITHUB_TOKEN || ""
    ).trim();

  const originalHandlerToken =
    String(
      process.env.BLOG_GITHUB_TOKEN || ""
    ).trim();

  if (
    workerToken.length < 20 ||
    workerToken !== originalHandlerToken
  ) {
    return json(
      {
        success: false,
        error:
          "BLOG_GITHUB_TOKEN_NOT_CONFIGURED"
      },
      503
    );
  }

  return runLegacyHandler(
    request,
    blogAdminPublishHandler
  );
}
