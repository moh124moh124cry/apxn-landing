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

// Keep the existing preview/production behavior unchanged.
const SITE_MODE =
  String(process.env.APXN_SITE_MODE || "preview")
    .trim()
    .toLowerCase();

// Apex Network's official Google AdSense publisher ID.
const ADSENSE_PUBLISHER_ID = "ca-pub-1953091750666383";
const ADSENSE_SCRIPT =
  `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>`;
const ADS_TXT_RECORD =
  "google.com, pub-1953091750666383, DIRECT, f08c47fec0942fa0";

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
  "sw.js",
  "ads.txt"
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
  // Preserve the existing production-only blog indexing behavior.
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

// Inject the official script into <head> once, without modifying
// the source HTML pages. New articles receive it on every build.
function addAdSenseToHtml(html, filePath) {
  const scriptTags = html.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/pagead\/js\/adsbygoogle\.js[^"']*["'][^>]*>\s*<\/script>/gi) || [];

  if (scriptTags.length > 0) {
    if (
      scriptTags.length !== 1 ||
      !scriptTags[0].includes(ADSENSE_PUBLISHER_ID)
    ) {
      throw new Error(
        `Unexpected or duplicate AdSense script in ${filePath}. Review it before deploying.`
      );
    }
    return html;
  }

  if (!/<head\b[^>]*>/i.test(html)) {
    throw new Error(`Missing <head> in public page: ${filePath}`);
  }

  return html.replace(
    /<head\b[^>]*>/i,
    (openingTag) => `${openingTag}\n    ${ADSENSE_SCRIPT}`
  );
}

async function addAdSenseToPublicPages(directory, isRoot = false) {
  let count = 0;
  const entries = await readdir(directory, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      // Never run publisher ads on the private admin interface.
      if (isRoot && entry.name === "blog-admin") continue;
      count += await addAdSenseToPublicPages(fullPath);
      continue;
    }

    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".html") {
      continue;
    }

    // The secure account dashboard is not an editorial ad page.
    if (isRoot && entry.name === "dashboard.html") continue;

    const original = await readFile(fullPath, "utf8");
    const updated = addAdSenseToHtml(original, fullPath);
    if (updated !== original) {
      await writeFile(fullPath, updated, "utf8");
    }
    count += 1;
  }

  return count;
}

async function ensureAdsTxt() {
  const path = join(OUTPUT, "ads.txt");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const lines = existing.split(/\r?\n/);
  const hasGoogleRecord = lines.some(
    (line) => line.trim() === ADS_TXT_RECORD
  );

  if (!hasGoogleRecord) {
    const prefix = existing.trimEnd();
    const content = prefix
      ? `${prefix}\n${ADS_TXT_RECORD}\n`
      : `${ADS_TXT_RECORD}\n`;
    await writeFile(path, content, "utf8");
  }
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

  // Blog administration interface (server-side authentication).
  await copyAllowedFiles(
    join(ROOT, "blog-admin"),
    join(OUTPUT, "blog-admin"),
    new Set([".html"])
  );

  if (SITE_MODE === "production") {
    await prepareProductionAssets();
  }

  // Cloudflare serves .cloudflare-static as assets, so the script
  // must be added during this build rather than in the Worker.
  const publicPageCount = await addAdSenseToPublicPages(OUTPUT, true);
  await ensureAdsTxt();

  console.log(
    `Google AdSense ${ADSENSE_PUBLISHER_ID} added to ${publicPageCount} public HTML pages.`
  );
  console.log(
    "Google AdSense ads.txt published to /ads.txt."
  );
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

