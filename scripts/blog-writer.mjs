/**
 * APXN Blog AI Writer
 * Path: scripts/blog-writer.mjs
 *
 * Purpose:
 * - Reads the APXN knowledge base before every article.
 * - Reads blog configuration and existing article registry.
 * - Selects the next waiting topic.
 * - Generates a structured long-form draft through the OpenAI Responses API.
 * - Runs local editorial/quality checks.
 * - Never auto-publishes risky or unverified claims.
 * - Saves drafts as noindex HTML plus structured JSON metadata.
 *
 * No external npm packages are required.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  config: path.join(ROOT, "data", "blog-config.json"),
  knowledge: path.join(ROOT, "data", "apxn-blog-knowledge.json"),
  articles: path.join(ROOT, "data", "blog-articles.json"),
  generated: path.join(ROOT, "data", "generated"),
  drafts: path.join(ROOT, "blog", "drafts"),
  published: path.join(ROOT, "blog", "articles")
};

const API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-luna";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 90);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value) {
  const clean = stripHtml(value);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}

function readingMinutes(words) {
  return Math.max(1, Math.ceil(words / 220));
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values, max = 12) {
  const result = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const clean = normalizeSpace(value);
    const key = clean.toLowerCase();

    if (!clean || seen.has(key)) continue;

    seen.add(key);
    result.push(clean);

    if (result.length >= max) break;
  }

  return result;
}

function nextArticleId(articles) {
  let max = 0;

  for (const article of articles) {
    const match = String(article?.id || "").match(/^apxn-(\d+)$/i);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }

  return `apxn-${String(max + 1).padStart(3, "0")}`;
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] || "").trim().toLowerCase()
  );
}

function safeFilename(value) {
  return slugify(value) || `article-${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validateConfig(config) {
  if (config?.writer?.enabled !== true) {
    fail("The AI writer is disabled in data/blog-config.json.");
  }

  if (!config?.content_sources?.knowledge_file) {
    fail("blog-config.json is missing content_sources.knowledge_file.");
  }

  if (!config?.content_sources?.articles_manifest) {
    fail("blog-config.json is missing content_sources.articles_manifest.");
  }

  if (!Array.isArray(config?.categories) || config.categories.length === 0) {
    fail("blog-config.json must contain at least one category.");
  }

  const min = Number(config?.writer?.minimum_words || 1200);
  const target = Number(config?.writer?.target_words || 1500);
  const max = Number(config?.writer?.maximum_words || 1900);

  if (!(min > 0 && target >= min && max >= target)) {
    fail("Invalid writer word-count settings in blog-config.json.");
  }
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest?.articles)) {
    fail("data/blog-articles.json must contain an articles array.");
  }

  if (!Array.isArray(manifest?.generation_queue)) {
    fail("data/blog-articles.json must contain a generation_queue array.");
  }
}

function chooseNextTopic(manifest) {
  const waiting = manifest.generation_queue
    .filter((item) => item?.status === "waiting")
    .sort((a, b) => Number(a.priority || 9999) - Number(b.priority || 9999));

  if (waiting.length === 0) {
    fail("No waiting topics found in data/blog-articles.json.");
  }

  return waiting[0];
}

function detectDuplicateTopic(topic, manifest) {
  const topicText = normalizeSpace(topic).toLowerCase();
  const topicSlug = slugify(topicText);

  for (const article of manifest.articles) {
    const title = normalizeSpace(article?.title).toLowerCase();
    const slug = slugify(article?.slug || article?.title || "");

    if (!title && !slug) continue;

    if (
      title === topicText ||
      slug === topicSlug ||
      (title && topicText && title.includes(topicText)) ||
      (title && topicText && topicText.includes(title))
    ) {
      return article;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Prompt building                                                            */
/* -------------------------------------------------------------------------- */

