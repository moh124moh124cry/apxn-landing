/**
 * APXN Blog AI Writer
 * Path: scripts/blog-writer.mjs
 *
 * Purpose:
 * - Uses the APXN knowledge base as the source of truth for APXN project facts.
 * - Builds an audited Evidence Pack from curated official/primary sources before drafting external topics.
 * - Generates English-only articles from the audited Evidence Pack instead of model memory.
 * - Verifies and auto-fixes the article against the same frozen evidence.
 * - Keeps APXN-specific facts grounded in the reviewed internal APXN knowledge base.
 * - Runs local quality, risk, duplicate, source and cost checks.
 * - Never auto-publishes risky, unsourced or review-required content.
 * - Keeps private drafts outside the public Git tree.
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
  topicBank: path.join(ROOT, "data", "blog-topic-bank.json"),
  costs: path.join(ROOT, "data", "blog-costs.json"),
  generated: path.join(ROOT, "data", "generated"),
  published: path.join(ROOT, "blog", "articles"),
  privateDrafts: path.join(ROOT, ".workflow-output", "drafts")
};

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.3";
const COST_TICKS_PER_USD = 10_000_000_000;
const XAI_TIMEOUT_MS = 180_000;
const ABSOLUTE_OUTPUT_TOKEN_CAP = 6_500;
const MAX_WEB_DOMAINS = 5;
const MAX_RECORDED_SOURCES = 12;
const MAX_CORRECTION_ROUNDS = 2;
const MAX_PRODUCTION_TOPIC_ATTEMPTS = 3;
const MAX_TEST_TOPIC_ATTEMPTS = 1;
const EVIDENCE_OUTPUT_TOKEN_CAP = 1_600;
const EVIDENCE_AUDIT_OUTPUT_TOKEN_CAP = 1_400;
const EVIDENCE_RESEARCH_MAX_TURNS = 1;
const EVIDENCE_AUDIT_MAX_TURNS = 1;
const VERIFIER_OUTPUT_TOKEN_CAP = 1_200;
const MIN_EXTERNAL_VERIFIED_CLAIMS = 3;
const MIN_APXN_VERIFIED_CLAIMS = 2;
const MIN_REPAIR_BUDGET_USD = 0.012;
const MAX_EVIDENCE_FACTS = 18;

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

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, filePath);
}

function writeJson(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  writeTextAtomic(filePath, value);
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

function safeFilename(value) {
  return slugify(value) || `article-${Date.now()}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeJsonForScript(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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

function monthKey(dateString = todayISO()) {
  return String(dateString).slice(0, 7);
}

function containsArabicScript(value) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(value || ""));
}

function outputTokenLimit(config) {
  const maximumWords = Number(config?.writer?.maximum_words || 1900);
  const estimated = Math.ceil(maximumWords * 2.5);
  return Math.min(ABSOLUTE_OUTPUT_TOKEN_CAP, Math.max(4_500, estimated));
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function hostnameOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainMatches(hostname, allowedDomain) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  const allowed = String(allowedDomain || "").toLowerCase().replace(/^www\./, "");

  // Exact matching is intentional. Allowing all subdomains can accidentally admit
  // forums, community hosts, archives, or marketing sites when only official docs
  // were intended. Add a subdomain explicitly to the research plan when trusted.
  return host === allowed;
}

function canonicalUrlKey(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    parsed.hash = "";
    parsed.search = "";
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname) pathname = "/";
    return `${parsed.protocol}//${parsed.hostname.toLowerCase().replace(/^www\./, "")}${pathname}`;
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* Research policy                                                            */
/* -------------------------------------------------------------------------- */

function isApXnSpecificTopic(topic) {
  const text = `${topic?.topic || ""} ${topic?.category || ""}`.toLowerCase();

  return (
    /\bapxn\b/.test(text) ||
    /\bapex network\b/.test(text) ||
    /^apxn\b/i.test(String(topic?.category || ""))
  );
}

function buildResearchPlan(topic) {
  const text = `${topic?.topic || ""} ${topic?.category || ""}`.toLowerCase();

  if (isApXnSpecificTopic(topic)) {
    return {
      enabled: false,
      mode: "apxn_knowledge_only",
      reason: "APXN-specific article: internal reviewed project knowledge is the primary source.",
      allowed_domains: [],
      minimum_sources: 0,
      minimum_verified_claims: MIN_APXN_VERIFIED_CLAIMS
    };
  }

  let domains = [];

  // Curated primary/official sources only. Keep domains exact and documentation-first.
  if (/\b(bsc|bnb smart chain|bnb chain|bep-?20|gas fee)\b/.test(text)) {
    domains = ["docs.bnbchain.org"];
  } else if (/\btelegram\b/.test(text) && /\b(initdata|authentication|auth|mini app security)\b/.test(text)) {
    domains = ["core.telegram.org"];
  } else if (/\b(metamask|wallet extension)\b/.test(text)) {
    domains = ["support.metamask.io", "docs.metamask.io", "cisa.gov", "nist.gov"];
  } else if (/\b(security|phishing|private key|seed phrase|authentication|account security)\b/.test(text)) {
    domains = ["cisa.gov", "nist.gov", "ethereum.org", "core.telegram.org"];
  } else if (/\btelegram\b/.test(text)) {
    domains = ["core.telegram.org"];
  } else if (/\b(ethereum|smart contract|solidity|evm)\b/.test(text)) {
    domains = ["ethereum.org", "docs.soliditylang.org"];
  } else if (/\b(bitcoin|proof of work)\b/.test(text)) {
    domains = ["developer.bitcoin.org", "bitcoin.org"];
  } else if (/\b(blockchain)\b/.test(text)) {
    domains = ["ethereum.org", "developer.bitcoin.org", "docs.bnbchain.org"];
  } else if (/\b(web3|decentralized|dapp|dapps)\b/.test(text)) {
    domains = ["ethereum.org", "core.telegram.org", "docs.bnbchain.org"];
  } else if (/\b(node\.?js|javascript|web development|web app)\b/.test(text)) {
    domains = ["nodejs.org", "developer.mozilla.org", "docs.github.com"];
  } else {
    domains = ["ethereum.org", "developer.mozilla.org", "nist.gov"];
  }

  domains = uniqueStrings(domains, MAX_WEB_DOMAINS);

  return {
    enabled: true,
    mode: "official_web_research_and_verification",
    reason: "General/technical article: factual claims must be checked against current official or primary sources.",
    allowed_domains: domains,
    minimum_sources: Math.min(2, domains.length || 1),
    minimum_verified_claims: MIN_EXTERNAL_VERIFIED_CLAIMS
  };
}

/* -------------------------------------------------------------------------- */
/* Cost control                                                               */
/* -------------------------------------------------------------------------- */

function readCostLedger() {
  if (!fs.existsSync(PATHS.costs)) {
    return {
      schema_version: 1,
      provider: "xai",
      currency: "USD",
      months: {}
    };
  }

  return readJson(PATHS.costs);
}

