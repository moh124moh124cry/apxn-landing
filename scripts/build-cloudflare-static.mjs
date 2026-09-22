import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
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

const PREVIEW_ORIGIN =
  "https://apxn-landing.cherfaouimohamed377.workers.dev";

const PRODUCTION_ORIGIN =
  "https://apxn.network";

// Default is the existing, unchanged preview build.
// Production preparation is opt-in, at the final cutover only.
const SITE_MODE =
  String(process.env.APXN_SITE_MODE || "preview")
    .trim()
    .toLowerCase();

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

function restoreBlogIndexing(html) {
  // Restore the public blog's indexability only in an explicitly
  // requested production build. Never change account/admin pages.
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!/\bname\s*=\s*["']robots["']/i.test(tag)) {
      return tag;
    }

    return tag.replace(
      /(\bcontent\s*=\s*["'])\s*noindex\s*,\s*nofollow\s*(["'])/i,
      "$1index, follow$2"
    );
  });
}

async function prepareProductionAssets() {
  const htmlFiles = [
    join(OUTPUT, "blog", "index.html")
  ];

  const articleFolder = join(
    OUTPUT,
    "blog",
    "articles"
  );

  for (const entry of await readdir(articleFolder, {
    withFileTypes: true
  })) {
    if (
      entry.isFile() &&
      extname(entry.name).toLowerCase() === ".html"
    ) {
      htmlFiles.push(join(articleFolder, entry.name));
    }
  }

  for (const file of htmlFiles) {
    const original = await readFile(file, "utf8");

    const prepared = restoreBlogIndexing(
      original.replaceAll(
        PREVIEW_ORIGIN,
        PRODUCTION_ORIGIN
      )
    );

    if (prepared !== original) {
      await writeFile(file, prepared, "utf8");
    }
  }

  const sitemap = join(OUTPUT, "sitemap.xml");
  const originalSitemap = await readFile(sitemap, "utf8");

  const productionSitemap = originalSitemap.replaceAll(
    PREVIEW_ORIGIN,
    PRODUCTION_ORIGIN
  );

  if (productionSitemap !== originalSitemap) {
    await writeFile(
      sitemap,
      productionSitemap,
      "utf8"
    );
  }

  console.log(
    "Production blog assets prepared for apxn.network."
  );
}

async function build() {
  if (
    SITE_MODE !== "preview" &&
    SITE_MODE !== "production"
  ) {
    throw new Error(
      "APXN_SITE_MODE must be preview or production."
    );
  }

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

  if (SITE_MODE === "production") {
    await prepareProductionAssets();
  }

  console.log(
    "APXN public assets prepared successfully."
  );

  console.log(
    "Output directory: .cloudflare-static"
  );

  console.log(
    `Site build mode: ${SITE_MODE}`
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