function buildInstructions(config) {
  const min = Number(config.writer.minimum_words || 1200);
  const target = Number(config.writer.target_words || 1500);
  const max = Number(config.writer.maximum_words || 1900);

  return `
You are the APXN Blog editorial writer for Apex Network.

Your job is to create accurate, useful, original, SEO-friendly educational articles.

MANDATORY SOURCE RULES:
1. The APXN knowledge JSON supplied by the user is the highest-priority source for all APXN project facts.
2. Never invent APXN facts.
3. Distinguish clearly between:
   - implemented current behavior,
   - official UI claims,
   - UI-only behavior,
   - planned roadmap features,
   - verify-before-publish claims,
   - blocked-auto-publish claims.
4. Current in-app balances must be called "APXN Points" unless explicitly discussing a future APXN token.
5. Never describe pressing Claim as proof-of-work, proof-of-stake, or blockchain consensus mining.
6. Never promise profit, returns, listing price, token value, exchange listing, point conversion value, or guaranteed withdrawal.
7. Never present Testnet, Mainnet, staking, presale, exchange support, disabled upgrades, or other planned features as live unless the supplied knowledge explicitly marks them implemented.
8. Never claim permanent wallet binding when the supplied knowledge says wallet persistence is not implemented.
9. Telegram channel/group membership may be described as server-verified only where supported by the knowledge. Do not claim X likes/follows are externally verified when they are not.
10. Country data is informational. Do not present it as KYC, citizenship, identity, or eligibility proof.
11. If the requested article would require a fact marked verify_before_publish or blocked_auto_publish, set requires_manual_review=true and explain why.
12. The article must provide real educational value beyond project promotion.

WRITING REQUIREMENTS:
- Language: ${config.site?.default_language || "en"}
- Target length: about ${target} words.
- Minimum acceptable length: ${min} words.
- Maximum target length: ${max} words.
- Clear beginner-friendly English.
- Use descriptive H2-style section headings.
- Avoid hype, spammy wording, keyword stuffing, and repetitive conclusions.
- Include practical examples where useful.
- Include a short FAQ.
- Include a responsible educational disclaimer when financial/token/presale concepts are discussed.
- Do not output markdown code fences.
- Do not output HTML.
- Return ONE valid JSON object only.

RETURN EXACTLY THIS JSON SHAPE:
{
  "title": "string",
  "slug": "lowercase-kebab-case",
  "description": "SEO meta description, ideally 140-165 characters",
  "excerpt": "short article summary",
  "category": "one configured category",
  "keywords": ["keyword", "..."],
  "sections": [
    {
      "heading": "section heading",
      "paragraphs": ["paragraph 1", "paragraph 2"]
    }
  ],
  "faq": [
    {
      "question": "question",
      "answer": "answer"
    }
  ],
  "disclaimer": "string or empty string",
  "requires_manual_review": false,
  "review_reasons": [],
  "claims_used": [
    {
      "claim": "brief description",
      "knowledge_status": "implemented|official_ui_claim|ui_only|planned|verify_before_publish|blocked_auto_publish"
    }
  ]
}
`.trim();
}

function buildInput(topic, config, knowledge, manifest) {
  const existing = manifest.articles.map((article) => ({
    id: article.id,
    slug: article.slug,
    title: article.title,
    category: article.category,
    status: article.status
  }));

  return JSON.stringify(
    {
      task: {
        topic: topic.topic,
        requested_category: topic.category,
        priority: topic.priority
      },
      configured_categories: config.categories,
      writer_settings: {
        minimum_words: config.writer.minimum_words,
        target_words: config.writer.target_words,
        maximum_words: config.writer.maximum_words,
        include_faq: config.writer.include_faq,
        include_disclaimer: config.writer.include_disclaimer,
        include_internal_links: config.writer.include_internal_links
      },
      existing_articles_do_not_duplicate: existing,
      apxn_knowledge_base: knowledge
    },
    null,
    2
  );
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const pieces = [];

  for (const outputItem of Array.isArray(responseJson?.output) ? responseJson.output : []) {
    for (const content of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      if (typeof content?.text === "string") {
        pieces.push(content.text);
      }
    }
  }

  return pieces.join("\n").trim();
}