function monthlySpend(ledger, month = monthKey()) {
  const entries = Array.isArray(ledger?.months?.[month]?.requests)
    ? ledger.months[month].requests
    : [];

  return entries.reduce((sum, item) => {
    const value = Number(item?.cost_usd || 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function ensureBudgetAvailable(config, ledger) {
  const control = config?.cost_control || {};
  if (control.enabled !== true) return;

  const budget = Number(control.monthly_budget_usd || 0);
  if (!(budget > 0)) return;

  const spent = monthlySpend(ledger);

  if (
    control.stop_when_monthly_budget_reached === true &&
    spent >= budget
  ) {
    fail(
      `Monthly xAI budget reached: $${spent.toFixed(4)} spent of $${budget.toFixed(2)}.`
    );
  }

  const perArticleTarget = Number(control.maximum_cost_per_article_usd || 0);

  if (
    control.stop_when_monthly_budget_reached === true &&
    perArticleTarget > 0 &&
    spent + perArticleTarget > budget
  ) {
    fail(
      `Monthly budget safety reserve would be exceeded: $${spent.toFixed(4)} already spent, ` +
      `$${perArticleTarget.toFixed(2)} reserved for the next article, budget $${budget.toFixed(2)}.`
    );
  }
}

function topicSpend(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((sum, entry) => {
    const value = Number(entry?.cost_usd);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function canContinueTopicBudget(config, entries, minimumReserve = MIN_REPAIR_BUDGET_USD) {
  const control = config?.cost_control || {};
  if (control.enabled !== true) return true;

  const maximum = Number(control.maximum_cost_per_article_usd || 0);
  if (!(maximum > 0)) return true;

  return topicSpend(entries) + minimumReserve <= maximum;
}

function responseCost(responseJson) {
  const ticks = Number(responseJson?.usage?.cost_in_usd_ticks);

  if (!Number.isFinite(ticks) || ticks < 0) {
    return {
      ticks: null,
      usd: null
    };
  }

  return {
    ticks,
    usd: ticks / COST_TICKS_PER_USD
  };
}

function countServerSideTools(response) {
  const direct = Number(response?.usage?.num_server_side_tools_used);
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const usage =
    response?.server_side_tool_usage ||
    response?.usage?.server_side_tool_usage;

  if (usage && typeof usage === "object") {
    return Object.values(usage).reduce((sum, value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? sum + numeric : sum;
    }, 0);
  }

  return (Array.isArray(response?.output) ? response.output : []).filter(
    (item) => String(item?.type || "").endsWith("_call")
  ).length;
}

function recordCost({
  ledger,
  response,
  model,
  topic,
  articleSlug,
  date,
  research,
  stage = "generation"
}) {
  const month = monthKey(date);
  ledger.months = ledger.months || {};
  ledger.months[month] = ledger.months[month] || {
    requests: []
  };

  const cost = responseCost(response);

  const entry = {
    date,
    response_id: response?.id || null,
    model,
    topic,
    article_slug: articleSlug || null,
    stage,
    input_tokens: Number(response?.usage?.input_tokens || 0),
    cached_input_tokens: Number(
      response?.usage?.input_tokens_details?.cached_tokens || 0
    ),
    output_tokens: Number(response?.usage?.output_tokens || 0),
    reasoning_tokens: Number(
      response?.usage?.output_tokens_details?.reasoning_tokens || 0
    ),
    total_tokens: Number(response?.usage?.total_tokens || 0),
    server_side_tools_used: countServerSideTools(response),
    web_research_enabled: research?.enabled === true,
    web_source_count: Number(research?.sources?.length || 0),
    cost_in_usd_ticks: cost.ticks,
    cost_usd: cost.usd
  };

  ledger.months[month].requests.push(entry);
  ledger.months[month].total_cost_usd = monthlySpend(ledger, month);
  ledger.last_updated = date;

  return entry;
}

/* -------------------------------------------------------------------------- */
/* Validation and queue selection                                             */
/* -------------------------------------------------------------------------- */

function validateConfig(config) {
  if (config?.writer?.enabled !== true) {
    fail("The AI writer is disabled in data/blog-config.json.");
  }

  if (config?.ai?.provider !== "xai") {
    fail('data/blog-config.json must set ai.provider to "xai".');
  }

  if (!config?.ai?.default_model) {
    fail("data/blog-config.json is missing ai.default_model.");
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

  const language = String(config?.site?.default_language || "en")
    .trim()
    .toLowerCase();

  if (language !== "en") {
    fail(`APXN Blog Writer is English-only; site.default_language must be "en", found "${language}".`);
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

  const language = String(manifest?.default_language || "en")
    .trim()
    .toLowerCase();

  if (language !== "en") {
    fail(`data/blog-articles.json must remain English-only; default_language is "${language}".`);
  }
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

function chooseNextTopic(manifest) {
  const waiting = manifest.generation_queue
    .filter((item) => item?.status === "waiting")
    .sort((a, b) => Number(a.priority || 9999) - Number(b.priority || 9999));

  if (waiting.length === 0) {
    fail("No waiting topics found in data/blog-articles.json.");
  }

  let skipped = 0;

  for (const item of waiting) {
    const itemLanguage = String(item?.language || "en").trim().toLowerCase();

    if (itemLanguage !== "en") {
      Object.assign(item, {
        status: "skipped_language",
        skipped_reason: `English-only writer rejected language "${itemLanguage}".`,
        skipped_at: todayISO()
      });
      skipped += 1;
      continue;
    }

    const duplicate = detectDuplicateTopic(item.topic, manifest);

    if (duplicate) {
      Object.assign(item, {
        status: "skipped_duplicate",
        skipped_reason: `Duplicates article ${duplicate.id}: ${duplicate.title}`,
        skipped_at: todayISO()
      });
      skipped += 1;
      continue;
    }

    return { queueItem: item, skipped };
  }

  fail("No eligible waiting topic remains after duplicate/language checks.");
}

/* -------------------------------------------------------------------------- */
/* Prompt building                                                            */
/* -------------------------------------------------------------------------- */

function compactApXnContext(knowledge) {
  return {
    project: "Apex Network (APXN)",
    current_balance_term: "APXN Points",
    editorial_note:
      "Do not invent APXN claims in general educational articles. APXN-specific claims require the full reviewed knowledge base.",
    knowledge_schema_version: knowledge?.schema_version || 1
  };
}

function buildInstructions(config, research, evidencePack = null) {
  const min = Number(config.writer.minimum_words || 1200);
  const target = Number(config.writer.target_words || 1500);
  const max = Number(config.writer.maximum_words || 1900);

  const researchRules = research.enabled
    ? `
AUDITED EVIDENCE MODE:
- The supplied evidence_pack was collected from the configured official sources and independently audited before drafting.
- Treat evidence_pack as the ONLY authority for external technical, numeric, historical, current-status and security claims in this article.
- Do not add a number, date, version, fee, speed, count, protocol behavior, architecture claim, security recommendation or current-status claim unless the evidence pack supports it.
- Every item in factual_claims MUST include evidence_ids pointing to the supporting fact IDs from evidence_pack.
- If the evidence pack does not support a detail, omit that detail or explain the concept without asserting it as fact.
- Never substitute model memory for missing evidence.
- Historical facts must remain clearly historical; current facts must remain current as described by the evidence.
- Do not place raw citation markup in the article body. Source links are attached later from the Evidence Pack.
`
    : `
APXN KNOWLEDGE MODE:
- Use the supplied reviewed APXN knowledge JSON as the source of truth for APXN facts.
- Do not use outside memory to override reviewed APXN behavior.
- If project sources conflict or a claim is marked verify_before_publish/blocked_auto_publish, omit the claim or mark it for correction.
- For APXN factual_claims, use evidence_ids=["APXN-KNOWLEDGE"] to show that the claim is grounded in the reviewed project knowledge base.
`;

  return `
You are the APXN Blog editorial writer for Apex Network.
Create an accurate, useful, original, SEO-friendly article in ENGLISH ONLY.

MANDATORY APXN RULES:
1. Current in-app balances are "APXN Points" unless explicitly discussing a future token.
2. Never describe the Claim action as proof-of-work, proof-of-stake, or blockchain consensus mining.
3. Never promise profit, returns, token value, listing, conversion value, or guaranteed withdrawal.
4. Never present planned Testnet, Mainnet, staking, presale, exchange support, upgrades, or roadmap items as live without reviewed proof.
5. Never claim permanent wallet binding when persistence is not implemented.
6. Country information is informational, not KYC or identity proof.
7. The article must provide educational value beyond promotion.
8. Do not include Arabic text.
${researchRules}
WRITING REQUIREMENTS:
- Target about ${target} words; minimum ${min}; maximum target ${max}.
- Clear beginner-friendly English with at least 6 substantive sections.
- Include practical examples when useful and at least 2 FAQ items.
- Avoid hype, keyword stuffing, stale numbers, and unsupported certainty.
- Include a responsible educational disclaimer for financial/token/presale concepts.
- Return ONE valid JSON object only; no Markdown fences and no HTML.

For factual_claims, list every material technical/current/project claim made in the article, and attach the evidence_ids that support it.
`.trim();
}

function buildInput(topic, config, knowledge, manifest, research, evidencePack = null) {
  const existing = manifest.articles.map((article) => ({
    id: article.id,
    slug: article.slug,
    title: article.title,
    category: article.category,
    status: article.status
  }));

  return JSON.stringify(
    {
      current_date: todayISO(),
      apxn_context: research.enabled ? compactApXnContext(knowledge) : knowledge,
      evidence_pack: research.enabled ? evidencePack : undefined,
      configured_categories: config.categories,
      writer_settings: {
        language: "en",
        minimum_words: config.writer.minimum_words,
        target_words: config.writer.target_words,
        maximum_words: config.writer.maximum_words,
        include_faq: config.writer.include_faq,
        include_disclaimer: config.writer.include_disclaimer,
        include_internal_links: config.writer.include_internal_links
      },
      research_policy: {
        mode: research.mode,
        required: research.enabled,
        allowed_domains: research.allowed_domains,
        minimum_sources: research.minimum_sources,
        minimum_verified_claims: research.minimum_verified_claims
      },
      task: {
        topic: topic.topic,
        requested_category: topic.category,
        priority: topic.priority,
        language: "en"
      },
      existing_articles_do_not_duplicate: existing
    },
    null,
    2
  );
}

/* -------------------------------------------------------------------------- */
/* xAI / Grok                                                                 */
/* -------------------------------------------------------------------------- */

function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const pieces = [];
  for (const outputItem of Array.isArray(responseJson?.output) ? responseJson.output : []) {
    for (const content of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      if (typeof content?.text === "string") pieces.push(content.text);
    }
  }
  return pieces.join("\n").trim();
}

function parseGeneratedJson(rawText) {
  let text = String(rawText || "").trim()
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
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through.
      }
    }
  }
  fail("Grok returned invalid JSON.");
}

function buildArticleSchema(config) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title", "slug", "description", "excerpt", "category", "keywords",
      "sections", "faq", "disclaimer", "requires_manual_review",
      "review_reasons", "claims_used", "factual_claims"
    ],
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      description: { type: "string" },
      excerpt: { type: "string" },
      category: { type: "string", enum: config.categories },
      keywords: { type: "array", items: { type: "string" } },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["heading", "paragraphs"],
          properties: {
            heading: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } }
          }
        }
      },
      faq: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "answer"],
          properties: {
            question: { type: "string" },
            answer: { type: "string" }
          }
        }
      },
      disclaimer: { type: "string" },
      requires_manual_review: { type: "boolean" },
      review_reasons: { type: "array", items: { type: "string" } },
      claims_used: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "knowledge_status"],
          properties: {
            claim: { type: "string" },
            knowledge_status: {
              type: "string",
              enum: ["implemented", "official_ui_claim", "ui_only", "planned", "verify_before_publish", "blocked_auto_publish"]
            }
          }
        }
      },
      factual_claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "kind", "time_sensitive", "evidence_ids"],
          properties: {
            claim: { type: "string" },
            kind: {
              type: "string",
              enum: ["project", "technical", "numeric", "security", "historical", "current_status", "general"]
            },
            time_sensitive: { type: "boolean" },
            evidence_ids: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  };
}

function buildEvidencePackSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["as_of_date", "summary", "sufficient", "facts", "conflicts", "warnings"],
    properties: {
      as_of_date: { type: "string" },
      summary: { type: "string" },
      sufficient: { type: "boolean" },
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "claim", "kind", "temporal_status", "confidence", "source_urls"],
          properties: {
            id: { type: "string" },
            claim: { type: "string" },
            kind: { type: "string", enum: ["technical", "numeric", "security", "historical", "current_status", "general"] },
            temporal_status: { type: "string", enum: ["current", "stable", "historical"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            source_urls: { type: "array", items: { type: "string" } }
          }
        }
      },
      conflicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "details", "resolved"],
          properties: {
            claim: { type: "string" },
            details: { type: "string" },
            resolved: { type: "boolean" }
          }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function buildVerificationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "confidence", "summary", "checked_claims", "issues"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fix"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      summary: { type: "string" },
      checked_claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "status", "importance", "source_urls"],
          properties: {
            claim: { type: "string" },
            status: { type: "string", enum: ["verified", "incorrect", "outdated", "uncertain", "not_applicable"] },
            importance: { type: "string", enum: ["critical", "major", "minor"] },
            source_urls: { type: "array", items: { type: "string" } }
          }
        }
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "problem", "correction", "severity", "source_urls"],
          properties: {
            claim: { type: "string" },
            problem: { type: "string" },
            correction: { type: "string" },
            severity: { type: "string", enum: ["critical", "major", "minor"] },
            source_urls: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  };
}

