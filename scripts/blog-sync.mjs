/**
 * APXN Blog Index + Sitemap Synchronizer
 * Path: scripts/blog-sync.mjs
 *
 * What it does:
 * - Reads data/blog-config.json
 * - Reads data/blog-articles.json
 * - Uses ONLY articles with status === "published"
 * - Verifies every published article file exists before indexing it
 * - Rebuilds blog/index.html from the manifest (English-only)
 * - Rebuilds sitemap.xml with static pages + blog + published articles
 * - Never exposes drafts in the blog index or sitemap
 *
 * No external npm packages are required.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  config: path.join(ROOT, "data", "blog-config.json"),
  articles: path.join(ROOT, "data", "blog-articles.json"),
  blogIndex: path.join(ROOT, "blog", "index.html"),
  sitemap: path.join(ROOT, "sitemap.xml")
};

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Required file not found: ${path.relative(ROOT, filePath)}`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Invalid JSON in ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cleanUrlBase(value) {
  return String(value || "https://apxn.network").replace(/\/+$/, "");
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function relativeArticleHref(article) {
  const configuredPath = String(article?.path || "").trim();

  if (configuredPath.startsWith("blog/")) {
    return configuredPath.slice("blog/".length);
  }

  if (configuredPath) {
    return configuredPath.replace(/^\/+/, "");
  }

  return `articles/${String(article?.slug || "").trim()}.html`;
}

function verifyPublishedArticles(manifest) {
  if (!Array.isArray(manifest?.articles)) {
    fail("data/blog-articles.json must contain an articles array.");
  }

  const published = manifest.articles.filter(
    (article) => article?.status === "published"
  );

  const verified = [];

  for (const article of published) {
    if (!article?.slug || !article?.title) {
      fail("A published article is missing slug or title.");
    }

    const relativePath = String(
      article.path || `blog/articles/${article.slug}.html`
    ).replace(/^\/+/, "");

    const absolutePath = path.join(ROOT, relativePath);

    if (!fs.existsSync(absolutePath)) {
      fail(
        `Published article file is missing: ${relativePath}. ` +
        `The index and sitemap were not changed.`
      );
    }

    verified.push({
      ...article,
      path: relativePath
    });
  }

  verified.sort((a, b) => {
    const aDate = String(a.published_at || a.updated_at || "");
    const bDate = String(b.published_at || b.updated_at || "");

    if (aDate !== bDate) {
      return bDate.localeCompare(aDate);
    }

    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  return verified;
}

function articleSearchText(article) {
  return [
    article.title,
    article.description,
    article.category,
    ...(Array.isArray(article.keywords) ? article.keywords : [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replaceAll('"', "&quot;");
}

function renderFeaturedArticle(article) {
  if (!article) {
    return `
            <div class="border border-dashed border-slate-700 rounded-3xl p-10 text-center">
                <p class="text-xl font-black mb-2">No featured article yet</p>
                <p class="text-gray-500 text-sm">The first published article will appear here automatically.</p>
            </div>`;
  }

  const href = relativeArticleHref(article);

  return `
            <article class="article-card overflow-hidden bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 rounded-3xl">
                <div class="grid lg:grid-cols-2">
                    <div class="relative min-h-[300px] lg:min-h-[430px] flex items-center justify-center overflow-hidden border-b lg:border-b-0 lg:border-r border-slate-800">
                        <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(234,179,8,0.18),transparent_60%)]"></div>
                        <div class="relative text-center p-10">
                            <div class="w-36 h-36 sm:w-44 sm:h-44 mx-auto rounded-full p-1 bg-gradient-to-b from-yellow-300 via-yellow-500 to-yellow-800 shadow-[0_0_55px_rgba(234,179,8,0.25)]">
                                <div class="w-full h-full rounded-full overflow-hidden border-[5px] border-slate-950 bg-slate-900">
                                    <img src="../logo2%20(1).png" alt="APXN Logo" class="w-full h-full object-cover" width="176" height="176">
                                </div>
                            </div>
                            <p class="mt-6 text-yellow-400 font-black text-sm uppercase tracking-widest">${escapeHtml(article.category || "APXN")}</p>
                        </div>
                    </div>

                    <div class="p-7 sm:p-10 lg:p-12 flex flex-col justify-center">
                        <div class="flex flex-wrap gap-2 mb-5">
                            <span class="text-[11px] font-black bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 px-3 py-1.5 rounded-full">${escapeHtml(article.category || "APXN")}</span>
                            <span class="text-[11px] font-bold bg-slate-800 text-gray-400 px-3 py-1.5 rounded-full">${Number(article.reading_minutes || 1)} min read</span>
                        </div>

                        <h3 class="text-2xl sm:text-4xl font-black leading-tight mb-4">
                            ${escapeHtml(article.title)}
                        </h3>

                        <p class="text-gray-400 leading-relaxed mb-7">
                            ${escapeHtml(article.description || "")}
                        </p>

                        <div class="flex flex-wrap items-center gap-4 text-xs text-gray-500 mb-8">
                            <span>${escapeHtml(article.author || "Apex Network Editorial")}</span>
                            <span>•</span>
                            <span>${formatDate(article.published_at || article.updated_at)}</span>
                        </div>

                        <a href="${escapeHtml(href)}"
                           class="inline-flex w-fit items-center gap-2 bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black px-6 py-3.5 rounded-xl hover:scale-[1.02] transition-transform">
                            Read Article
                            <span aria-hidden="true">→</span>
                        </a>
                    </div>
                </div>
            </article>`;
}

function renderArticleCard(article) {
  const href = relativeArticleHref(article);
  const search = articleSearchText(article);

  return `
                <article class="article-card article-item bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden flex flex-col"
                         data-category="${escapeHtml(article.category || "")}"
                         data-search="${search}">
                    <div class="h-2 bg-gradient-to-r from-yellow-500 to-orange-500"></div>

                    <div class="p-6 flex flex-col flex-1">
                        <div class="flex items-center justify-between gap-3 mb-5">
                            <span class="text-[10px] font-black uppercase tracking-wider text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded-full">
                                ${escapeHtml(article.category || "APXN")}
                            </span>

                        </div>

                        <h3 class="font-black text-xl leading-snug mb-3 line-clamp-2">
                            ${escapeHtml(article.title)}
                        </h3>

                        <p class="text-sm text-gray-400 leading-relaxed line-clamp-3 mb-6">
                            ${escapeHtml(article.description || "")}
                        </p>

                        <div class="flex flex-wrap gap-3 text-xs text-gray-600 mb-5">
                            <span>${Number(article.reading_minutes || 1)} min</span>
                            <span>•</span>
                            <span>${formatDate(article.published_at || article.updated_at)}</span>
                        </div>

                        <a href="${escapeHtml(href)}" class="mt-auto text-yellow-400 font-black text-sm hover:text-yellow-300">
                            Read guide →
                        </a>
                    </div>
                </article>`;
}

function renderCategoryButtons(categories) {
  return [
    `<button data-category="all" class="category-chip active border border-slate-700 bg-slate-900 text-gray-300 font-bold text-sm px-4 py-2.5 rounded-xl transition-all">All</button>`,
    ...categories.map(
      (category) =>
        `<button data-category="${escapeHtml(category)}" class="category-chip border border-slate-700 bg-slate-900 text-gray-300 font-bold text-sm px-4 py-2.5 rounded-xl transition-all">${escapeHtml(category)}</button>`
    )
  ].join("\n                    ");
}

function buildBlogIndex(config, publishedArticles) {
  const categories = Array.isArray(config?.categories)
    ? config.categories
    : [];

  const featured =
    publishedArticles.find((article) => article.featured === true) ||
    publishedArticles[0] ||
    null;

  const cards = publishedArticles.map(renderArticleCard).join("\n");
  const count = publishedArticles.length;

  const baseUrl = cleanUrlBase(config?.site?.base_url);
  const blogUrl = `${baseUrl}/blog/`;
  const logoUrl =
    config?.seo?.default_og_image ||
    `${baseUrl}/logo2%20(1).png`;

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>APXN Blog | Apex Network Web3, Blockchain & Guides</title>
    <meta name="description" content="Explore Apex Network (APXN) updates, Web3 guides, blockchain education, BSC insights, security tips, and development news from the APXN ecosystem.">
    <meta name="keywords" content="APXN Blog, Apex Network, Web3, Blockchain, BSC, BEP-20, Telegram Mini App, APXN Points, Crypto Education">
    <meta name="robots" content="index, follow">
    <meta name="author" content="${escapeHtml(config?.site?.author || "Apex Network Editorial")}">

    <link rel="canonical" href="${escapeHtml(blogUrl)}">

    <meta property="og:type" content="website">
    <meta property="og:title" content="APXN Blog | Apex Network">
    <meta property="og:description" content="Web3 education, APXN guides, blockchain insights and development updates from Apex Network.">
    <meta property="og:url" content="${escapeHtml(blogUrl)}">
    <meta property="og:image" content="${escapeHtml(logoUrl)}">
    <meta property="og:site_name" content="Apex Network">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="APXN Blog | Apex Network">
    <meta name="twitter:description" content="Web3 education, APXN guides, blockchain insights and development updates.">
    <meta name="twitter:image" content="${escapeHtml(logoUrl)}">

    <link rel="icon" href="../logo2%20(1).png" type="image/png">

    <script>
      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>

    <link rel="preconnect" href="https://cdn.tailwindcss.com">
    <script src="https://cdn.tailwindcss.com"></script>

    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        slate: {
                            800: '#1e293b',
                            900: '#0f172a',
                            950: '#020617'
                        }
                    },
                    fontFamily: {
                        sans: ['Inter', 'system-ui', 'sans-serif']
                    }
                }
            }
        }
    </script>

    <style>
        html { background: #020617; }
        body { min-height: 100vh; }

        .gold-text {
            background: linear-gradient(90deg, #fde047, #f59e0b, #fb923c);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .hero-glow {
            position: absolute;
            width: 620px;
            height: 620px;
            border-radius: 9999px;
            background: rgba(234, 179, 8, 0.10);
            filter: blur(110px);
            pointer-events: none;
            left: 50%;
            top: 40%;
            transform: translate(-50%, -50%);
        }

        .article-card {
            transition: transform .25s ease, border-color .25s ease, box-shadow .25s ease;
        }

        .article-card:hover {
            transform: translateY(-4px);
            border-color: rgba(234, 179, 8, .45);
            box-shadow: 0 16px 40px rgba(0, 0, 0, .28);
        }

        .category-chip.active {
            color: #020617;
            background: linear-gradient(90deg, #facc15, #f59e0b);
            border-color: transparent;
        }

        .line-clamp-2 {
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .line-clamp-3 {
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
    </style>

    <script type="application/ld+json">
${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "APXN Blog",
    url: blogUrl,
    description:
      "Official Apex Network educational blog covering APXN, Web3, blockchain, BSC, security and development updates.",
    publisher: {
      "@type": "Organization",
      name: "Apex Network",
      url: baseUrl,
      logo: {
        "@type": "ImageObject",
        url: logoUrl
      }
    }
  },
  null,
  2
)}
    </script>
</head>

<body class="bg-slate-950 text-white font-sans overflow-x-hidden selection:bg-yellow-500 selection:text-slate-950">

    <header class="sticky top-0 z-50 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800">
        <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-5">
            <a href="../index.html" class="flex items-center gap-3 group min-w-0">
                <div class="w-11 h-11 shrink-0 rounded-full overflow-hidden border border-yellow-500/50 shadow-[0_0_18px_rgba(234,179,8,0.25)]">
                    <img src="../logo2%20(1).png" alt="Apex Network Logo" class="w-full h-full object-cover" width="44" height="44">
                </div>
                <div class="min-w-0">
                    <div class="font-black tracking-wider gold-text text-base sm:text-lg truncate">APEX NETWORK</div>
                    <div class="text-[10px] sm:text-xs text-gray-500 font-bold uppercase tracking-[0.2em]">Official Blog</div>
                </div>
            </a>

            <nav class="hidden lg:flex items-center gap-6 text-sm font-bold text-gray-300">
                <a href="../index.html" class="hover:text-yellow-400 transition-colors">Home</a>
                <a href="#featured" class="hover:text-yellow-400 transition-colors">Featured</a>
                <a href="#categories" class="hover:text-yellow-400 transition-colors">Categories</a>
                <a href="#latest" class="hover:text-yellow-400 transition-colors">Latest</a>
                <a href="../privacy.html" class="hover:text-yellow-400 transition-colors">Privacy</a>
            </nav>

            <a href="https://t.me/ApxMinerBot"
               target="_blank"
               rel="noopener noreferrer"
               class="shrink-0 bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black text-xs sm:text-sm px-4 sm:px-5 py-3 rounded-xl hover:scale-[1.03] transition-transform shadow-[0_0_20px_rgba(245,158,11,0.22)]">
                Open APXN App
            </a>
        </div>
    </header>

    <main>

        <section class="relative overflow-hidden border-b border-slate-800">
            <div class="hero-glow"></div>

            <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-20 sm:py-24 relative z-10">
                <div class="max-w-4xl">
                    <span class="inline-flex items-center gap-2 border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest mb-6">
                        APXN Knowledge Hub
                    </span>

                    <h1 class="text-4xl sm:text-5xl lg:text-7xl font-black leading-tight mb-6">
                        Learn Web3.
                        <span class="gold-text">Understand APXN.</span>
                    </h1>

                    <p class="text-gray-400 text-base sm:text-lg lg:text-xl leading-relaxed max-w-3xl">
                        Educational guides, Apex Network updates, blockchain explainers, BSC insights and practical security articles built around verified APXN project information.
                    </p>

                    <div class="mt-9 flex flex-col sm:flex-row gap-3 max-w-3xl">
                        <div class="relative flex-1">
                            <svg class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <circle cx="11" cy="11" r="8"></circle>
                                <path d="m21 21-4.3-4.3"></path>
                            </svg>

                            <input
                                id="searchInput"
                                type="search"
                                placeholder="Search APXN, Web3, BSC, security..."
                                aria-label="Search blog articles"
                                class="w-full bg-slate-900 border border-slate-700 rounded-2xl pl-12 pr-4 py-4 text-sm text-white placeholder-gray-500 outline-none focus:border-yellow-500/60 focus:ring-2 focus:ring-yellow-500/10 transition-all"
                            >
                        </div>

                        <button
                            type="button"
                            onclick="resetFilters()"
                            class="bg-slate-900 border border-slate-700 hover:border-yellow-500/50 text-gray-300 hover:text-yellow-400 font-bold px-6 py-4 rounded-2xl transition-colors">
                            Reset
                        </button>
                    </div>
                </div>
            </div>
        </section>

        <section class="border-b border-slate-800 bg-slate-900/25">
            <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-5">
                <div class="flex flex-col md:flex-row md:items-center gap-3 md:gap-6 text-sm">
                    <span class="text-emerald-400 font-black">Editorial standard</span>
                    <p class="text-gray-400">
                        APXN articles distinguish between live app features, ecosystem points, planned roadmap features and general Web3 education.
                    </p>
                </div>
            </div>
        </section>

        <section id="featured" class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-16 sm:py-20">
            <div class="flex items-end justify-between gap-5 mb-8">
                <div>
                    <p class="text-yellow-500 text-xs font-black uppercase tracking-[0.22em] mb-2">Editor's Pick</p>
                    <h2 class="text-3xl sm:text-4xl font-black">Featured Article</h2>
                </div>
            </div>

${renderFeaturedArticle(featured)}
        </section>

        <section id="categories" class="border-y border-slate-800 bg-slate-900/20">
            <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-12">
                <div class="mb-7">
                    <p class="text-yellow-500 text-xs font-black uppercase tracking-[0.22em] mb-2">Explore Topics</p>
                    <h2 class="text-2xl sm:text-3xl font-black">Blog Categories</h2>
                </div>

                <div class="flex flex-wrap gap-3" id="categoryFilters">
                    ${renderCategoryButtons(categories)}
                </div>

            </div>
        </section>

        <section id="latest" class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-16 sm:py-20">
            <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-9">
                <div>
                    <p class="text-yellow-500 text-xs font-black uppercase tracking-[0.22em] mb-2">Fresh Knowledge</p>
                    <h2 class="text-3xl sm:text-4xl font-black">Latest Articles</h2>
                </div>

                <p id="resultCount" class="text-sm text-gray-500 font-bold">${count === 1 ? "1 article" : `${count} articles`}</p>
            </div>

            <div id="articlesGrid" class="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
${cards}
            </div>

            <div id="emptyState" class="${count > 0 ? "hidden " : ""}text-center border border-dashed border-slate-700 rounded-2xl p-10 mt-8">
                <p class="text-xl font-black mb-2">No articles found</p>
                <p class="text-gray-500 text-sm">Try another search term or choose a different category or language.</p>
            </div>
        </section>

        <section class="border-y border-slate-800 bg-gradient-to-r from-yellow-500/5 via-orange-500/5 to-yellow-500/5">
            <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-16">
                <div class="bg-slate-900 border border-yellow-500/20 rounded-3xl p-7 sm:p-10 lg:p-12 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8 shadow-[0_0_45px_rgba(234,179,8,0.05)]">
                    <div class="max-w-2xl">
                        <p class="text-yellow-400 text-xs font-black uppercase tracking-[0.22em] mb-3">Join the Ecosystem</p>
                        <h2 class="text-3xl sm:text-4xl font-black mb-4">Learn about APXN, then explore the Mini App.</h2>
                        <p class="text-gray-400 leading-relaxed">
                            The blog provides education and project documentation. The Telegram Mini App remains the interactive APXN ecosystem experience.
                        </p>
                    </div>

                    <div class="flex flex-col sm:flex-row lg:flex-col xl:flex-row gap-3 shrink-0">
                        <a href="https://t.me/ApxMinerBot"
                           target="_blank"
                           rel="noopener noreferrer"
                           class="bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black px-6 py-4 rounded-xl text-center hover:scale-[1.02] transition-transform">
                            Open Telegram App
                        </a>

                        <a href="https://t.me/ApexMiner_Official"
                           target="_blank"
                           rel="noopener noreferrer"
                           class="bg-slate-950 border border-slate-700 text-white font-black px-6 py-4 rounded-xl text-center hover:border-yellow-500/50 hover:text-yellow-400 transition-colors">
                            Telegram Channel
                        </a>
                    </div>
                </div>
            </div>
        </section>

    </main>

    <footer class="bg-slate-950">
        <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-12">
            <div class="grid md:grid-cols-3 gap-10 pb-10 border-b border-slate-800">

                <div>
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-full overflow-hidden border border-yellow-500/40">
                            <img src="../logo2%20(1).png" alt="Apex Network" class="w-full h-full object-cover" width="40" height="40">
                        </div>
                        <span class="font-black tracking-wider">APEX NETWORK</span>
                    </div>

                    <p class="text-gray-500 text-sm leading-relaxed">
                        APXN Blog is the educational and editorial hub of the Apex Network ecosystem.
                    </p>
                </div>

                <div>
                    <h3 class="font-black mb-4">Explore</h3>
                    <div class="flex flex-col gap-3 text-sm text-gray-500">
                        <a href="../index.html" class="hover:text-yellow-400 transition-colors">Main Website</a>
                        <a href="#categories" class="hover:text-yellow-400 transition-colors">Categories</a>
                        <a href="#latest" class="hover:text-yellow-400 transition-colors">Latest Articles</a>
                        <a href="https://t.me/ApxMinerBot" target="_blank" rel="noopener noreferrer" class="hover:text-yellow-400 transition-colors">Telegram Mini App</a>
                    </div>
                </div>

                <div>
                    <h3 class="font-black mb-4">Legal & Support</h3>
                    <div class="flex flex-col gap-3 text-sm text-gray-500">
                        <a href="../privacy.html" class="hover:text-yellow-400 transition-colors">Privacy Policy</a>
                        <a href="../terms.html" class="hover:text-yellow-400 transition-colors">Terms & Conditions</a>
                        <a href="mailto:${escapeHtml(config?.site?.support_email || "contact@apxn.network")}" class="hover:text-yellow-400 transition-colors">${escapeHtml(config?.site?.support_email || "contact@apxn.network")}</a>
                    </div>
                </div>

            </div>

            <div class="pt-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-xs text-gray-600">
                <p>&copy; ${new Date().getFullYear()} Apex Network. All rights reserved.</p>
                <p>Educational content only. Not financial advice.</p>
            </div>
        </div>
    </footer>

    <script>
        const searchInput = document.getElementById('searchInput');
        const articleItems = Array.from(document.querySelectorAll('.article-item'));
        const categoryButtons = Array.from(document.querySelectorAll('.category-chip'));
        const resultCount = document.getElementById('resultCount');
        const emptyState = document.getElementById('emptyState');

        let activeCategory = 'all';

        function updateArticles() {
            const query = (searchInput.value || '').trim().toLowerCase();
            let visible = 0;

            articleItems.forEach((article) => {
                const category = article.dataset.category || '';
                const searchable = (article.dataset.search || '').toLowerCase();
                const text = article.innerText.toLowerCase();

                const matchesCategory =
                    activeCategory === 'all' ||
                    category === activeCategory;

                const matchesSearch =
                    !query ||
                    searchable.includes(query) ||
                    text.includes(query);

                const shouldShow =
                    matchesCategory &&
                    matchesSearch;

                article.classList.toggle('hidden', !shouldShow);

                if (shouldShow) visible++;
            });

            resultCount.textContent =
                visible === 1 ? '1 article' : \`\${visible} articles\`;

            emptyState.classList.toggle('hidden', visible !== 0);
        }

        categoryButtons.forEach((button) => {
            button.addEventListener('click', () => {
                activeCategory = button.dataset.category;

                categoryButtons.forEach((item) => item.classList.remove('active'));
                button.classList.add('active');

                updateArticles();

                document.getElementById('latest').scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            });
        });

        searchInput.addEventListener('input', updateArticles);

        function resetFilters() {
            activeCategory = 'all';
            searchInput.value = '';

            categoryButtons.forEach((item) => {
                item.classList.toggle('active', item.dataset.category === 'all');
            });

            updateArticles();
        }

        updateArticles();
    </script>

</body>
</html>
`;
}

function sitemapEntry({ loc, lastmod, changefreq, priority }) {
  return `    <url>
        <loc>${escapeXml(loc)}</loc>
        <lastmod>${escapeXml(lastmod)}</lastmod>
        <changefreq>${escapeXml(changefreq)}</changefreq>
        <priority>${escapeXml(priority)}</priority>
    </url>`;
}

function buildSitemap(config, publishedArticles) {
  const baseUrl = cleanUrlBase(config?.site?.base_url);
  const today = new Date().toISOString().slice(0, 10);

  const entries = [
    {
      loc: `${baseUrl}/`,
      lastmod: today,
      changefreq: "weekly",
      priority: "1.0"
    },
    {
      loc: `${baseUrl}/blog/`,
      lastmod: today,
      changefreq: "daily",
      priority: "0.9"
    },
    ...publishedArticles.map((article) => ({
      loc:
        article.url ||
        `${baseUrl}/${String(article.path || `blog/articles/${article.slug}.html`).replace(/^\/+/, "")}`,
      lastmod: article.updated_at || article.published_at || today,
      changefreq: "monthly",
      priority: article.featured === true ? "0.8" : "0.7"
    })),
    {
      loc: `${baseUrl}/privacy.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    },
    {
      loc: `${baseUrl}/terms.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    }
  ];

  const seen = new Set();
  const unique = [];

  for (const entry of entries) {
    if (seen.has(entry.loc)) continue;
    seen.add(entry.loc);
    unique.push(entry);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${unique.map(sitemapEntry).join("\n")}
</urlset>
`;
}

function main() {
  const config = readJson(PATHS.config);
  const manifest = readJson(PATHS.articles);

  const publishedArticles = verifyPublishedArticles(manifest);

  const blogIndex = buildBlogIndex(config, publishedArticles);
  const sitemap = buildSitemap(config, publishedArticles);

  writeText(PATHS.blogIndex, blogIndex);
  writeText(PATHS.sitemap, sitemap);

  console.log("APXN Blog Sync");
  console.log("--------------");
  console.log(`Published articles: ${publishedArticles.length}`);
  console.log(`Updated: ${path.relative(ROOT, PATHS.blogIndex)}`);
  console.log(`Updated: ${path.relative(ROOT, PATHS.sitemap)}`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}