function parseGeneratedJson(rawText) {
  let text = String(rawText || "").trim();

  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = text.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // Fall through to the explicit error below.
      }
    }
  }

  fail("The AI response was not valid JSON. No files were changed.");
}

async function callOpenAI({ apiKey, model, instructions, input }) {
  const requestBody = {
    model,
    instructions,
    input,
    max_output_tokens: 14000
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail(`OpenAI API returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `OpenAI API request failed with HTTP ${response.status}.`;

    fail(message);
  }

  const outputText = extractResponseText(data);

  if (!outputText) {
    fail("OpenAI API returned no usable text output.");
  }

  return {
    response: data,
    generated: parseGeneratedJson(outputText)
  };
}

/* -------------------------------------------------------------------------- */
/* Editorial checks                                                           */
/* -------------------------------------------------------------------------- */

function normalizeGeneratedArticle(raw, topic, config) {
  const title = normalizeSpace(raw?.title || topic.topic);
  const slug = safeFilename(raw?.slug || title);
  const description = normalizeSpace(raw?.description);
  const excerpt = normalizeSpace(raw?.excerpt || description);

  let category = normalizeSpace(raw?.category || topic.category);

  if (!config.categories.includes(category)) {
    category = config.categories.includes(topic.category)
      ? topic.category
      : config.categories[0];
  }

  const sections = (Array.isArray(raw?.sections) ? raw.sections : [])
    .map((section) => ({
      heading: normalizeSpace(section?.heading),
      paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
        .map(normalizeSpace)
        .filter(Boolean)
    }))
    .filter((section) => section.heading && section.paragraphs.length > 0);

  const faq = (Array.isArray(raw?.faq) ? raw.faq : [])
    .map((item) => ({
      question: normalizeSpace(item?.question),
      answer: normalizeSpace(item?.answer)
    }))
    .filter((item) => item.question && item.answer)
    .slice(0, 8);

  const claimsUsed = (Array.isArray(raw?.claims_used) ? raw.claims_used : [])
    .map((item) => ({
      claim: normalizeSpace(item?.claim),
      knowledge_status: normalizeSpace(item?.knowledge_status)
    }))
    .filter((item) => item.claim);

  return {
    title,
    slug,
    description,
    excerpt,
    category,
    keywords: uniqueStrings(raw?.keywords, 12),
    sections,
    faq,
    disclaimer: normalizeSpace(raw?.disclaimer),
    requires_manual_review: raw?.requires_manual_review === true,
    review_reasons: uniqueStrings(raw?.review_reasons, 20),
    claims_used: claimsUsed
  };
}

function articlePlainText(article) {
  const parts = [
    article.title,
    article.description,
    article.excerpt
  ];

  for (const section of article.sections) {
    parts.push(section.heading, ...section.paragraphs);
  }

  for (const faq of article.faq) {
    parts.push(faq.question, faq.answer);
  }

  parts.push(article.disclaimer);

  return parts.filter(Boolean).join("\n");
}

function detectRiskyLanguage(article) {
  const text = articlePlainText(article).toLowerCase();
  const reasons = [];

  const checks = [
    {
      regex: /\bgate\.io\b/i,
      reason: "Named Gate.io claim requires manual verification."
    },
    {
      regex: /\$0\.10\b|0\.10\s*(?:usd|dollars?)?\s*(?:per|\/)\s*apxn/i,
      reason: "The $0.10/APXN presale claim is blocked because project sources conflict."
    },
    {
      regex: /\b(?:presale is active|active presale|presale currently active)\b/i,
      reason: "Current-presale status conflicts with the reviewed roadmap and requires manual confirmation."
    },
    {
      regex: /\b(?:audited by thirdweb|verified and audited contract|thirdweb audit)\b/i,
      reason: "External smart-contract audit claims require manual verification."
    },
    {
      regex: /\b(?:locked liquidity|liquidity is locked)\b/i,
      reason: "Liquidity-lock claims require external verification."
    },
    {
      regex: /\bguaranteed decentralized trading\b/i,
      reason: "Guaranteed trading claims are not allowed for automatic publication."
    },
    {
      regex: /\b(?:wallet is permanently linked|permanently bound wallet|wallet permanently bound)\b/i,
      reason: "Permanent wallet-binding is not implemented in the reviewed app."
    },
    {
      regex: /\b(?:testnet is live|testnet is now live|live testnet)\b/i,
      reason: "Testnet is a roadmap item unless later verified."
    },
    {
      regex: /\b(?:mainnet is live|mainnet is now live|live mainnet)\b/i,
      reason: "Mainnet is a roadmap item unless later verified."
    },
    {
      regex: /\b(?:staking is live|staking is now live|live staking)\b/i,
      reason: "Staking is a roadmap item unless later verified."
    }
  ];

  for (const check of checks) {
    if (check.regex.test(text)) {
      reasons.push(check.reason);
    }
  }

  for (const claim of article.claims_used) {
    if (
      claim.knowledge_status === "verify_before_publish" ||
      claim.knowledge_status === "blocked_auto_publish"
    ) {
      reasons.push(
        `AI reported a claim with status "${claim.knowledge_status}": ${claim.claim}`
      );
    }
  }

  return uniqueStrings(reasons, 30);
}

function runQualityChecks(article, config, manifest) {
  const errors = [];
  const warnings = [];

  if (article.title.length < 20) {
    errors.push("Article title is too short.");
  }

  if (article.description.length < 100) {
    warnings.push("Meta description is shorter than 100 characters.");
  }

  if (article.description.length > 180) {
    warnings.push("Meta description is longer than 180 characters.");
  }

  if (article.sections.length < 6) {
    errors.push("Article must contain at least 6 substantive sections.");
  }

  if (config.writer.include_faq === true && article.faq.length < 2) {
    errors.push("Article must contain at least 2 FAQ entries.");
  }

  const plain = articlePlainText(article);
  const words = wordCount(plain);
  const minimum = Number(config.writer.minimum_words || 1200);
  const maximum = Number(config.writer.maximum_words || 1900);

  if (words < minimum) {
    errors.push(`Article is too short: ${words} words; minimum is ${minimum}.`);
  }

  if (words > maximum + 500) {
    warnings.push(
      `Article is significantly above the target maximum: ${words} words.`
    );
  }

  const duplicate = manifest.articles.find((existing) => {
    const existingSlug = slugify(existing?.slug || existing?.title || "");
    return existingSlug && existingSlug === article.slug;
  });

  if (duplicate) {
    errors.push(`Duplicate slug already exists: ${article.slug}.`);
  }

  const risky = detectRiskyLanguage(article);

  if (risky.length > 0) {
    article.requires_manual_review = true;
    article.review_reasons = uniqueStrings(
      [...article.review_reasons, ...risky],
      30
    );
  }

  if (article.requires_manual_review && article.review_reasons.length === 0) {
    article.review_reasons = [
      "The AI marked this article for manual editorial review."
    ];
  }

  return {
    words,
    reading_minutes: readingMinutes(words),
    errors,
    warnings
  };
}

/* -------------------------------------------------------------------------- */
/* HTML rendering                                                             */
/* -------------------------------------------------------------------------- */

function renderParagraphs(paragraphs) {
  return paragraphs
    .map((paragraph) => `                    <p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
}

function renderFaq(faq) {
  if (!faq.length) return "";

  return `
                    <h2>Frequently asked questions</h2>
${faq
  .map(
    (item) => `
                    <h3>${escapeHtml(item.question)}</h3>
                    <p>${escapeHtml(item.answer)}</p>`
  )
  .join("\n")}
  `.trimEnd();
}

function renderArticleHtml({
  article,
  config,
  published,
  date,
  words,
  reading
}) {
  const baseUrl = String(config.site?.base_url || "https://apxn.network").replace(/\/+$/, "");
  const articleUrl = published
    ? `${baseUrl}/blog/articles/${article.slug}.html`
    : `${baseUrl}/blog/drafts/${article.slug}.html`;

  const robots = published ? "index, follow" : "noindex, nofollow";
  const ogImage =
    config.seo?.default_og_image ||
    `${baseUrl}/logo2%20(1).png`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.description,
    image: ogImage,
    mainEntityOfPage: articleUrl,
    datePublished: date,
    dateModified: date,
    author: {
      "@type": "Organization",
      name: config.site?.author || "Apex Network Editorial"
    },
    publisher: {
      "@type": "Organization",
      name: config.site?.brand || "Apex Network",
      url: baseUrl,
      logo: {
        "@type": "ImageObject",
        url: ogImage
      }
    }
  };

  const faqSchema =
    article.faq.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: article.faq.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: item.answer
            }
          }))
        }
      : null;

  const sectionsHtml = article.sections
    .map(
      (section) => `
                    <h2>${escapeHtml(section.heading)}</h2>
${renderParagraphs(section.paragraphs)}`
    )
    .join("\n");

  const faqHtml = renderFaq(article.faq);

  const disclaimerHtml = article.disclaimer
    ? `
                <div class="mt-12 bg-amber-500/[0.07] border border-amber-500/20 rounded-2xl p-6">
                    <h2 class="font-black text-amber-300 mb-2">Educational disclaimer</h2>
                    <p class="text-sm text-gray-400 leading-relaxed">${escapeHtml(article.disclaimer)}</p>
                </div>`
    : "";

  const reviewBanner = !published
    ? `
            <section class="border-b border-amber-500/20 bg-amber-500/[0.06]">
                <div class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-4 text-sm text-amber-300 font-bold">
                    Draft preview — this page is marked noindex and is not an official published APXN Blog article.
                </div>
            </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>${escapeHtml(article.title)}</title>
    <meta name="description" content="${escapeHtml(article.description)}">
    <meta name="keywords" content="${escapeHtml(article.keywords.join(", "))}">
    <meta name="robots" content="${robots}">
    <meta name="author" content="${escapeHtml(config.site?.author || "Apex Network Editorial")}">

    <link rel="canonical" href="${escapeHtml(articleUrl)}">
    <link rel="icon" href="../../logo2%20(1).png" type="image/png">

    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(article.title)}">
    <meta property="og:description" content="${escapeHtml(article.description)}">
    <meta property="og:url" content="${escapeHtml(articleUrl)}">
    <meta property="og:image" content="${escapeHtml(ogImage)}">
    <meta property="og:site_name" content="${escapeHtml(config.site?.brand || "Apex Network")}">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(article.title)}">
    <meta name="twitter:description" content="${escapeHtml(article.description)}">
    <meta name="twitter:image" content="${escapeHtml(ogImage)}">

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

        .gold-text {
            background: linear-gradient(90deg, #fde047, #f59e0b, #fb923c);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .article-body p {
            color: #cbd5e1;
            line-height: 1.9;
            margin: 1rem 0 1.5rem;
        }

        .article-body h2 {
            color: #fff;
            font-size: 1.75rem;
            font-weight: 900;
            margin-top: 2.7rem;
            margin-bottom: 1rem;
            line-height: 1.25;
        }

        .article-body h3 {
            color: #facc15;
            font-size: 1.2rem;
            font-weight: 900;
            margin-top: 2rem;
            margin-bottom: .75rem;
        }

        .article-body strong {
            color: #fff;
        }

        @media (max-width: 640px) {
            .article-body h2 { font-size: 1.45rem; }
        }
    </style>

    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
    </script>
${
  faqSchema
    ? `
    <script type="application/ld+json">