function resolveXaiEndpoint(config) {
  const base = String(config?.ai?.api_base_url || DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
  const endpoint = String(config?.ai?.responses_endpoint || "/responses");
  return `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

function normalizeSource(raw) {
  const url = safeUrl(raw?.url || raw?.link || raw?.href);
  if (!url) return null;
  const domain = hostnameOf(url);
  const title = normalizeSpace(raw?.title || raw?.name || domain || url);
  return { title: title || domain || url, url, domain };
}

function extractWebSources(response, research) {
  const found = [];
  const seen = new Set();

  function add(raw) {
    const source = normalizeSource(raw);
    if (!source) return;
    if (
      research?.enabled &&
      Array.isArray(research.allowed_domains) &&
      research.allowed_domains.length > 0 &&
      !research.allowed_domains.some((domain) => domainMatches(source.domain, domain))
    ) return;

    const key = source.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(source);
  }

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (Array.isArray(item?.action?.sources)) {
      for (const source of item.action.sources) add(source);
    }
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        if (annotation?.url || annotation?.link || annotation?.href) add(annotation);
      }
    }
  }
  return found.slice(0, MAX_RECORDED_SOURCES);
}

function mergeSources(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const raw of Array.isArray(group) ? group : []) {
      const source = normalizeSource(raw) || raw;
      if (!source?.url) continue;
      const key = String(source.url).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
      if (merged.length >= MAX_RECORDED_SOURCES) return merged;
    }
  }
  return merged;
}

async function callStructuredXAI({
  apiKey,
  model,
  instructions,
  input,
  config,
  research,
  schema,
  schemaName,
  maxOutputTokens,
  useWebSearch = research?.enabled === true,
  maxTurns = null
}) {
  const requestBody = {
    model,
    input: [
      { role: "system", content: instructions },
      { role: "user", content: input }
    ],
    max_output_tokens: maxOutputTokens,
    store: false,
    truncation: "disabled",
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true
      }
    }
  };

  if (useWebSearch) {
    requestBody.tools = [{
      type: "web_search",
      filters: { allowed_domains: research.allowed_domains.slice(0, MAX_WEB_DOMAINS) }
    }];
    requestBody.include = ["no_inline_citations", "web_search_call.action.sources"];

    if (Number.isInteger(maxTurns) && maxTurns > 0) {
      requestBody.max_turns = maxTurns;
    }
  }

  const reasoningEffort = String(config?.ai?.reasoning_effort || "none").trim();
  if (reasoningEffort) requestBody.reasoning = { effort: reasoningEffort };

  if (config?.cost_control?.use_prompt_caching === true && config?.ai?.prompt_cache_key) {
    requestBody.prompt_cache_key = String(config.ai.prompt_cache_key);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), XAI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(resolveXaiEndpoint(config), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail(`xAI API request timed out after ${Math.round(XAI_TIMEOUT_MS / 1000)} seconds.`);
    }
    fail(`xAI API request failed before receiving a response: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail(`xAI API returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    fail(data?.error?.message || data?.message || `xAI API request failed with HTTP ${response.status}.`);
  }
  if (data?.status && data.status !== "completed") {
    fail(`xAI response did not complete successfully: ${data?.incomplete_details?.reason || data?.status}.`);
  }

  const outputText = extractResponseText(data);
  if (!outputText) fail("xAI API returned no usable structured output.");

  return {
    response: data,
    generated: parseGeneratedJson(outputText),
    sources: extractWebSources(data, research || { enabled: false, allowed_domains: [] }),
    serverSideToolsUsed: countServerSideTools(data)
  };
}

function buildEvidenceResearchInstructions(research) {
  return `
You are the research librarian for an automated English educational blog.
Do NOT write an article. Build a compact Evidence Pack from web_search using ONLY these official domains: ${research.allowed_domains.join(", ")}.

RULES:
- Prefer current official documentation over old announcements, archived pages, community posts, forums, SEO pages or model memory.
- Every fact must be directly supported by at least one page you actually opened through web_search.
- source_urls must contain only URLs you actually used from the allowed official domains.
- Keep only facts that are materially useful to the requested topic.
- For changing facts (versions, fees, speeds, counts, current architecture, feature state), verify what is current as of ${todayISO()}.
- If a page is historical, label the fact historical and never present it as current.
- If official sources conflict and you cannot resolve the conflict confidently, put it in conflicts with resolved=false and OMIT that fact from facts.
- Avoid fragile live metrics unless they are central to the topic.
- Do not invent or infer unsupported precise values.
- Mark sufficient=false if you cannot collect enough authoritative evidence to write a useful article safely.
- Return JSON only.
`.trim();
}

function buildEvidenceResearchInput(queueItem, research) {
  return JSON.stringify({
    current_date: todayISO(),
    topic: queueItem.topic,
    category: queueItem.category,
    allowed_domains: research.allowed_domains,
    minimum_sources: research.minimum_sources,
    minimum_facts: research.minimum_verified_claims,
    maximum_facts: MAX_EVIDENCE_FACTS
  }, null, 2);
}

function normalizeEvidencePack(raw, research, toolSources = []) {
  const acceptedToolSources = (Array.isArray(toolSources) ? toolSources : [])
    .filter((source) => source?.url && research.allowed_domains.some((domain) => domainMatches(source.domain, domain)));
  const returnedKeys = new Set(acceptedToolSources.map((source) => canonicalUrlKey(source.url)).filter(Boolean));

  const facts = (Array.isArray(raw?.facts) ? raw.facts : [])
    .map((item, index) => {
      const id = safeFilename(item?.id || `fact-${index + 1}`).toUpperCase();
      const sourceUrls = uniqueStrings(item?.source_urls, 6).filter((url) => {
        const safe = safeUrl(url);
        if (!safe) return false;
        if (!research.allowed_domains.some((domain) => domainMatches(hostnameOf(safe), domain))) return false;
        const key = canonicalUrlKey(safe);
        return key && returnedKeys.has(key);
      });
      return {
        id,
        claim: normalizeSpace(item?.claim),
        kind: ["technical", "numeric", "security", "historical", "current_status", "general"].includes(item?.kind)
          ? item.kind
          : "general",
        temporal_status: ["current", "stable", "historical"].includes(item?.temporal_status)
          ? item.temporal_status
          : "stable",
        confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low",
        source_urls: sourceUrls
      };
    })
    .filter((item) => item.claim && item.confidence !== "low" && item.source_urls.length > 0)
    .slice(0, MAX_EVIDENCE_FACTS);

  const conflicts = (Array.isArray(raw?.conflicts) ? raw.conflicts : [])
    .map((item) => ({
      claim: normalizeSpace(item?.claim),
      details: normalizeSpace(item?.details),
      resolved: item?.resolved === true
    }))
    .filter((item) => item.claim || item.details);

  const usedUrls = new Set();
  for (const fact of facts) {
    for (const url of fact.source_urls) usedUrls.add(canonicalUrlKey(url));
  }
  const sources = acceptedToolSources.filter((source) => usedUrls.has(canonicalUrlKey(source.url)));

  return {
    as_of_date: normalizeSpace(raw?.as_of_date || todayISO()),
    summary: normalizeSpace(raw?.summary),
    sufficient: raw?.sufficient === true,
    facts,
    conflicts,
    warnings: uniqueStrings(raw?.warnings, 20),
    sources,
    server_side_tools_used: 0
  };
}

function evidencePackPasses(pack, research) {
  if (!research.enabled) return true;
  if (!pack || pack.sufficient !== true) return false;
  if (pack.facts.length < Number(research.minimum_verified_claims || 1)) return false;
  if (pack.sources.length < Number(research.minimum_sources || 1)) return false;
  if (pack.conflicts.some((item) => item.resolved !== true)) return false;
  if (pack.facts.some((fact) => fact.source_urls.length === 0 || fact.confidence === "low")) return false;
  return true;
}

async function researchEvidence({ apiKey, model, config, queueItem, research }) {
  return callStructuredXAI({
    apiKey,
    model,
    instructions: buildEvidenceResearchInstructions(research),
    input: buildEvidenceResearchInput(queueItem, research),
    config,
    research,
    schema: buildEvidencePackSchema(),
    schemaName: "apxn_external_evidence_pack",
    maxOutputTokens: EVIDENCE_OUTPUT_TOKEN_CAP,
    useWebSearch: true,
    maxTurns: EVIDENCE_RESEARCH_MAX_TURNS
  });
}

function buildEvidenceAuditInstructions(research) {
  return `
You are the independent Evidence Pack auditor for an automated blog.
Use web_search ONLY on these official domains: ${research.allowed_domains.join(", ")}.
Do NOT write an article.

Audit the supplied candidate Evidence Pack against current official documentation as of ${todayISO()}.
- Return a REPLACEMENT Evidence Pack, not commentary.
- Keep a fact only if you directly verified it from a page you opened in this audit.
- Correct stale wording, old names, outdated metrics and historical/current confusion.
- Remove any fact you cannot directly support.
- source_urls must be URLs you actually used in this audit.
- If official evidence conflicts and the conflict cannot be resolved, record unresolved conflict and omit the disputed fact.
- Prefer stable facts; include volatile facts only when central to the topic and clearly current.
- Mark sufficient=false if the remaining audited facts are not enough for a useful accurate article.
Return JSON only.
`.trim();
}

async function auditEvidence({ apiKey, model, config, queueItem, research, evidencePack }) {
  return callStructuredXAI({
    apiKey,
    model,
    instructions: buildEvidenceAuditInstructions(research),
    input: JSON.stringify({
      current_date: todayISO(),
      topic: queueItem.topic,
      category: queueItem.category,
      allowed_domains: research.allowed_domains,
      candidate_evidence_pack: evidencePack
    }, null, 2),
    config,
    research,
    schema: buildEvidencePackSchema(),
    schemaName: "apxn_audited_evidence_pack",
    maxOutputTokens: EVIDENCE_AUDIT_OUTPUT_TOKEN_CAP,
    useWebSearch: true,
    maxTurns: EVIDENCE_AUDIT_MAX_TURNS
  });
}

async function generateArticle({ apiKey, model, config, knowledge, manifest, queueItem, research, evidencePack }) {
  return callStructuredXAI({
    apiKey,
    model,
    instructions: buildInstructions(config, research, evidencePack),
    input: buildInput(queueItem, config, knowledge, manifest, research, evidencePack),
    config,
    research: { ...research, enabled: false },
    schema: buildArticleSchema(config),
    schemaName: "apxn_blog_article",
    maxOutputTokens: outputTokenLimit(config),
    useWebSearch: false
  });
}

function buildVerifierInstructions(research) {
  const sourceRule = research.enabled
    ? `Use ONLY the supplied audited evidence_pack. Do not browse the web and do not use model memory to supply missing facts.`
    : `Use only the supplied reviewed APXN knowledge base. Do not use outside assumptions to override it.`;

  return `
You are an independent factual verifier. Do NOT rewrite the article.
${sourceRule}

Check every material factual claim, especially:
- numbers, percentages, dates, versions, limits, fees, speeds, block times, counts and defaults;
- current/live/planned/deprecated feature status;
- protocol/network/product names and architecture;
- wallet, authentication and security guidance;
- claims using current, now, latest, today, always, never, guaranteed or typically;
- APXN project claims against the supplied reviewed knowledge when in APXN mode.

In audited-evidence mode, a claim is verified only if the Evidence Pack directly supports the wording. Use the supporting fact source_urls in checked_claims. If a claim is missing from the evidence, mark it uncertain and request removal rather than filling the gap from memory.
Historical facts are allowed only when clearly described as historical.
If wording is too broad, absolute, misleading or unsupported, create an issue with a precise correction or instruct removal.
Return JSON only.
`.trim();
}

function buildVerifierInput({ article, queueItem, knowledge, research, evidencePack }) {
  return JSON.stringify({
    current_date: todayISO(),
    topic: queueItem.topic,
    research_policy: {
      mode: research.mode,
      allowed_domains: research.allowed_domains,
      minimum_verified_claims: research.minimum_verified_claims
    },
    audited_evidence_pack: research.enabled ? evidencePack : undefined,
    apxn_knowledge_base: research.enabled ? undefined : knowledge,
    article
  }, null, 2);
}

async function verifyArticle({
  apiKey, model, config, article, queueItem, knowledge, research, evidencePack
}) {
  return callStructuredXAI({
    apiKey,
    model,
    instructions: buildVerifierInstructions(research),
    input: buildVerifierInput({ article, queueItem, knowledge, research, evidencePack }),
    config,
    research: { ...research, enabled: false },
    schema: buildVerificationSchema(),
    schemaName: "apxn_article_verification",
    maxOutputTokens: VERIFIER_OUTPUT_TOKEN_CAP,
    useWebSearch: false
  });
}

function buildCorrectionInstructions(config, research) {
  return `
You are the APXN Blog correction editor. Rewrite the supplied article JSON so every verifier issue and local quality blocker is resolved.
- Preserve the same topic and English-only language.
- Keep the article between ${config.writer.minimum_words} and ${config.writer.maximum_words} words when practical.
- Remove unsupported or uncertain claims instead of guessing.
- Apply the verifier's precise correction when provided.
- ${research.enabled ? "Use ONLY the supplied audited Evidence Pack for external facts and preserve valid evidence_ids." : "Use only the supplied reviewed APXN knowledge base for APXN facts."}
- Do not introduce new changing numbers, dates, versions, fees, current-status claims, security absolutes, or named listings that are not in the allowed evidence.
- Preserve APXN terminology and safety rules.
- Keep at least 6 substantive sections and 2 FAQ entries.
- Set requires_manual_review=false only when all supplied issues are actually resolved.
- Return one JSON object matching the article schema; no HTML or Markdown fences.
`.trim();
}

async function correctArticle({
  apiKey, model, config, article, verification, quality, queueItem, knowledge, research, evidencePack
}) {
  const input = JSON.stringify({
    current_date: todayISO(),
    topic: queueItem.topic,
    article_to_correct: article,
    verifier_report: verification,
    local_quality_errors: quality.errors,
    local_review_reasons: article.review_reasons,
    audited_evidence_pack: research.enabled ? evidencePack : undefined,
    apxn_knowledge_base: research.enabled ? undefined : knowledge
  }, null, 2);

  return callStructuredXAI({
    apiKey,
    model,
    instructions: buildCorrectionInstructions(config, research),
    input,
    config,
    research: { ...research, enabled: false },
    schema: buildArticleSchema(config),
    schemaName: "apxn_corrected_article",
    maxOutputTokens: outputTokenLimit(config),
    useWebSearch: false
  });
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

  const factualClaims = (Array.isArray(raw?.factual_claims) ? raw.factual_claims : [])
    .map((item) => ({
      claim: normalizeSpace(item?.claim),
      kind: normalizeSpace(item?.kind || "general"),
      time_sensitive: item?.time_sensitive === true,
      evidence_ids: uniqueStrings(item?.evidence_ids, 12)
    }))
    .filter((item) => item.claim)
    .slice(0, 40);

  return {
    title,
    slug,
    description,
    excerpt,
    category,
    language: "en",
    keywords: uniqueStrings(raw?.keywords, 12),
    sections,
    faq,
    disclaimer: normalizeSpace(raw?.disclaimer),
    requires_manual_review: raw?.requires_manual_review === true,
    review_reasons: uniqueStrings(raw?.review_reasons, 20),
    claims_used: claimsUsed,
    factual_claims: factualClaims
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

function normalizeVerificationReport(raw, research) {
  const checkedClaims = (Array.isArray(raw?.checked_claims) ? raw.checked_claims : [])
    .map((item) => ({
      claim: normalizeSpace(item?.claim),
      status: normalizeSpace(item?.status),
      importance: normalizeSpace(item?.importance),
      source_urls: uniqueStrings(item?.source_urls, 8).filter((url) => {
        const safe = safeUrl(url);
        if (!safe) return false;
        if (!research.enabled) return true;
        return research.allowed_domains.some((domain) => domainMatches(hostnameOf(safe), domain));
      })
    }))
    .filter((item) => item.claim);

  const issues = (Array.isArray(raw?.issues) ? raw.issues : [])
    .map((item) => ({
      claim: normalizeSpace(item?.claim),
      problem: normalizeSpace(item?.problem),
      correction: normalizeSpace(item?.correction),
      severity: normalizeSpace(item?.severity),
      source_urls: uniqueStrings(item?.source_urls, 8).filter((url) => {
        const safe = safeUrl(url);
        if (!safe) return false;
        if (!research.enabled) return true;
        return research.allowed_domains.some((domain) => domainMatches(hostnameOf(safe), domain));
      })
    }))
    .filter((item) => item.claim || item.problem);

  return {
    verdict: raw?.verdict === "pass" ? "pass" : "fix",
    confidence: ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "low",
    summary: normalizeSpace(raw?.summary),
    checked_claims: checkedClaims,
    issues,
    server_side_tools_used: 0
  };
}

function verificationPasses(report, research, evidencePack = null) {
  if (!report || report.verdict !== "pass" || report.confidence === "low") return false;
  if (report.issues.length > 0) return false;

  const bad = report.checked_claims.filter((item) =>
    ["incorrect", "outdated", "uncertain"].includes(item.status)
  );
  if (bad.length > 0) return false;

  const verifiedClaims = report.checked_claims.filter((item) => item.status === "verified");
  if (verifiedClaims.length < Number(research.minimum_verified_claims || 1)) return false;

  if (research.enabled) {
    const evidenceSourceKeys = new Set(
      (evidencePack?.sources || []).map((source) => canonicalUrlKey(source.url)).filter(Boolean)
    );
    const sourcedVerified = verifiedClaims.filter((item) =>
      item.source_urls.some((url) => evidenceSourceKeys.has(canonicalUrlKey(url)))
    );
    if (sourcedVerified.length < Number(research.minimum_verified_claims || 1)) return false;
  }

  return true;
}

function combinedVerificationSources(resultSources, report) {
  const reportSources = [];
  for (const item of [...(report?.checked_claims || []), ...(report?.issues || [])]) {
    for (const url of item?.source_urls || []) {
      reportSources.push({ url, title: hostnameOf(url), domain: hostnameOf(url) });
    }
  }
  return mergeSources(resultSources, reportSources);
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
      regex: /\b(?:binance|coinbase|kucoin|bybit|bitmart)\b.{0,50}\b(?:list|listed|listing|launch)\b/i,
      reason: "Named exchange listing claim requires manual verification."
    },
    {
      regex: /\b(?:confirmed listing|will be listed|guaranteed listing)\b/i,
      reason: "Exchange-listing certainty is not allowed for automatic publication."
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
      regex: /\b(?:audited by thirdweb|verified and audited contract|thirdweb audit|audited contract)\b/i,
      reason: "External smart-contract audit claims require manual verification."
    },
    {
      regex: /\b(?:locked liquidity|liquidity is locked|liquidity lock)\b/i,
      reason: "Liquidity-lock claims require external verification."
    },
    {
      regex: /\b(?:no hidden taxes|no mint|minting disabled forever)\b/i,
      reason: "Smart-contract restriction claims require verification before automatic publication."
    },
    {
      regex: /\bpancakeswap\b/i,
      reason: "PancakeSwap/liquidity availability claims require current external verification."
    },
    {
      regex: /\bguaranteed decentralized trading\b/i,
      reason: "Guaranteed trading claims are not allowed for automatic publication."
    },
    {
      regex: /\b(?:guaranteed profit|guaranteed profits|guaranteed return|guaranteed returns|risk[- ]free profit)\b/i,
      reason: "Guaranteed financial outcome language is not allowed."
    },
    {
      regex: /\b(?:apxn will be worth|apxn price will|price will reach|guaranteed price)\b/i,
      reason: "Future token price predictions require manual review and must not be guaranteed."
    },
    {
      regex: /\b(?:withdraw apxn now|cash out apxn now|currently withdrawable apxn)\b/i,
      reason: "Current APXN Points must not be presented as a withdrawable token balance."
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
    },
    {
      regex: /\b60\s*%\s+(?:airdrop|of the airdrop)\b/i,
      reason: "A 60% airdrop entitlement claim requires current project verification."
    },
    {
      regex: /\bfirst\s+10[,.]?000\s+(?:active\s+)?miners\b/i,
      reason: "First-10,000-miners eligibility language requires current project verification."
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

function applyResearchChecks(article, research) {
  if (!research.enabled) return;

  const sourceCount = Array.isArray(research.sources)
    ? research.sources.length
    : 0;

  if (research.server_side_tools_used < 1) {
    article.requires_manual_review = true;
    article.review_reasons.push(
      "External research was required, but xAI reported no server-side tool usage."
    );
  }

  if (sourceCount < research.minimum_sources) {
    article.requires_manual_review = true;
    article.review_reasons.push(
      `External research was required, but only ${sourceCount} acceptable source(s) were returned; minimum is ${research.minimum_sources}.`
    );
  }

  for (const source of research.sources) {
    const allowed = research.allowed_domains.some((domain) =>
      domainMatches(source.domain, domain)
    );

    if (!allowed) {
      article.requires_manual_review = true;
      article.review_reasons.push(
        `Unexpected research source domain requires review: ${source.domain}`
      );
    }
  }

  article.review_reasons = uniqueStrings(article.review_reasons, 30);
}

function runQualityChecks(article, config, manifest, research, evidencePack = null) {
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
  const hardMaximum = maximum + 200;

  if (containsArabicScript(plain)) {
    errors.push("Arabic-script text was detected. APXN Blog publishing is English-only.");
  }

  if (research.enabled) {
    const validEvidenceIds = new Set((evidencePack?.facts || []).map((fact) => fact.id));
    if (article.factual_claims.length < Number(research.minimum_verified_claims || 1)) {
      errors.push("External article did not declare enough material factual claims for evidence checking.");
    }
    for (const claim of article.factual_claims) {
      if (!Array.isArray(claim.evidence_ids) || claim.evidence_ids.length === 0) {
        errors.push(`Factual claim has no evidence_ids: ${claim.claim}`);
        continue;
      }
      const unknown = claim.evidence_ids.filter((id) => !validEvidenceIds.has(id));
      if (unknown.length > 0) {
        errors.push(`Factual claim references unknown evidence IDs (${unknown.join(", ")}): ${claim.claim}`);
      }
    }
  }

  if (words < minimum) {
    errors.push(`Article is too short: ${words} words; minimum is ${minimum}.`);
  }

  if (words > maximum) {
    warnings.push(
      `Article is above the configured target maximum: ${words} words; target maximum is ${maximum}.`
    );
  }

  if (words > hardMaximum) {
    errors.push(
      `Article is too long: ${words} words; hard maximum is ${hardMaximum}.`
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

  // Independent verification, not the writer's own research pass, decides whether
  // external facts are publishable. This avoids forcing an unnecessary rewrite
  // when the verifier has already checked the claims against official sources.

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
/* Internal links and source rendering                                        */
/* -------------------------------------------------------------------------- */

function chooseRelatedArticles(manifest, article, limit = 3) {
  const published = manifest.articles.filter(
    (item) => item?.status === "published" && item?.slug && item?.slug !== article.slug
  );

  const sameCategory = published.filter(
    (item) => item?.category === article.category
  );

  const other = published.filter(
    (item) => item?.category !== article.category
  );

  return [...sameCategory, ...other].slice(0, limit);
}

function renderRelatedArticles(relatedArticles) {
  if (!Array.isArray(relatedArticles) || relatedArticles.length === 0) {
    return "";
  }

  const cards = relatedArticles
    .map((item) => {
      const title = escapeHtml(item.title || item.slug);
      const category = escapeHtml(item.category || "APXN Blog");
      const href = `${encodeURIComponent(item.slug)}.html`;

      return `
                    <a href="${href}" class="block bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-yellow-500/40 transition-colors">
                        <div class="text-[11px] font-black uppercase tracking-widest text-yellow-500 mb-2">${category}</div>
                        <div class="font-black text-white leading-snug">${title}</div>
                    </a>`;
    })
    .join("\n");

  return `
                <section class="mt-12">
                    <h2 class="text-2xl font-black mb-5">Related APXN Blog guides</h2>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
${cards}
                    </div>
                </section>`;
}

function renderSources(research) {
  if (!research?.enabled || !Array.isArray(research.sources) || research.sources.length === 0) {
    return "";
  }

  const items = research.sources
    .map((source) => {
      const title = escapeHtml(source.title || source.domain || source.url);
      const domain = escapeHtml(source.domain || "");
      const url = escapeHtml(source.url);

      return `
                        <li>
                            <a href="${url}" target="_blank" rel="noopener noreferrer" class="text-yellow-400 hover:text-yellow-300 font-bold">
                                ${title}
                            </a>
                            ${domain ? `<span class="text-gray-600"> — ${domain}</span>` : ""}
                        </li>`;
    })
    .join("\n");

  return `
                <section class="mt-12 bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8">
                    <h2 class="text-2xl font-black mb-3">Sources and further reading</h2>
                    <p class="text-sm text-gray-500 leading-relaxed mb-5">
                        Current technical facts in this guide were checked with xAI Web Search restricted to approved official or primary sources.
                    </p>
                    <ol class="space-y-3 text-sm text-gray-400 list-decimal pl-5">
${items}
                    </ol>
                </section>`;
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
  date,
  words,
  reading,
  relatedArticles,
  research
}) {
  const baseUrl = String(config.site?.base_url || "https://apxn.network")
    .replace(/\/+$/, "");

  const articleUrl = `${baseUrl}/blog/articles/${article.slug}.html`;
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

  const relatedHtml = renderRelatedArticles(relatedArticles);
  const sourcesHtml = renderSources(research);

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>${escapeHtml(article.title)}</title>
    <meta name="description" content="${escapeHtml(article.description)}">
    <meta name="keywords" content="${escapeHtml(article.keywords.join(", "))}">
    <meta name="robots" content="index, follow">
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

        @media (max-width: 640px) {
            .article-body h2 { font-size: 1.45rem; }
        }
    </style>

    <script type="application/ld+json">
${safeJsonForScript(jsonLd)}
    </script>
${faqSchema ? `
    <script type="application/ld+json">
${safeJsonForScript(faqSchema)}
    </script>` : ""}
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
${sourcesHtml}
${relatedHtml}

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
                    <a href="../../about.html" class="hover:text-yellow-400">About</a>
                    <a href="../../contact.html" class="hover:text-yellow-400">Contact</a>
                    <a href="../../editorial-policy.html" class="hover:text-yellow-400">Editorial Policy</a>
                    <a href="../../disclaimer.html" class="hover:text-yellow-400">Disclaimer</a>
                    <a href="../../privacy.html" class="hover:text-yellow-400">Privacy Policy</a>
                    <a href="../../terms.html" class="hover:text-yellow-400">Terms & Conditions</a>
                </div>
            </div>
        </div>
    </footer>

</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* Manifest and topic-bank mutation                                           */
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
  queueItem,
  structuredPath,
  research,
  verification
}) {
  const id = nextArticleId(manifest.articles);
  const baseUrl = String(config.site?.base_url || "https://apxn.network")
    .replace(/\/+$/, "");

  const relativePath = published
    ? `blog/articles/${article.slug}.html`
    : null;

  const url = published
    ? `${baseUrl}/${relativePath}`
    : null;

  const record = {
    id,
    slug: article.slug,
    title: article.title,
    description: article.description,
    category: article.category,
    language: "en",
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
    draft_artifact_path: published
      ? null
      : path.relative(ROOT, structuredPath).replaceAll(path.sep, "/"),

    image:
      config.seo?.default_og_image ||
      `${baseUrl}/logo2%20(1).png`,

    keywords: article.keywords,

    source: "ai",
    ai_model: model,
    knowledge_schema_version: 1,
    verified_against_knowledge:
      !research.enabled && !article.requires_manual_review,
    verified_with_web_sources:
      research.enabled &&
      research.sources.length >= research.minimum_sources &&
      !article.requires_manual_review,
    requires_manual_review: article.requires_manual_review,
    review_reasons: article.review_reasons,

    verification: {
      verdict: verification?.verdict || null,
      confidence: verification?.confidence || null,
      checked_claims: verification?.checked_claims?.length || 0,
      issues: verification?.issues?.length || 0
    },

    research: {
      mode: research.mode,
      web_search_enabled: research.enabled,
      server_side_tools_used: research.server_side_tools_used,
      source_count: research.sources.length,
      source_domains: uniqueStrings(
        research.sources.map((source) => source.domain),
        MAX_RECORDED_SOURCES
      )
    },

    seo: {
      canonical: published ? url : null,
      robots: published ? "index, follow" : "noindex, nofollow",
      article_schema: published,
      faq_schema: published && article.faq.length > 0
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

function updateTopicBank({
  bank,
  queueItem,
  published,
  articleId,
  slug,
  date
}) {
  if (!bank || !Array.isArray(bank.topics) || !queueItem?.topic_bank_id) {
    return false;
  }

  const item = bank.topics.find(
    (entry) => entry?.id === queueItem.topic_bank_id
  );

  if (!item) return false;

  Object.assign(item, {
    status: published ? "published" : "drafted",
    article_id: articleId,
    article_slug: slug,
    used_at: date
  });

  bank.last_updated = date;
  bank.planner_state = bank.planner_state || {};
  bank.planner_state.available_topics = bank.topics.filter(
    (entry) => entry?.status === "available"
  ).length;
  bank.planner_state.queued_topics = bank.topics.filter(
    (entry) => entry?.status === "queued"
  ).length;
  bank.planner_state.used_topics = bank.topics.filter((entry) =>
    ["used", "published", "drafted"].includes(entry?.status)
  ).length;

  return true;
}

function markTopicRejected({ manifest, bank, queueItem, date, reasons }) {
  updateQueueItem(queueItem, {
    status: "skipped_verification",
    skipped_at: date,
    skipped_reason: uniqueStrings(reasons, 12).join(" | ") || "Could not pass automated verification within safety limits."
  });

  if (bank && Array.isArray(bank.topics) && queueItem?.topic_bank_id) {
    const item = bank.topics.find((entry) => entry?.id === queueItem.topic_bank_id);
    if (item) {
      Object.assign(item, {
        status: "used",
        result: "rejected_verification",
        used_at: date,
        rejection_reason: queueItem.skipped_reason
      });
      bank.last_updated = date;
      bank.planner_state = bank.planner_state || {};
      bank.planner_state.available_topics = bank.topics.filter((entry) => entry?.status === "available").length;
      bank.planner_state.queued_topics = bank.topics.filter((entry) => entry?.status === "queued").length;
      bank.planner_state.used_topics = bank.topics.filter((entry) =>
        ["used", "published", "drafted"].includes(entry?.status)
      ).length;
    }
  }

  manifest.last_updated = date;
}

function diagnosticDraftPaths(article) {
  const slug = article?.slug || `failed-${Date.now()}`;
  return {
    json: path.join(PATHS.privateDrafts, `${slug}.json`),
    html: path.join(PATHS.privateDrafts, `${slug}.html`)
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function processTopic({
  config,
  knowledge,
  manifest,
  topicBank,
  queueItem,
  apiKey,
  model,
  costLedger,
  publishRequested
}) {
  const date = todayISO();
  const costEntries = [];
  const research = {
    ...buildResearchPlan(queueItem),
    sources: [],
    server_side_tools_used: 0
  };
  let evidencePack = null;

  console.log("\nTopic attempt");
  console.log("-------------");
  console.log(`Topic: ${queueItem.topic}`);
  console.log(`Category: ${queueItem.category}`);
  console.log(`Research mode: ${research.mode}`);

  ensureBudgetAvailable(config, costLedger);

  if (research.enabled) {
    console.log(`Allowed domains: ${research.allowed_domains.join(", ")}`);
    console.log(`Evidence research max turns: ${EVIDENCE_RESEARCH_MAX_TURNS}`);
    console.log("Building official Evidence Pack...");

    const evidenceResearch = await researchEvidence({
      apiKey, model, config, queueItem, research
    });
    let candidateEvidence = normalizeEvidencePack(
      evidenceResearch.generated,
      research,
      evidenceResearch.sources
    );
    candidateEvidence.server_side_tools_used = evidenceResearch.serverSideToolsUsed;

    let costEntry = recordCost({
      ledger: costLedger,
      response: evidenceResearch.response,
      model,
      topic: queueItem.topic,
      articleSlug: safeFilename(queueItem.topic),
      date,
      research: {
        ...research,
        sources: candidateEvidence.sources,
        server_side_tools_used: evidenceResearch.serverSideToolsUsed
      },
      stage: "evidence_research"
    });
    costEntries.push(costEntry);
    writeJson(PATHS.costs, costLedger);

    if (!canContinueTopicBudget(config, costEntries)) {
      markTopicRejected({
        manifest,
        bank: topicBank,
        queueItem,
        date,
        reasons: [`Evidence research cost reached $${topicSpend(costEntries).toFixed(4)} before evidence audit.`]
      });
      return { success: false, reason: "budget_after_evidence_research" };
    }

    console.log("Auditing Evidence Pack independently...");
    const evidenceAudit = await auditEvidence({
      apiKey, model, config, queueItem, research, evidencePack: candidateEvidence
    });
    evidencePack = normalizeEvidencePack(
      evidenceAudit.generated,
      research,
      evidenceAudit.sources
    );
    evidencePack.server_side_tools_used = evidenceAudit.serverSideToolsUsed;

    costEntry = recordCost({
      ledger: costLedger,
      response: evidenceAudit.response,
      model,
      topic: queueItem.topic,
      articleSlug: safeFilename(queueItem.topic),
      date,
      research: {
        ...research,
        sources: evidencePack.sources,
        server_side_tools_used: evidenceAudit.serverSideToolsUsed
      },
      stage: "evidence_audit"
    });
    costEntries.push(costEntry);
    writeJson(PATHS.costs, costLedger);

    research.sources = evidencePack.sources;
    research.server_side_tools_used =
      Number(evidenceResearch.serverSideToolsUsed || 0) + Number(evidenceAudit.serverSideToolsUsed || 0);

    console.log(`Audited evidence facts: ${evidencePack.facts.length}`);
    console.log(`Audited evidence sources: ${evidencePack.sources.length}`);
    console.log(`Unresolved evidence conflicts: ${evidencePack.conflicts.filter((item) => !item.resolved).length}`);

    if (!evidencePackPasses(evidencePack, research)) {
      const reasons = [
        "Official Evidence Pack did not pass the automated sufficiency/audit gate.",
        ...evidencePack.warnings,
        ...evidencePack.conflicts.filter((item) => !item.resolved).map((item) => item.details || item.claim)
      ].filter(Boolean);
      markTopicRejected({ manifest, bank: topicBank, queueItem, date, reasons });
      console.warn("Topic skipped because trustworthy audited evidence was insufficient.");
      return { success: false, reason: "evidence_failed", evidencePack };
    }
  } else {
    console.log("APXN knowledge mode: using the reviewed internal project knowledge base.");
  }

  if (!canContinueTopicBudget(config, costEntries)) {
    markTopicRejected({
      manifest,
      bank: topicBank,
      queueItem,
      date,
      reasons: [`Topic cost reached $${topicSpend(costEntries).toFixed(4)} before article generation.`]
    });
    return { success: false, reason: "budget_before_generation" };
  }

  console.log("Generating article from frozen evidence...");
  const generation = await generateArticle({
    apiKey, model, config, knowledge, manifest, queueItem, research, evidencePack
  });

  let article = normalizeGeneratedArticle(generation.generated, queueItem, config);
  let costEntry = recordCost({
    ledger: costLedger,
    response: generation.response,
    model,
    topic: queueItem.topic,
    articleSlug: article.slug,
    date,
    research: {
      ...research,
      enabled: false,
      mode: research.enabled ? "generation_from_audited_evidence" : research.mode,
      sources: [],
      server_side_tools_used: 0
    },
    stage: "generation"
  });
  costEntries.push(costEntry);
  writeJson(PATHS.costs, costLedger);

  let quality = runQualityChecks(article, config, manifest, research, evidencePack);

  if (!canContinueTopicBudget(config, costEntries)) {
    markTopicRejected({
      manifest,
      bank: topicBank,
      queueItem,
      date,
      reasons: [`Topic cost reached $${topicSpend(costEntries).toFixed(4)} before article verification.`]
    });
    return { success: false, reason: "budget_after_generation" };
  }

  console.log("Verifying article against the frozen Evidence Pack...");
  const verificationResult = await verifyArticle({
    apiKey, model, config, article, queueItem, knowledge, research, evidencePack
  });
  let verification = normalizeVerificationReport(verificationResult.generated, research);
  verification.server_side_tools_used = 0;

  costEntry = recordCost({
    ledger: costLedger,
    response: verificationResult.response,
    model,
    topic: queueItem.topic,
    articleSlug: article.slug,
    date,
    research: { ...research, enabled: false, sources: [], server_side_tools_used: 0 },
    stage: "verification_0"
  });
  costEntries.push(costEntry);
  writeJson(PATHS.costs, costLedger);

  let verified = verificationPasses(verification, research, evidencePack) &&
    quality.errors.length === 0 &&
    article.requires_manual_review !== true;

  for (let round = 1; !verified && round <= MAX_CORRECTION_ROUNDS; round += 1) {
    if (!canContinueTopicBudget(config, costEntries)) {
      console.warn(`Stopping corrections because topic spend is $${topicSpend(costEntries).toFixed(4)}.`);
      break;
    }

    console.log(`Auto-correction round ${round} from frozen evidence...`);
    const correction = await correctArticle({
      apiKey,
      model,
      config,
      article,
      verification,
      quality,
      queueItem,
      knowledge,
      research,
      evidencePack
    });

    article = normalizeGeneratedArticle(correction.generated, queueItem, config);
    costEntry = recordCost({
      ledger: costLedger,
      response: correction.response,
      model,
      topic: queueItem.topic,
      articleSlug: article.slug,
      date,
      research: { ...research, enabled: false, sources: [], server_side_tools_used: 0 },
      stage: `correction_${round}`
    });
    costEntries.push(costEntry);
    writeJson(PATHS.costs, costLedger);

    quality = runQualityChecks(article, config, manifest, research, evidencePack);

    if (!canContinueTopicBudget(config, costEntries)) break;

    console.log(`Re-verification round ${round} against the same Evidence Pack...`);
    const recheck = await verifyArticle({
      apiKey, model, config, article, queueItem, knowledge, research, evidencePack
    });
    verification = normalizeVerificationReport(recheck.generated, research);
    verification.server_side_tools_used = 0;

    costEntry = recordCost({
      ledger: costLedger,
      response: recheck.response,
      model,
      topic: queueItem.topic,
      articleSlug: article.slug,
      date,
      research: { ...research, enabled: false, sources: [], server_side_tools_used: 0 },
      stage: `verification_${round}`
    });
    costEntries.push(costEntry);
    writeJson(PATHS.costs, costLedger);

    verified = verificationPasses(verification, research, evidencePack) &&
      quality.errors.length === 0 &&
      article.requires_manual_review !== true;
  }

  const topicCostUsd = topicSpend(costEntries);
  const maxPerArticle = Number(config?.cost_control?.maximum_cost_per_article_usd || 0);
  if (maxPerArticle > 0 && topicCostUsd > maxPerArticle) {
    verified = false;
    article.requires_manual_review = true;
    article.review_reasons = uniqueStrings([
      ...article.review_reasons,
      `Automated pipeline cost $${topicCostUsd.toFixed(4)} exceeded the configured per-article maximum of $${maxPerArticle.toFixed(2)}.`
    ], 30);
  }

  console.log(`Words: ${quality.words}`);
  console.log(`Verification: ${verification.verdict} / ${verification.confidence}`);
  console.log(`Verified claims: ${verification.checked_claims.filter((item) => item.status === "verified").length}`);
  console.log(`Verification issues: ${verification.issues.length}`);
  console.log(`Accepted sources: ${research.sources.length}`);
  if (evidencePack) console.log(`Frozen evidence facts: ${evidencePack.facts.length}`);
  console.log(`Topic pipeline cost: $${topicCostUsd.toFixed(6)}`);

  if (!verified) {
    const reasons = [
      ...quality.errors,
      ...article.review_reasons,
      ...verification.issues.map((issue) => `${issue.severity}: ${issue.problem}`),
      verification.summary
    ].filter(Boolean);

    const paths = diagnosticDraftPaths(article);
    const relatedArticles = chooseRelatedArticles(manifest, article, 3);
    const html = renderArticleHtml({
      article,
      config,
      date,
      words: quality.words,
      reading: quality.reading_minutes,
      relatedArticles,
      research
    }).replace(
      '<meta name="robots" content="index, follow">',
      '<meta name="robots" content="noindex, nofollow">'
    );

    writeJson(paths.json, {
      generated_at: date,
      status: "rejected_verification",
      topic: queueItem.topic,
      model,
      pipeline_cost_usd: topicCostUsd,
      quality,
      evidence_pack: evidencePack,
      verification,
      research,
      article
    });
    writeText(paths.html, html);

    markTopicRejected({ manifest, bank: topicBank, queueItem, date, reasons });
    console.warn("Topic rejected after automated evidence/verification pipeline. Moving to the next topic when allowed.");
    return { success: false, reason: "verification_failed", article, verification, evidencePack };
  }

  article.requires_manual_review = false;
  article.review_reasons = [];

  const published = publishRequested;
  const relatedArticles = chooseRelatedArticles(manifest, article, 3);
  const publicHtmlPath = path.join(PATHS.published, `${article.slug}.html`);
  const publicStructuredPath = path.join(PATHS.generated, `${article.slug}.json`);
  const privateStructuredPath = path.join(PATHS.privateDrafts, `${article.slug}.json`);
  const privateHtmlPath = path.join(PATHS.privateDrafts, `${article.slug}.html`);
  const structuredPath = published ? publicStructuredPath : privateStructuredPath;

  const generatedRecord = {
    generated_at: date,
    language: "en",
    topic: queueItem.topic,
    category: article.category,
    model,
    provider: "xai",
    pipeline_cost_usd: topicCostUsd,
    cost_entries: costEntries,
    evidence_pack: evidencePack,
    research: {
      mode: research.mode,
      required: research.enabled,
      allowed_domains: research.allowed_domains,
      server_side_tools_used: research.server_side_tools_used,
      source_count: research.sources.length,
      sources: research.sources
    },
    verification,
    status: published ? "published" : "draft",
    requires_manual_review: false,
    quality: {
      word_count: quality.words,
      reading_minutes: quality.reading_minutes,
      warnings: quality.warnings
    },
    article
  };

  const html = renderArticleHtml({
    article,
    config,
    date,
    words: quality.words,
    reading: quality.reading_minutes,
    relatedArticles,
    research
  });

  if (published) {
    writeText(publicHtmlPath, html);
    writeJson(publicStructuredPath, generatedRecord);
  } else {
    const previewHtml = html.replace(
      '<meta name="robots" content="index, follow">',
      '<meta name="robots" content="noindex, nofollow">'
    );
    writeJson(privateStructuredPath, generatedRecord);
    writeText(privateHtmlPath, previewHtml);
  }

  const manifestRecord = addManifestRecord({
    manifest,
    article,
    config,
    quality,
    date,
    published,
    model,
    queueItem,
    structuredPath,
    research,
    verification
  });

  const topicBankChanged = updateTopicBank({
    bank: topicBank,
    queueItem,
    published,
    articleId: manifestRecord.id,
    slug: article.slug,
    date
  });

  if (topicBankChanged) writeJson(PATHS.topicBank, topicBank);

  console.log(`Article ${manifestRecord.id} passed automated verification.`);
  console.log(`Status: ${manifestRecord.status}`);
  return { success: true, published, manifestRecord, article, verification, evidencePack };
}

async function main() {
  const config = readJson(PATHS.config);
  const knowledge = readJson(PATHS.knowledge);
  const manifest = readJson(PATHS.articles);
  const topicBank = readJsonIfExists(PATHS.topicBank);

  validateConfig(config);
  validateManifest(manifest);

  const apiKeyVariable = String(config?.security?.xai_key_variable || "XAI_API_KEY").trim() || "XAI_API_KEY";
  const apiKey = String(process.env[apiKeyVariable] || "").trim();
  if (!apiKey) fail(`${apiKeyVariable} is missing. Add it as a GitHub Actions secret.`);

  const modelVariable = String(config?.security?.xai_model_variable || "XAI_MODEL").trim() || "XAI_MODEL";
  const model = String(process.env[modelVariable] || config?.ai?.default_model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const costLedger = readCostLedger();
  const publishRequested =
    config?.automation?.auto_generate_enabled === true &&
    config?.automation?.auto_publish_enabled === true &&
    isTruthyEnv("BLOG_PUBLISH");

  const maxTopicAttempts = publishRequested
    ? MAX_PRODUCTION_TOPIC_ATTEMPTS
    : MAX_TEST_TOPIC_ATTEMPTS;

  console.log("APXN Blog AI Writer + Audited Evidence Pipeline");
  console.log("-----------------------------------");
  console.log("Language: English only");
  console.log(`Model: ${model}`);
  console.log(`Publish requested: ${publishRequested}`);
  console.log(`Maximum topic attempts this run: ${maxTopicAttempts}`);
  console.log(`Maximum correction rounds per topic: ${MAX_CORRECTION_ROUNDS}`);

  let produced = null;
  for (let attempt = 1; attempt <= maxTopicAttempts; attempt += 1) {
    ensureBudgetAvailable(config, costLedger);

    let selection;
    try {
      selection = chooseNextTopic(manifest);
    } catch (error) {
      console.warn(`No eligible topic remains: ${error.message}`);
      break;
    }

    if (selection.skipped > 0) {
      console.log(`Skipped ${selection.skipped} invalid/duplicate queued topic(s).`);
    }

    console.log(`\n=== Topic ${attempt}/${maxTopicAttempts} ===`);
    const result = await processTopic({
      config,
      knowledge,
      manifest,
      topicBank,
      queueItem: selection.queueItem,
      apiKey,
      model,
      costLedger,
      publishRequested
    });

    writeJson(PATHS.articles, manifest);
    if (topicBank) writeJson(PATHS.topicBank, topicBank);
    writeJson(PATHS.costs, costLedger);

    if (result.success) {
      produced = result;
      break;
    }

    if (!publishRequested) break;
  }

  console.log(`\nMonthly tracked spend: $${monthlySpend(costLedger).toFixed(6)}`);

  if (!produced) {
    console.log("No article passed the automated verification pipeline in this run.");
    console.log("Failed topics were skipped safely so a future run can continue with the next queued topic.");
    return;
  }

  if (produced.published) {
    console.log("Verified article published to blog/articles and ready for blog-sync.");
  } else {
    console.log("Verified article saved as a private workflow draft because publishing is currently disabled/test mode.");
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});

