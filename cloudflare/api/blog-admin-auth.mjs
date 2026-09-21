import blogAdminAuthHandler from "../../api/blog-admin-auth.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

export async function handleBlogAdminAuth(
  request,
  env
) {
  return runLegacyHandler(
    request,
    blogAdminAuthHandler
  );
}