${JSON.stringify(faqSchema, null, 2)}
    </script>`
    : ""
}
</head>

<body class="bg-slate-950 text-white font-sans overflow-x-hidden selection:bg-yellow-500 selection:text-slate-950">

    <header class="sticky top-0 z-50 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800">
        <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-5">
            <a href="../index.html" class="flex items-center gap-3 min-w-0">
                <div class="w-11 h-11 shrink-0 rounded-full overflow-hidden border border-yellow-500/50">
                    <img src="../../logo2%20(1).png" alt="Apex Network Logo" class="w-full h-full object-cover" width="44" height="44">
                </div>
                <div>
                    <div class="font-black tracking-wider gold-text text-base sm:text-lg">APEX NETWORK</div>
                    <div class="text-[10px] sm:text-xs text-gray-500 font-bold uppercase tracking-[0.2em]">APXN Blog</div>
                </div>
            </a>

            <a href="https://t.me/ApxMinerBot"
               target="_blank"
               rel="noopener noreferrer"
               class="bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black text-xs sm:text-sm px-4 sm:px-5 py-3 rounded-xl">
                Open APXN App
            </a>
        </div>
    </header>
${reviewBanner}

    <main>
        <article>
            <section class="border-b border-slate-800 bg-gradient-to-b from-yellow-500/[0.06] to-transparent">
                <div class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-16 sm:py-20">
                    <nav aria-label="Breadcrumb" class="text-xs text-gray-500 font-bold mb-7">
                        <a href="../../index.html" class="hover:text-yellow-400">Home</a>
                        <span class="mx-2">/</span>
                        <a href="../index.html" class="hover:text-yellow-400">Blog</a>
                        <span class="mx-2">/</span>
                        <span class="text-yellow-400">${escapeHtml(article.category)}</span>
                    </nav>

                    <span class="inline-flex border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-widest mb-5">
                        ${escapeHtml(article.category)}
                    </span>

                    <h1 class="text-4xl sm:text-5xl lg:text-6xl font-black leading-tight mb-6">
                        ${escapeHtml(article.title)}
                    </h1>

                    <p class="text-lg sm:text-xl text-gray-400 leading-relaxed mb-7">
                        ${escapeHtml(article.excerpt)}
                    </p>

                    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs sm:text-sm text-gray-500">
                        <span class="font-bold text-gray-300">${escapeHtml(config.site?.author || "Apex Network Editorial")}</span>
                        <span>•</span>
                        <time datetime="${date}">${date}</time>
                        <span>•</span>
                        <span>${reading} min read</span>
                        <span>•</span>
                        <span>${words.toLocaleString("en-US")} words</span>
                    </div>
                </div>
            </section>

            <section class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-12 sm:py-16">
                <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 sm:p-8 mb-10">
                    <h2 class="text-xl sm:text-2xl font-black mb-2">In this guide</h2>
                    <p class="text-gray-400 leading-relaxed">
                        ${escapeHtml(article.description)}
                    </p>
                </div>

                <div class="article-body">
${sectionsHtml}
${faqHtml}
                </div>
${disclaimerHtml}

                <div class="mt-10 bg-slate-900 border border-slate-800 rounded-3xl p-7 sm:p-10 text-center">
                    <div class="w-20 h-20 mx-auto rounded-full overflow-hidden border border-yellow-500/40 mb-5">
                        <img src="../../logo2%20(1).png" alt="Apex Network" class="w-full h-full object-cover" width="80" height="80">
                    </div>
                    <h2 class="text-2xl sm:text-3xl font-black mb-3">Explore Apex Network</h2>
                    <p class="text-gray-400 max-w-2xl mx-auto mb-6">
                        Learn about the APXN ecosystem and access the official Telegram Mini App.
                    </p>
                    <a href="https://t.me/ApxMinerBot"
                       target="_blank"
                       rel="noopener noreferrer"
                       class="inline-flex bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black px-7 py-4 rounded-xl">
                        Open APXN on Telegram
                    </a>
                </div>

                <div class="mt-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-t border-slate-800 pt-8">
                    <a href="../index.html" class="text-yellow-400 font-black hover:text-yellow-300">← Back to APXN Blog</a>
                    <a href="../../index.html" class="text-gray-500 font-bold hover:text-yellow-400">Apex Network Website →</a>
                </div>
            </section>
        </article>
    </main>

    <footer class="border-t border-slate-800 bg-slate-950">
        <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-10">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-xs text-gray-600">
                <p>&copy; ${new Date().getFullYear()} Apex Network. All rights reserved.</p>
                <div class="flex flex-wrap gap-4">
                    <a href="../../privacy.html" class="hover:text-yellow-400">Privacy Policy</a>
                    <a href="../../terms.html" class="hover:text-yellow-400">Terms & Conditions</a>
                    <a href="mailto:${escapeHtml(config.site?.support_email || "contact@apxn.network")}" class="hover:text-yellow-400">Contact</a>
                </div>
            </div>
        </div>
    </footer>

</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* Manifest mutation                                                          */
/* -------------------------------------------------------------------------- */

function recalculateStats(manifest) {
  const published = manifest.articles.filter((a) => a.status === "published").length;
  const drafts = manifest.articles.filter((a) => a.status === "draft").length;
  const featured = manifest.articles.filter(
    (a) => a.status === "published" && a.featured === true
  ).length;

  manifest.stats = {
    total_articles: manifest.articles.length,
    published,
    drafts,
    featured
  };
}

function updateQueueItem(queueItem, changes) {
  Object.assign(queueItem, changes);
}

function addManifestRecord({
  manifest,
  article,
  config,
  quality,
  date,
  published,
  model,
  queueItem
}) {
  const id = nextArticleId(manifest.articles);
  const baseUrl = String(config.site?.base_url || "https://apxn.network").replace(/\/+$/, "");

  const relativePath = published
    ? `blog/articles/${article.slug}.html`
    : `blog/drafts/${article.slug}.html`;

  const url = `${baseUrl}/${relativePath}`;

  const record = {
    id,
    slug: article.slug,
    title: article.title,
    description: article.description,
    category: article.category,
    language: config.site?.default_language || "en",
    author: config.site?.author || "Apex Network Editorial",

    status: published ? "published" : "draft",
    featured: false,
    indexable: published,

    published_at: published ? date : null,
    updated_at: date,

    reading_minutes: quality.reading_minutes,
    word_count: quality.words,

    path: relativePath,
    url,

    image:
      config.seo?.default_og_image ||
      `${baseUrl}/logo2%20(1).png`,

    keywords: article.keywords,

    source: "ai",
    ai_model: model,
    knowledge_schema_version: 1,
    verified_against_knowledge: !article.requires_manual_review,
    requires_manual_review: article.requires_manual_review,
    review_reasons: article.review_reasons,

    seo: {
      canonical: url,
      robots: published ? "index, follow" : "noindex, nofollow",
      article_schema: true,
      faq_schema: article.faq.length > 0
    }
  };

  manifest.articles.push(record);

  updateQueueItem(queueItem, {
    status: published ? "published" : "drafted",
    article_id: id,
    slug: article.slug,
    generated_at: date,
    requires_manual_review: article.requires_manual_review
  });

  manifest.automation_state = manifest.automation_state || {};
  manifest.automation_state.last_generated_article = id;

  if (published) {
    manifest.automation_state.last_published_article = id;
  }

  const waiting = manifest.generation_queue
    .filter((item) => item.status === "waiting")
    .sort((a, b) => Number(a.priority || 9999) - Number(b.priority || 9999));

  manifest.automation_state.next_queue_priority =
    waiting.length > 0 ? waiting[0].priority : null;

  manifest.last_updated = date;
  recalculateStats(manifest);

  return record;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const config = readJson(PATHS.config);
  const knowledge = readJson(PATHS.knowledge);
  const manifest = readJson(PATHS.articles);

  validateConfig(config);
  validateManifest(manifest);

  const queueItem = chooseNextTopic(manifest);

  const duplicate = detectDuplicateTopic(queueItem.topic, manifest);
  if (duplicate) {
    fail(
      `The next queued topic appears to duplicate article ${duplicate.id}: ${duplicate.title}`
    );
  }

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    fail(
      "OPENAI_API_KEY is missing. Add it as a secret/environment variable; never place the key in repository files."
    );
  }

  const model =
    String(process.env.OPENAI_MODEL || DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL;

  const instructions = buildInstructions(config);
  const input = buildInput(queueItem, config, knowledge, manifest);

  console.log("APXN Blog AI Writer");
  console.log("-------------------");
  console.log(`Topic: ${queueItem.topic}`);
  console.log(`Category: ${queueItem.category}`);
  console.log(`Model: ${model}`);
  console.log("Generating article...");

  const { response, generated } = await callOpenAI({
    apiKey,
    model,
    instructions,
    input
  });

  const article = normalizeGeneratedArticle(
    generated,
    queueItem,
    config
  );

  const quality = runQualityChecks(article, config, manifest);

  console.log(`Generated words: ${quality.words}`);
  console.log(`Reading time: ${quality.reading_minutes} min`);

  if (quality.warnings.length > 0) {
    console.warn("\nWarnings:");
    for (const warning of quality.warnings) {
      console.warn(`- ${warning}`);
    }
  }

  if (quality.errors.length > 0) {
    console.error("\nQuality check failed:");
    for (const error of quality.errors) {
      console.error(`- ${error}`);
    }

    fail("Draft was rejected by quality checks. No manifest changes were saved.");
  }

  const date = todayISO();

  /*
   * Publishing is deliberately strict.
   *
   * ALL of the following are required:
   * - auto_generate_enabled=true
   * - auto_publish_enabled=true
   * - BLOG_PUBLISH=true environment flag
   * - article has no manual-review requirement
   *
   * Until the full publishing pipeline is completed, the current config keeps
   * both automation flags false, so this writer creates safe noindex drafts.
   */
  const publishRequested =
    config?.automation?.auto_generate_enabled === true &&
    config?.automation?.auto_publish_enabled === true &&
    isTruthyEnv("BLOG_PUBLISH");

  const published =
    publishRequested &&
    article.requires_manual_review !== true;

  const html = renderArticleHtml({
    article,
    config,
    published,
    date,
    words: quality.words,
    reading: quality.reading_minutes
  });

  const htmlPath = published
    ? path.join(PATHS.published, `${article.slug}.html`)
    : path.join(PATHS.drafts, `${article.slug}.html`);

  const structuredPath = path.join(
    PATHS.generated,
    `${article.slug}.json`
  );

  const generatedRecord = {
    generated_at: date,
    topic: queueItem.topic,
    category: article.category,
    model,
    response_id: response?.id || null,
    status: published ? "published" : "draft",
    requires_manual_review: article.requires_manual_review,
    review_reasons: article.review_reasons,
    quality: {
      word_count: quality.words,
      reading_minutes: quality.reading_minutes,
      warnings: quality.warnings
    },
    article
  };

  /*
   * Write the article output first.
   * The manifest is updated only after the output files succeed.
   */
  writeText(htmlPath, html);
  writeJson(structuredPath, generatedRecord);

  const manifestRecord = addManifestRecord({
    manifest,
    article,
    config,
    quality,
    date,
    published,
    model,
    queueItem
  });

  writeJson(PATHS.articles, manifest);

  console.log("\nSuccess.");
  console.log(`Article ID: ${manifestRecord.id}`);
  console.log(`Status: ${manifestRecord.status}`);
  console.log(`HTML: ${path.relative(ROOT, htmlPath)}`);
  console.log(`Structured draft: ${path.relative(ROOT, structuredPath)}`);
  console.log(`Manifest updated: ${path.relative(ROOT, PATHS.articles)}`);

  if (article.requires_manual_review) {
    console.log("\nManual review required:");
    for (const reason of article.review_reasons) {
      console.log(`- ${reason}`);
    }
  }

  if (!published) {
    console.log(
      "\nThe article was saved as a noindex draft. Automatic publication is still disabled."
    );
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});

