
import {
  copyFile,
  mkdir,
  readdir,
  rm
} from "node:fs/promises";

import {
  dirname,
  extname,
  join,
  resolve
} from "node:path";

import { fileURLToPath } from "node:url";

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

const OUTPUT = join(ROOT, ".cloudflare-static");

const ROOT_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2"
]);

const ROOT_SPECIAL_FILES = new Set([
  "robots.txt",
  "sitemap.xml",
  "sw.js"
]);

async function copyAllowedFiles(
  source,
  destination,
  allowedExtensions,
  allowedNames = new Set()
) {
  await mkdir(destination, { recursive: true });

  const entries = await readdir(source, {
    withFileTypes: true
  });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const extension = extname(
      entry.name
    ).toLowerCase();

    const allowed =
      allowedExtensions.has(extension) ||
      allowedNames.has(entry.name);

    if (!allowed) continue;

    await copyFile(
      join(source, entry.name),
      join(destination, entry.name)
    );
  }
}

async function build() {
  await rm(OUTPUT, {
    recursive: true,
    force: true
  });

  await mkdir(OUTPUT, {
    recursive: true
  });

  // Public website pages and assets.
  await copyAllowedFiles(
    ROOT,
    OUTPUT,
    ROOT_EXTENSIONS,
    ROOT_SPECIAL_FILES
  );

  // Public blog homepage.
  await copyAllowedFiles(
    join(ROOT, "blog"),
    join(OUTPUT, "blog"),
    new Set([".html"])
  );

  // Published articles only.
  await copyAllowedFiles(
    join(ROOT, "blog", "articles"),
    join(OUTPUT, "blog", "articles"),
    new Set([".html"])
  );

  // Published blog images only.
  await copyAllowedFiles(
    join(ROOT, "blog", "images"),
    join(OUTPUT, "blog", "images"),
    new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".svg"
    ])
  );

  // Blog administration interface.
  // Authentication remains server-side.
  await copyAllowedFiles(
    join(ROOT, "blog-admin"),
    join(OUTPUT, "blog-admin"),
    new Set([".html"])
  );

  console.log(
    "APXN public assets prepared successfully."
  );

  console.log(
    "Output directory: .cloudflare-static"
  );

  console.log(
    "Private data, API and scripts directories were not copied."
  );
}

build().catch((error) => {
  console.error(
    "APXN Cloudflare build failed:",
    error
  );

  process.exitCode = 1;
});
