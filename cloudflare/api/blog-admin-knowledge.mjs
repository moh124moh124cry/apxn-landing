
import blogAdminKnowledgeHandler
  from "../../api/blog-admin-knowledge.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

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

export async function handleBlogAdminKnowledge(
  request,
  env
) {
  // Never allow the migration test to write
  // to the production GitHub branch.
  if (
    env.BLOG_GITHUB_BRANCH !==
    "cloudflare-migration"
  ) {
    return json(
      {
        success: false,
        error:
          "MIGRATION_TEST_BRANCH_REQUIRED"
      },
      503
    );
  }

  if (!env.BLOG_GITHUB_TOKEN) {
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
    blogAdminKnowledgeHandler
  );
}
