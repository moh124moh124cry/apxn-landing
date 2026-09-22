import blogAdminPublishHandler
  from "../../api/blog-admin-publish.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

const REPOSITORY =
  "moh124moh124cry/apxn-landing";

const PREVIEW_BRANCH =
  "cloudflare-migration";

const PRODUCTION_BRANCH =
  "main";

const PREVIEW_HOST =
  "apxn-landing.cherfaouimohamed377.workers.dev";

const PRODUCTION_HOST =
  "apxn.network";

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
  const hostname =
    new URL(request.url).hostname.toLowerCase();

  const workerBranch =
    String(env.BLOG_GITHUB_BRANCH || "").trim();

  const legacyBranch =
    String(process.env.BLOG_GITHUB_BRANCH || "").trim();

  const workerRepository =
    String(env.BLOG_GITHUB_REPO || REPOSITORY).trim();

  const legacyRepository =
    String(process.env.BLOG_GITHUB_REPO || REPOSITORY).trim();

  // A preview hostname may write only to the preview branch.
  // The real hostname may write only to main.
  // Never allow a branch/hostname mix-up to publish an article.
  const previewConfigured =
    hostname === PREVIEW_HOST &&
    workerBranch === PREVIEW_BRANCH &&
    legacyBranch === PREVIEW_BRANCH;

  const productionConfigured =
    hostname === PRODUCTION_HOST &&
    workerBranch === PRODUCTION_BRANCH &&
    legacyBranch === PRODUCTION_BRANCH;

  if (
    (!previewConfigured && !productionConfigured) ||
    workerRepository !== REPOSITORY ||
    legacyRepository !== REPOSITORY
  ) {
    return json(
      {
        success: false,
        error: "BLOG_PUBLISH_ENVIRONMENT_MISMATCH"
      },
      503
    );
  }

  const workerToken =
    String(env.BLOG_GITHUB_TOKEN || "").trim();

  const legacyToken =
    String(process.env.BLOG_GITHUB_TOKEN || "").trim();

  if (
    workerToken.length < 20 ||
    workerToken !== legacyToken
  ) {
    return json(
      {
        success: false,
        error: "BLOG_GITHUB_TOKEN_NOT_CONFIGURED"
      },
      503
    );
  }

  return runLegacyHandler(
    request,
    blogAdminPublishHandler
  );
}

