/**
 * APXN Blog Writer — Research-Packet-Only Paid Writer
 * Path: scripts/blog-writer.mjs
 *
 * Architecture:
 *   Official/APXN sources
 *      -> scripts/blog-researcher.mjs (free deterministic research)
 *      -> immutable Research Packet
 *      -> one paid Grok writing call
 *      -> free deterministic local quality/grounding gate
 *      -> private draft or publication
 *
 * Important:
 * - This file does NOT fetch official sources itself.
 * - Grok receives facts only from the Research Packet.
 * - No open-web/model-memory research is allowed.
 * - No paid verifier/repair loop is used.
 * - A failed local gate is preserved as an artifact for inspection.
 * - Source-test mode uses the same free researcher and makes zero xAI calls.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildResearchPacketForTopic } from "./blog-researcher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  config: path.join(ROOT, "data", "blog-config.json"),
  articles: path.join(ROOT, "data", "blog-articles.json"),
  topicBank: path.join(ROOT, "data", "blog-topic-bank.json"),
  costs: path.join(ROOT, "data", "blog-costs.json"),
  published: path.join(ROOT, "blog", "articles"),
  privateDrafts: path.join(ROOT, ".workflow-output", "drafts")
};

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_ENDPOINT = "/responses";
const DEFAULT_MODEL = "grok-4.3";
const COST_TICKS_PER_USD = 10_000_000_000;
const API_TIMEOUT_MS = 180_000;
const GENERATION_OUTPUT_TOKENS = 6_500;
const DEFAULT_GENERATION_COST_RESERVE_USD = 0.05;
const COST_PREFLIGHT_EPSILON_USD = 0.000000001;
const MAX_PRE_AI_TOPIC_ATTEMPTS = 6;

const CONTENT_MODES = new Set(["apxn", "external", "hybrid", "manual"]);

const SOURCE_PROFILE_ALIASES = {
  security: "wallet_security",
  ethereum: "blockchain_transactions",
  blockchain: "blockchain_transactions",
  web3: "telegram_web3"
};

/*
 * Compatibility for the old queue that existed before topic-bank schema v2.
 * These records are deterministic; the writer never guesses content mode from
 * a title. The first composite BSC topic stays retired because the new bank
 * already contains separate BSC / BEP-20 / gas topics.
 */
const LEGACY_TOPIC_OVERRIDES = {
  "what is bsc understanding bep 20 tokens and gas fees": {
    retired: true,
    retired_reason:
      "Legacy composite topic retired. BNB Smart Chain, BEP-20 and gas fees now have separate schema-v2 topics."
  },
  "how telegram mini apps are bringing web3 to everyday users": {
    content_mode: "external",
    source_profile: "telegram_web3",
    knowledge_sections: [],
    auto_publish_allowed: true
  },
  "web3 security basics protecting your wallet and telegram account": {
    content_mode: "external",
    source_profile: "web3_security",
    knowledge_sections: [],
    auto_publish_allowed: true
  },
  "blockchain explained for beginners from blocks to web3": {
    content_mode: "external",
    source_profile: "blockchain_transactions",
    knowledge_sections: [],
    auto_publish_allowed: true
  },
  "how apxn referrals and active friend mining boosts work": {
    content_mode: "apxn",
    source_profile: null,
    knowledge_sections: ["implemented_product_facts.referrals"],
    auto_publish_allowed: true,
    editorial_guard:
      "Describe the in-app APXN Points referral speed calculation only. Do not present it as blockchain mining yield or financial return."
  },
  "understanding the apxn daily check in reward system": {
    content_mode: "apxn",
    source_profile: null,
    knowledge_sections: ["implemented_product_facts.daily_checkin"],
    auto_publish_allowed: true
  },
  "apxn development roadmap live features vs planned milestones": {
    content_mode: "apxn",
    source_profile: null,
    knowledge_sections: [
      "implemented_product_facts",
      "features_not_to_describe_as_live",
      "roadmap"
    ],
    auto_publish_allowed: true,
    editorial_guard:
      "Keep implemented, UI-only and planned features distinct. Never present roadmap dates or incomplete phases as guaranteed."
  },
  "how telegram mini app authentication works and why initdata verification matters": {
    content_mode: "external",
    source_profile: "telegram_auth",
    knowledge_sections: [],
    auto_publish_allowed: true
  }
};

const ARTICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "description",
    "keywords",
    "intro",
    "sections",
    "faq",
    "conclusion"
  ],
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    keywords: {
      type: "array",
      minItems: 5,
      maxItems: 10,
      items: { type: "string" }
    },
    intro: {
      type: "object",
      additionalProperties: false,
      required: ["text", "evidence_ids"],
      properties: {
        text: { type: "string" },
        evidence_ids: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: { type: "string" }
        }
      }
    },
    sections: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "paragraphs"],
        properties: {
          heading: { type: "string" },
          paragraphs: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "evidence_ids"],
              properties: {
                text: { type: "string" },
                evidence_ids: {
                  type: "array",
                  minItems: 1,
                  maxItems: 6,
                  items: { type: "string" }
                }
              }
            }
          }
        }
      }
    },
    faq: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer", "evidence_ids"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
          evidence_ids: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" }
          }
        }
      }
    },
    conclusion: {
      type: "object",
      additionalProperties: false,
      required: ["text", "evidence_ids"],
      properties: {
        text: { type: "string" },
        evidence_ids: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: { type: "string" }
        }
      }
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Basic utilities                                                            */
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
  return fs.existsSync(filePath) ? readJson(filePath) : null;
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

function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTopic(value) {
  return normalizeSpace(value)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function uniqueStrings(values, max = 100) {
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

function wordCount(value) {
  const text = normalizeSpace(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function containsArabicScript(value) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(value || ""));
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] || "").trim().toLowerCase()
  );
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function monthKey(date = todayISO()) {
  return String(date).slice(0, 7);
}

function readingMinutes(words) {
  return Math.max(1, Math.ceil(Number(words || 0) / 220));
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

function nextArticleId(articles) {
  let max = 0;

  for (const article of Array.isArray(articles) ? articles : []) {
    const match = String(article?.id || "").match(/^apxn-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }

  return `apxn-${String(max + 1).padStart(3, "0")}`;
}

function numericTokens(value) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/\b(?:bep|erc|eip)[ -]?\d+\b/gi, " ");

  const matches =
    text.match(
      /(?:[$€£]\s*)?\b\d+(?:[.,]\d+)?(?:\s*%|\s*(?:gwei|wei|bnb|eth|usdt|seconds?|minutes?|hours?|days?|weeks?|months?|years?|blocks?|validators?|transactions?|points?))?/gi
    ) || [];

  return uniqueStrings(
    matches.map((item) => normalizeSpace(item).toLowerCase().replace(/,/g, "")),
    100
  );
}

function normalizedWordSet(text) {
  return new Set(
    normalizeTopic(text)
      .split(" ")
      .filter((word) => word.length >= 4)
  );
}

function jaccardSimilarity(left, right) {
  const a = normalizedWordSet(left);
  const b = normalizedWordSet(right);
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/* -------------------------------------------------------------------------- */
/* Configuration / routing validation                                         */
/* -------------------------------------------------------------------------- */

function validateConfig(config) {
  if (config?.writer?.enabled !== true) {
    fail("Blog writer is disabled in data/blog-config.json.");
  }

  if (String(config?.site?.default_language || "en").toLowerCase() !== "en") {
    fail("APXN Blog Writer is English-only.");
  }

  if (config?.ai?.provider !== "xai") {
    fail('data/blog-config.json must keep ai.provider="xai".');
  }

  if (config?.writer?.allow_external_research !== false) {
    fail("writer.allow_external_research must remain false.");
  }

  const minWords = Number(config?.writer?.minimum_words || 0);
  const targetWords = Number(config?.writer?.target_words || 0);
  const maxWords = Number(config?.writer?.maximum_words || 0);

  if (!(minWords >= 1200 && targetWords >= minWords && maxWords >= targetWords)) {
    fail("Writer word-count settings are invalid.");
  }

  if (!Array.isArray(config?.categories) || config.categories.length === 0) {
    fail("blog-config.json must contain categories.");
  }
}

function validateTopicBank(bank, config) {
  if (Number(bank?.schema_version || 0) < 2) {
    fail("data/blog-topic-bank.json must use schema_version 2 or newer.");
  }

  if (!Array.isArray(bank?.topics)) {
    fail("data/blog-topic-bank.json must contain topics.");
  }

  if (bank?.rules?.open_web_research_allowed !== false) {
    fail("Topic bank must keep open_web_research_allowed=false.");
  }

  if (bank?.rules?.approved_official_sources_only !== true) {
    fail("Topic bank must keep approved_official_sources_only=true.");
  }

  const categories = new Set(config.categories);

  for (const item of bank.topics) {
    const mode = String(item?.content_mode || "").toLowerCase();

    if (!item?.id || !item?.topic || !item?.category) {
      fail("A topic-bank entry is missing id, topic or category.");
    }

    if (!categories.has(item.category)) {
      fail(`Topic ${item.id} uses unknown category "${item.category}".`);
    }

    if (!CONTENT_MODES.has(mode)) {
      fail(`Topic ${item.id} has invalid content_mode.`);
    }

    if (!Array.isArray(item.knowledge_sections)) {
      fail(`Topic ${item.id} must contain knowledge_sections.`);
    }
  }
}

function findTopicBankItem(queueItem, bank) {
  const explicitId = normalizeSpace(queueItem?.topic_bank_id);

  if (explicitId) {
    const byId = bank.topics.find((item) => item.id === explicitId);
    if (byId) return byId;
  }

  const queueTopic = normalizeTopic(queueItem?.topic);

  return (
    bank.topics.find((item) => normalizeTopic(item.topic) === queueTopic) || null
  );
}

function hydrateTopic(queueItem, bank) {
  const bankItem = findTopicBankItem(queueItem, bank);
  const legacy = LEGACY_TOPIC_OVERRIDES[normalizeTopic(queueItem?.topic)] || null;

  if (legacy?.retired === true) {
    return {
      ok: false,
      retired_legacy: true,
      reason: legacy.retired_reason
    };
  }

  const contentMode = String(
    queueItem?.content_mode ||
      bankItem?.content_mode ||
      legacy?.content_mode ||
      ""
  ).toLowerCase();

  const sourceProfile =
    queueItem?.source_profile ??
    bankItem?.source_profile ??
    legacy?.source_profile ??
    null;

  const knowledgeSections = Array.isArray(queueItem?.knowledge_sections)
    ? queueItem.knowledge_sections
    : Array.isArray(bankItem?.knowledge_sections)
      ? bankItem.knowledge_sections
      : Array.isArray(legacy?.knowledge_sections)
        ? legacy.knowledge_sections
        : [];

  const autoPublishAllowed =
    queueItem?.auto_publish_allowed ??
    bankItem?.auto_publish_allowed ??
    legacy?.auto_publish_allowed ??
    false;

  const editorialGuard = normalizeSpace(
    queueItem?.editorial_guard ||
      bankItem?.editorial_guard ||
      legacy?.editorial_guard ||
      ""
  );

  if (!CONTENT_MODES.has(contentMode)) {
    return {
      ok: false,
      reason:
        "Topic has no valid content_mode metadata. Replenish it through the topic planner."
    };
  }

  if (contentMode === "manual") {
    return { ok: false, reason: "Manual-only topic cannot enter automatic generation." };
  }

  if (autoPublishAllowed !== true) {
    return { ok: false, reason: "Topic is not approved for automatic publishing." };
  }

  if (["external", "hybrid"].includes(contentMode) && !normalizeSpace(sourceProfile)) {
    return { ok: false, reason: "External/hybrid topic has no source_profile." };
  }

  if (["apxn", "hybrid"].includes(contentMode) && knowledgeSections.length === 0) {
    return { ok: false, reason: "APXN/hybrid topic has no knowledge_sections." };
  }

  return {
    ok: true,
    id: bankItem?.id || queueItem?.topic_bank_id || null,
    topic_bank_id: bankItem?.id || queueItem?.topic_bank_id || null,
    topic: normalizeSpace(queueItem.topic),
    category: normalizeSpace(queueItem.category || bankItem?.category),
    risk: normalizeSpace(queueItem.risk || bankItem?.risk || "safe").toLowerCase(),
    content_mode: contentMode,
    source_profile: sourceProfile
      ? SOURCE_PROFILE_ALIASES[normalizeSpace(sourceProfile)] || normalizeSpace(sourceProfile)
      : null,
    knowledge_sections: uniqueStrings(knowledgeSections, 30),
    auto_publish_allowed: true,
    editorial_guard: editorialGuard
  };
}

/* -------------------------------------------------------------------------- */
/* Free Research Packet                                                       */
/* -------------------------------------------------------------------------- */

function researchPacketFilename(topic) {
  return `${slugify(topic)}.research-packet.json`;
}

async function researchTopic(metadata) {
  const packet = await buildResearchPacketForTopic(metadata);

  if (!packet || typeof packet !== "object") {
    fail("Free researcher returned an invalid Research Packet.");
  }

  if (Number(packet?.paid_ai_calls || 0) !== 0) {
    fail("Research Packet claims paid AI usage. Free research stage is required.");
  }

  if (packet?.policy?.open_web_research_allowed !== false) {
    fail("Research Packet does not explicitly block open-web research.");
  }

  if (packet?.policy?.model_memory_as_source_allowed !== false) {
    fail("Research Packet does not explicitly block model-memory sourcing.");
  }

  if (packet?.policy?.writer_may_add_facts_outside_packet !== false) {
    fail("Research Packet does not explicitly forbid facts outside the packet.");
  }

  return packet;
}

function saveResearchPacket(packet, slug) {
  fs.mkdirSync(PATHS.privateDrafts, { recursive: true });

  const filePath = path.join(
    PATHS.privateDrafts,
    `${slug}.research-packet.json`
  );

  writeJson(filePath, packet);
  return filePath;
}

function packetSummary(packet) {
  return {
    status: packet.status,
    topic: packet.topic,
    sufficiency: packet.sufficiency,
    source_fetch: packet.source_fetch,
    sources: packet.sources,
    allowed_numeric_tokens: packet.allowed_numeric_tokens,
    forbidden_claims: packet.forbidden_claims,
    writing_plan: packet.writing_plan,
    evidence_count: Array.isArray(packet.evidence) ? packet.evidence.length : 0
  };
}

/* -------------------------------------------------------------------------- */
/* xAI cost ledger + one paid writing call                                    */
/* -------------------------------------------------------------------------- */

function ensureCostLedger(existing) {
  const ledger =
    existing && typeof existing === "object"
      ? existing
      : {
          schema_version: 1,
          provider: "xai",
          currency: "USD",
          months: {}
        };

  if (!ledger.months || typeof ledger.months !== "object") {
    ledger.months = {};
  }

  return ledger;
}

function monthRequests(costs, key) {
  const month = costs?.months?.[key];
  return Array.isArray(month?.requests) ? month.requests : [];
}

function monthSpendUsd(costs, key) {
  return monthRequests(costs, key).reduce(
    (sum, row) =>
      sum + (Number.isFinite(Number(row?.cost_usd)) ? Number(row.cost_usd) : 0),
    0
  );
}

function responseCost(responseJson) {
  const ticks = Number(responseJson?.usage?.cost_in_usd_ticks);

  if (!Number.isFinite(ticks) || ticks < 0) {
    return { ticks: null, usd: null };
  }

  return { ticks, usd: ticks / COST_TICKS_PER_USD };
}

function usageValue(responseJson, key) {
  const value = Number(responseJson?.usage?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function cachedInputTokens(responseJson) {
  const candidates = [
    responseJson?.usage?.input_tokens_details?.cached_tokens,
    responseJson?.usage?.input_tokens_details?.cached_input_tokens,
    responseJson?.usage?.cached_input_tokens
  ];

  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }

  return 0;
}

function appendCostRecord({
  costs,
  responseJson,
  stage,
  topic,
  slug,
  model
}) {
  const date = todayISO();
  const key = monthKey(date);

  if (!costs.months[key]) {
    costs.months[key] = { requests: [] };
  }

  if (!Array.isArray(costs.months[key].requests)) {
    costs.months[key].requests = [];
  }

  const cost = responseCost(responseJson);

  const record = {
    date,
    response_id: responseJson?.id || null,
    model,
    topic,
    article_slug: slug,
    stage,
    input_tokens: usageValue(responseJson, "input_tokens"),
    cached_input_tokens: cachedInputTokens(responseJson),
    output_tokens: usageValue(responseJson, "output_tokens"),
    reasoning_tokens:
      Number(responseJson?.usage?.output_tokens_details?.reasoning_tokens || 0) || 0,
    total_tokens: usageValue(responseJson, "total_tokens"),
    server_side_tools_used: 0,
    web_research_enabled: false,
    web_source_count: 0,
    cost_in_usd_ticks: cost.ticks,
    cost_usd: cost.usd
  };

  costs.months[key].requests.push(record);
  costs.months[key].total_cost_usd = Number(
    monthSpendUsd(costs, key).toFixed(12)
  );
  costs.last_updated = date;
  writeJson(PATHS.costs, costs);

  return record;
}

function assertCostKnown(config, record) {
  if (
    config?.cost_control?.track_exact_api_cost === true &&
    !Number.isFinite(Number(record?.cost_usd))
  ) {
    fail(
      "xAI did not return exact usage.cost_in_usd_ticks; the article cannot proceed."
    );
  }
}

function generationReserve(config) {
  const configured = Number(config?.cost_control?.generation_cost_reserve_usd);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GENERATION_COST_RESERVE_USD;
}

function assertGenerationCostPreflight(config, costs) {
  if (config?.cost_control?.enabled !== true) return;

  const reserve = generationReserve(config);
  const monthlyBudget = Number(config?.cost_control?.monthly_budget_usd || 0);
  const monthlySpent = monthSpendUsd(costs, monthKey());
  const monthlyRemaining =
    monthlyBudget > 0 ? Math.max(0, monthlyBudget - monthlySpent) : Infinity;

  if (
    config?.cost_control?.stop_when_monthly_budget_reached === true &&
    monthlyBudget > 0 &&
    monthlyRemaining + COST_PREFLIGHT_EPSILON_USD < reserve
  ) {
    fail(
      `Cost preflight blocked generation: monthly budget has $${monthlyRemaining.toFixed(
        6
      )} remaining, below the $${reserve.toFixed(3)} generation reserve.`
    );
  }

  const articleLimit = Number(
    config?.cost_control?.maximum_cost_per_article_usd || 0
  );

  if (
    articleLimit > 0 &&
    articleLimit + COST_PREFLIGHT_EPSILON_USD < reserve
  ) {
    fail(
      `Cost preflight blocked generation: per-article limit $${articleLimit.toFixed(
        3
      )} is below the $${reserve.toFixed(3)} generation reserve.`
    );
  }

  console.log(
    `COST PREFLIGHT PASS: one paid writing call; reserve $${reserve.toFixed(
      3
    )}; monthly remaining $${
      Number.isFinite(monthlyRemaining)
        ? monthlyRemaining.toFixed(6)
        : "unlimited"
    }.`
  );
}

function assertRunCost(config, runCostUsd) {
  if (config?.cost_control?.enabled !== true) return;

  const max = Number(config?.cost_control?.maximum_cost_per_article_usd || 0);

  if (max > 0 && runCostUsd > max) {
    fail(
      `Paid writing call cost $${runCostUsd.toFixed(
        6
      )} exceeds the per-article limit $${max.toFixed(2)}.`
    );
  }
}

function extractResponseText(responseJson) {
  if (
    typeof responseJson?.output_text === "string" &&
    responseJson.output_text.trim()
  ) {
    return responseJson.output_text.trim();
  }

  const pieces = [];

  for (const output of Array.isArray(responseJson?.output)
    ? responseJson.output
    : []) {
    for (const item of Array.isArray(output?.content) ? output.content : []) {
      if (typeof item?.text === "string" && item.text.trim()) {
        pieces.push(item.text.trim());
      }
    }
  }

  return pieces.join("\n").trim();
}

async function callPaidWriter({
  config,
  apiKey,
  input
}) {
  if (!apiKey) {
    fail("XAI_API_KEY is missing.");
  }

  const baseUrl = String(
    config?.ai?.api_base_url || DEFAULT_XAI_BASE_URL
  ).replace(/\/+$/, "");

  const endpoint = String(
    config?.ai?.responses_endpoint || DEFAULT_XAI_ENDPOINT
  );

  const model = String(
    process.env.XAI_MODEL ||
      config?.ai?.default_model ||
      DEFAULT_MODEL
  ).trim();

  const body = {
    model,
    instructions: paidWriterInstructions(),
    input,
    max_output_tokens: GENERATION_OUTPUT_TOKENS,
    store: false,
    truncation: "disabled",
    text: {
      format: {
        type: "json_schema",
        name: "apxn_research_packet_article",
        schema: ARTICLE_SCHEMA,
        strict: true
      }
    }
  };

  const effort = String(config?.ai?.reasoning_effort || "none").trim();
  if (effort) body.reasoning = { effort };

  if (
    config?.cost_control?.use_prompt_caching === true &&
    config?.ai?.prompt_cache_key
  ) {
    body.prompt_cache_key = `${String(
      config.ai.prompt_cache_key
    )}-research-packet-v2`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const raw = await response.text();

    let responseJson;
    try {
      responseJson = JSON.parse(raw);
    } catch {
      fail(`xAI returned non-JSON response: ${raw.slice(0, 500)}`);
    }

    if (!response.ok) {
      fail(
        `xAI HTTP ${response.status}: ${JSON.stringify(responseJson).slice(
          0,
          900
        )}`
      );
    }

    const outputText = extractResponseText(responseJson);
    if (!outputText) {
      fail("xAI response did not contain output text.");
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      fail(`Structured xAI output was not valid JSON: ${error.message}`);
    }

    return {
      responseJson,
      rawText: outputText,
      parsed,
      model
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Paid writer prompt — Research Packet is the sole factual authority         */
/* -------------------------------------------------------------------------- */

function packetEvidenceForPrompt(packet) {
  return (packet.evidence || [])
    .map((item) => {
      const source =
        item.kind === "external"
          ? `${item.source_title} | ${item.source_url}`
          : `${item.source_title}${
              item.source_path ? ` | ${item.source_path}` : ""
            }`;

      return [
        `[${item.id}]`,
        `TYPE: ${item.kind}`,
        `SOURCE: ${source}`,
        `WORDS: ${item.word_count || wordCount(item.text)}`,
        "APPROVED PASSAGE:",
        item.text
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function writingPlanForPrompt(packet) {
  const plan = packet.writing_plan;
  if (!plan) fail("READY Research Packet has no writing_plan.");

  const lines = [
    `ARTICLE: minimum ${plan.article_word_requirement.minimum}; target ${plan.article_word_requirement.target}; maximum ${plan.article_word_requirement.maximum} words.`,
    "",
    `INTRO: ${plan.intro.min_words}-${plan.intro.max_words} words; target ${plan.intro.target_words}; evidence_ids=${plan.intro.evidence_ids.join(
      ","
    )}`,
    `INTRO INSTRUCTION: ${plan.intro.instruction}`
  ];

  for (const section of plan.sections || []) {
    lines.push("");
    lines.push(
      `SECTION ${section.section_index}: ${section.min_words}-${section.max_words} words TOTAL across exactly 2 paragraphs; target ${section.target_words}.`
    );
    lines.push(`SECTION ${section.section_index} EVIDENCE: ${section.evidence_ids.join(",")}`);
    if (section.focus_terms?.length) {
      lines.push(
        `SECTION ${section.section_index} FOCUS TERMS: ${section.focus_terms.join(
          ", "
        )}`
      );
    }
    lines.push(
      `SECTION ${section.section_index} INSTRUCTION: ${section.instruction}`
    );
  }

  for (const faq of plan.faq || []) {
    lines.push("");
    lines.push(
      `FAQ ${faq.faq_index}: answer ${faq.min_words}-${faq.max_words} words; target ${faq.target_words}; evidence_ids=${faq.evidence_ids.join(
        ","
      )}`
    );
    lines.push(`FAQ ${faq.faq_index} INSTRUCTION: ${faq.instruction}`);
  }

  lines.push("");
  lines.push(
    `CONCLUSION: ${plan.conclusion.min_words}-${plan.conclusion.max_words} words; target ${plan.conclusion.target_words}; evidence_ids=${plan.conclusion.evidence_ids.join(
      ","
    )}`
  );
  lines.push(`CONCLUSION INSTRUCTION: ${plan.conclusion.instruction}`);

  return lines.join("\n");
}

function paidWriterInstructions() {
  return [
    "You are the Apex Network Editorial writer.",
    "A deterministic research system has already read, ranked and approved the sources.",
    "Your only job is to turn the supplied Research Packet into a clear, original English article.",
    "The Research Packet is your ONLY factual authority.",
    "Do not browse. Do not use model memory. Do not add facts from general knowledge.",
    "Do not invent examples, integrations, benefits, risks, causal links or future possibilities that are not explicitly supported by the assigned evidence.",
    "Follow the writing plan and word ranges. The body must be at least 1200 useful words, preferably near the packet target, without repetition or filler.",
    "Exactly 6 sections are required. Each section must contain exactly 2 paragraphs.",
    "Exactly 3 FAQ items are required.",
    "Each intro, paragraph, FAQ answer and conclusion must cite only evidence IDs allowed for that block by the writing plan.",
    "When a section has multiple evidence IDs, you may synthesize them only when their passages explicitly support the relationship you state. Otherwise present the facts separately.",
    "Never say one product removes the need for another unless the assigned evidence says that.",
    "Never infer wallet custody, private-key behavior, transaction signing, on-chain settlement, blockchain integration or cryptographic processing unless the assigned evidence says that.",
    "Do not turn planned/UI-only APXN material into a live feature.",
    "Do not promise profit, token value, listings, partnerships, yield or financial outcomes.",
    "Use a neutral educational tone suitable for a high-quality public blog.",
    "Avoid keyword stuffing, hype, generic motivational filler and repeated explanations.",
    "Return only the requested JSON schema."
  ].join("\n");
}

function paidWriterInput(packet, config) {
  return [
    "RESEARCH PACKET STATUS: READY_FOR_PAID_WRITER",
    `TOPIC: ${packet.topic.topic}`,
    `CATEGORY: ${packet.topic.category}`,
    `CONTENT MODE: ${packet.topic.content_mode}`,
    `SOURCE PROFILE: ${packet.topic.source_profile || "APXN knowledge only"}`,
    "",
    "PACKET POLICY:",
    JSON.stringify(packet.policy, null, 2),
    "",
    "FORBIDDEN CLAIMS:",
    ...(packet.forbidden_claims || []).map((item) => `- ${item}`),
    "",
    "WRITING PLAN:",
    writingPlanForPrompt(packet),
    "",
    "APPROVED SOURCES:",
    JSON.stringify(packet.sources || [], null, 2),
    "",
    "APPROVED NUMERIC TOKENS:",
    (packet.allowed_numeric_tokens || []).join(", ") || "(none)",
    "",
    "APPROVED EVIDENCE:",
    packetEvidenceForPrompt(packet),
    "",
    `FINAL BODY WORD REQUIREMENT FROM CONFIG: minimum ${config.writer.minimum_words}; target ${config.writer.target_words}; maximum ${config.writer.maximum_words}.`,
    "Do not count the title, meta description, keywords, headings or questions toward the body minimum."
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Free deterministic local validation                                        */
/* -------------------------------------------------------------------------- */

function articleBodyText(article) {
  return [
    article?.intro?.text,
    ...(article?.sections || []).flatMap((section) =>
      (section?.paragraphs || []).map((paragraph) => paragraph?.text)
    ),
    ...(article?.faq || []).map((item) => item?.answer),
    article?.conclusion?.text
  ]
    .filter(Boolean)
    .join("\n");
}

function allArticleBlocks(article) {
  const blocks = [];

  if (article?.intro?.text) {
    blocks.push({
      label: "intro",
      text: article.intro.text,
      evidence_ids: article.intro.evidence_ids
    });
  }

  for (let s = 0; s < (article?.sections || []).length; s++) {
    const section = article.sections[s];

    for (let p = 0; p < (section?.paragraphs || []).length; p++) {
      const paragraph = section.paragraphs[p];

      blocks.push({
        label: `section_${s + 1}_paragraph_${p + 1}`,
        text: paragraph.text,
        evidence_ids: paragraph.evidence_ids
      });
    }
  }

  for (let f = 0; f < (article?.faq || []).length; f++) {
    const item = article.faq[f];

    blocks.push({
      label: `faq_${f + 1}`,
      text: item.answer,
      evidence_ids: item.evidence_ids
    });
  }

  if (article?.conclusion?.text) {
    blocks.push({
      label: "conclusion",
      text: article.conclusion.text,
      evidence_ids: article.conclusion.evidence_ids
    });
  }

  return blocks;
}

function allowedPlanIdsForBlock(packet, label) {
  const plan = packet.writing_plan;

  if (label === "intro") {
    return plan?.intro?.evidence_ids || [];
  }

  if (label === "conclusion") {
    return plan?.conclusion?.evidence_ids || [];
  }

  const sectionMatch = label.match(/^section_(\d+)_paragraph_(\d+)$/);
  if (sectionMatch) {
    const sectionIndex = Number(sectionMatch[1]) - 1;
    return plan?.sections?.[sectionIndex]?.evidence_ids || [];
  }

  const faqMatch = label.match(/^faq_(\d+)$/);
  if (faqMatch) {
    const faqIndex = Number(faqMatch[1]) - 1;
    return plan?.faq?.[faqIndex]?.evidence_ids || [];
  }

  return [];
}

function evidenceIdsWithin(actual, allowed) {
  const actualSet = new Set(uniqueStrings(actual, 20));
  const allowedSet = new Set(uniqueStrings(allowed, 20));

  if (actualSet.size === 0) return false;

  for (const id of actualSet) {
    if (!allowedSet.has(id)) return false;
  }

  return true;
}

function numericTokenSupported(token, evidenceText) {
  const normalized = normalizeSpace(token).toLowerCase().replace(/,/g, "");
  const evidenceNormalized = normalizeSpace(evidenceText)
    .toLowerCase()
    .replace(/,/g, "");

  return evidenceNormalized.includes(normalized);
}

const HIGH_RISK_PATTERNS = [
  {
    name: "future bridge",
    regex: /\b(?:could|can|may|might)\s+(?:later|eventually)\b/i
  },
  {
    name: "future-condition bridge",
    regex: /\bonce\s+(?:users|developers|people|adoption|the ecosystem)\b/i
  },
  {
    name: "removes-the-need claim",
    regex: /\b(?:removes?|eliminates?)\s+the\s+need\b/i
  },
  {
    name: "without-installing/using claim",
    regex: /\bwithout\s+(?:requiring|installing|needing|using)\b/i
  },
  {
    name: "private-key behavior",
    regex: /\bprivate\s+keys?\b/i
  },
  {
    name: "transaction-signing behavior",
    regex: /\btransaction\s+sign(?:ing|ature|atures)\b/i
  },
  {
    name: "on-chain integration",
    regex: /\bon[- ]chain\s+(?:settlement|receipt|transaction|transactions|payment|payments)\b/i
  },
  {
    name: "cryptographic processing",
    regex: /\bcryptographic\s+(?:operation|operations|processing)\b/i
  },
  {
    name: "inheritance claim",
    regex: /\binherit(?:s|ed)?\s+(?:this|that|the)\b/i
  },
  {
    name: "can-help inference",
    regex: /\bcan\s+help\s+(?:verify|enable|reduce|improve|avoid|protect)\b/i
  }
];

function unsupportedHighRiskPatterns(blockText, assignedEvidenceText) {
  const unsupported = [];

  for (const rule of HIGH_RISK_PATTERNS) {
    rule.regex.lastIndex = 0;
    const inBlock = rule.regex.test(String(blockText || ""));
    rule.regex.lastIndex = 0;
    const inEvidence = rule.regex.test(String(assignedEvidenceText || ""));

    if (inBlock && !inEvidence) {
      unsupported.push(rule.name);
    }
  }

  return unsupported;
}

function hasDangerousClaims(text) {
  const patterns = [
    /\bguaranteed\s+(?:profit|return|value|price|listing)\b/i,
    /\brisk[- ]free\b/i,
    /\bwill\s+(?:definitely|certainly)\s+(?:list|rise|increase|profit)\b/i,
    /\bconfirmed\s+(?:binance|coinbase|exchange)\s+listing\b/i,
    /\bguaranteed\s+airdrop\b/i
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function hasVolatileMetricClaims(text) {
  const patterns = [
    /\b(?:tvl|market cap|market capitalization|apy|apr|staking yield)\b/i,
    /\bcurrent\s+gas\s+price\b/i,
    /\btoday'?s?\s+(?:price|fee|gas)\b/i,
    /\bcurrently\s+\d+(?:[.,]\d+)?\s+(?:validators?|tps)\b/i
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function planWordRangeErrors(article, packet) {
  const errors = [];
  const plan = packet.writing_plan;

  if (!plan) return ["Research Packet writing_plan is missing."];

  const introWords = wordCount(article?.intro?.text);
  if (
    introWords < Number(plan.intro.min_words) ||
    introWords > Number(plan.intro.max_words) + 20
  ) {
    errors.push(
      `intro has ${introWords} words; packet range is ${plan.intro.min_words}-${plan.intro.max_words}.`
    );
  }

  for (let index = 0; index < 6; index++) {
    const section = article?.sections?.[index];
    const sectionPlan = plan?.sections?.[index];

    const total = (section?.paragraphs || []).reduce(
      (sum, paragraph) => sum + wordCount(paragraph?.text),
      0
    );

    if (!sectionPlan) {
      errors.push(`writing plan is missing section ${index + 1}.`);
      continue;
    }

    if (
      total < Number(sectionPlan.min_words) ||
      total > Number(sectionPlan.max_words) + 30
    ) {
      errors.push(
        `section ${index + 1} has ${total} paragraph words; packet range is ${sectionPlan.min_words}-${sectionPlan.max_words}.`
      );
    }
  }

  for (let index = 0; index < 3; index++) {
    const faq = article?.faq?.[index];
    const faqPlan = plan?.faq?.[index];
    const total = wordCount(faq?.answer);

    if (!faqPlan) {
      errors.push(`writing plan is missing FAQ ${index + 1}.`);
      continue;
    }

    if (
      total < Number(faqPlan.min_words) ||
      total > Number(faqPlan.max_words) + 20
    ) {
      errors.push(
        `FAQ ${index + 1} answer has ${total} words; packet range is ${faqPlan.min_words}-${faqPlan.max_words}.`
      );
    }
  }

  const conclusionWords = wordCount(article?.conclusion?.text);
  if (
    conclusionWords < Number(plan.conclusion.min_words) ||
    conclusionWords > Number(plan.conclusion.max_words) + 20
  ) {
    errors.push(
      `conclusion has ${conclusionWords} words; packet range is ${plan.conclusion.min_words}-${plan.conclusion.max_words}.`
    );
  }

  return errors;
}

function repeatedBlockErrors(article) {
  const errors = [];
  const blocks = allArticleBlocks(article).filter(
    (block) => wordCount(block.text) >= 45
  );

  for (let left = 0; left < blocks.length; left++) {
    for (let right = left + 1; right < blocks.length; right++) {
      const similarity = jaccardSimilarity(blocks[left].text, blocks[right].text);

      if (similarity >= 0.72) {
        errors.push(
          `${blocks[left].label} and ${blocks[right].label} are too repetitive (${similarity.toFixed(
            2
          )} lexical similarity).`
        );
      }
    }
  }

  return errors.slice(0, 8);
}

function validateArticleAgainstPacket({
  article,
  packet,
  config
}) {
  const errors = [];
  const evidence = Array.isArray(packet.evidence) ? packet.evidence : [];
  const evidenceMap = new Map(evidence.map((item) => [item.id, item]));
  const bodyText = articleBodyText(article);
  const bodyWords = wordCount(bodyText);

  if (packet.status !== "READY_FOR_PAID_WRITER") {
    errors.push(`Research Packet status is ${packet.status}.`);
  }

  if (containsArabicScript(bodyText)) {
    errors.push("Article body contains Arabic-script text; the blog is English-only.");
  }

  if (bodyWords < Number(config.writer.minimum_words)) {
    errors.push(
      `Article body has ${bodyWords} words; minimum is ${config.writer.minimum_words}.`
    );
  }

  if (bodyWords > Number(config.writer.maximum_words)) {
    errors.push(
      `Article body has ${bodyWords} words; maximum is ${config.writer.maximum_words}.`
    );
  }

  if (!normalizeSpace(article?.title) || article.title.length > 120) {
    errors.push("Article title is missing or longer than 120 characters.");
  }

  const descriptionLength = normalizeSpace(article?.description).length;
  if (descriptionLength < 90 || descriptionLength > 180) {
    errors.push(
      `Meta description has ${descriptionLength} characters; required range is 90-180.`
    );
  }

  if (
    !Array.isArray(article?.keywords) ||
    article.keywords.length < 5 ||
    article.keywords.length > 10
  ) {
    errors.push("Article must contain 5-10 useful keywords.");
  }

  if (!Array.isArray(article?.sections) || article.sections.length !== 6) {
    errors.push("Article must contain exactly 6 sections.");
  }

  for (let index = 0; index < (article?.sections || []).length; index++) {
    if ((article.sections[index]?.paragraphs || []).length !== 2) {
      errors.push(`Section ${index + 1} must contain exactly 2 paragraphs.`);
    }
  }

  if (!Array.isArray(article?.faq) || article.faq.length !== 3) {
    errors.push("Article must contain exactly 3 FAQ items.");
  }

  if (hasDangerousClaims(bodyText)) {
    errors.push("Article contains a prohibited guaranteed/promotional claim.");
  }

  if (hasVolatileMetricClaims(bodyText)) {
    errors.push("Article contains a blocked volatile metric claim.");
  }

  if (["apxn", "hybrid"].includes(packet?.topic?.content_mode)) {
    if (/\bcurrent\s+apxn\s+token\s+balance\b/i.test(bodyText)) {
      errors.push("Current in-app balance must be described as APXN Points.");
    }

    if (/\bproof[- ]of[- ]work\s+mining\b/i.test(bodyText)) {
      errors.push(
        "Current APXN Points accumulation must not be called proof-of-work mining."
      );
    }
  }

  errors.push(...planWordRangeErrors(article, packet));

  for (const block of allArticleBlocks(article)) {
    const actualIds = uniqueStrings(block.evidence_ids, 20);
    const allowedIds = allowedPlanIdsForBlock(packet, block.label);

    if (!evidenceIdsWithin(actualIds, allowedIds)) {
      errors.push(
        `${block.label} uses evidence IDs outside its Research Packet writing-plan allowance.`
      );
      continue;
    }

    const unknown = actualIds.filter((id) => !evidenceMap.has(id));
    if (unknown.length > 0) {
      errors.push(
        `${block.label} references unknown evidence IDs: ${unknown.join(", ")}.`
      );
      continue;
    }

    const assignedText = actualIds
      .map((id) => evidenceMap.get(id)?.text || "")
      .join("\n");

    for (const token of numericTokens(block.text)) {
      if (!numericTokenSupported(token, assignedText)) {
        errors.push(
          `${block.label} contains numeric token "${token}" that is not present in its assigned evidence.`
        );
      }
    }

    for (const patternName of unsupportedHighRiskPatterns(
      block.text,
      assignedText
    )) {
      errors.push(
        `${block.label} contains unsupported high-risk inference pattern: ${patternName}.`
      );
    }
  }

  errors.push(...repeatedBlockErrors(article));

  return {
    ok: errors.length === 0,
    errors,
    body_word_count: bodyWords,
    research_packet_status: packet.status,
    research_evidence_count: evidence.length,
    research_evidence_words: Number(packet?.sufficiency?.metrics?.total_words || 0)
  };
}

/* -------------------------------------------------------------------------- */
/* Duplicate protection                                                       */
/* -------------------------------------------------------------------------- */

function assertNotDuplicate(article, manifest) {
  const title = normalizeTopic(article.title);
  const slug = slugify(article.title);

  for (const existing of Array.isArray(manifest.articles)
    ? manifest.articles
    : []) {
    if (normalizeTopic(existing.title) === title) {
      fail(`Duplicate article title rejected: ${article.title}`);
    }

    if (slugify(existing.slug || existing.title) === slug) {
      fail(`Duplicate article slug rejected: ${slug}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* HTML rendering                                                              */
/* -------------------------------------------------------------------------- */

function sourceCatalog(packet) {
  const catalog = [];
  const sourceToNumber = new Map();

  for (const evidence of packet.evidence || []) {
    const key =
      evidence.kind === "external"
        ? `external:${evidence.source_url}`
        : `apxn:${evidence.source_path || evidence.source_title}`;

    if (sourceToNumber.has(key)) continue;

    const number = catalog.length + 1;
    sourceToNumber.set(key, number);

    catalog.push({
      number,
      key,
      kind: evidence.kind,
      title: evidence.source_title,
      url: evidence.source_url || null,
      source_path: evidence.source_path || null,
      project_source_paths: evidence.project_source_paths || []
    });
  }

  return { catalog, sourceToNumber };
}

function citationMarkup(evidenceIds, evidenceMap, sourceToNumber) {
  const numbers = [];

  for (const id of uniqueStrings(evidenceIds, 20)) {
    const evidence = evidenceMap.get(id);
    if (!evidence) continue;

    const key =
      evidence.kind === "external"
        ? `external:${evidence.source_url}`
        : `apxn:${evidence.source_path || evidence.source_title}`;

    const number = sourceToNumber.get(key);

    if (number && !numbers.includes(number)) {
      numbers.push(number);
    }
  }

  if (numbers.length === 0) return "";

  return `<sup class="ml-1 text-yellow-400">${numbers
    .map(
      (number) =>
        `<a href="#source-${number}" aria-label="Source ${number}">[${number}]</a>`
    )
    .join("")}</sup>`;
}

function renderArticleHtml({
  article,
  packet,
  config,
  date,
  slug,
  words,
  manifest
}) {
  const baseUrl = String(
    config?.site?.base_url || "https://apxn.network"
  ).replace(/\/+$/, "");

  const url = `${baseUrl}/blog/articles/${slug}.html`;
  const image =
    config?.seo?.default_og_image || `${baseUrl}/logo2%20(1).png`;
  const author = config?.site?.author || "Apex Network Editorial";

  const evidenceMap = new Map(
    (packet.evidence || []).map((item) => [item.id, item])
  );

  const { catalog, sourceToNumber } = sourceCatalog(packet);

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.description,
    image,
    mainEntityOfPage: url,
    datePublished: date,
    dateModified: date,
    author: {
      "@type": "Organization",
      name: author
    },
    publisher: {
      "@type": "Organization",
      name: config?.site?.brand || "Apex Network",
      url: baseUrl,
      logo: {
        "@type": "ImageObject",
        url: image
      }
    }
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: (article.faq || []).map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer
      }
    }))
  };

  const sectionsHtml = article.sections
    .map((section) => {
      const paragraphs = section.paragraphs
        .map(
          (paragraph) =>
            `<p>${escapeHtml(paragraph.text)}${citationMarkup(
              paragraph.evidence_ids,
              evidenceMap,
              sourceToNumber
            )}</p>`
        )
        .join("\n");

      return `<section>
        <h2>${escapeHtml(section.heading)}</h2>
        ${paragraphs}
      </section>`;
    })
    .join("\n");

  const faqHtml = article.faq
    .map(
      (item) => `<div class="info-box">
        <h3>${escapeHtml(item.question)}</h3>
        <p>${escapeHtml(item.answer)}${citationMarkup(
          item.evidence_ids,
          evidenceMap,
          sourceToNumber
        )}</p>
      </div>`
    )
    .join("\n");

  const sourcesHtml = catalog
    .map((source) => {
      if (source.kind === "external") {
        return `<li id="source-${source.number}">
          <a href="${escapeHtml(
            source.url
          )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            source.title
          )}</a>
          <span> — official documentation</span>
        </li>`;
      }

      return `<li id="source-${source.number}">
        <strong>${escapeHtml(source.title)}</strong>
        <span> — reviewed APXN project knowledge</span>
      </li>`;
    })
    .join("\n");

  const related = (manifest.articles || [])
    .filter((item) => item?.status === "published" && item?.slug !== slug)
    .slice(-3)
    .reverse();

  const relatedHtml =
    related.length > 0
      ? `<section>
          <h2>Related reading</h2>
          <ul>
            ${related
              .map(
                (item) =>
                  `<li><a href="./${escapeHtml(
                    item.slug
                  )}.html">${escapeHtml(item.title)}</a></li>`
              )
              .join("\n")}
          </ul>
        </section>`
      : "";

  const disclaimer = ["apxn", "hybrid"].includes(packet.topic.content_mode)
    ? "APXN Points are the current in-app point balance described by reviewed project knowledge. This article does not promise future token value, profit, listing or withdrawal value."
    : "This article is educational and does not provide financial, investment or trading advice.";

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>${escapeHtml(article.title)}</title>
  <meta name="description" content="${escapeHtml(article.description)}">
  <meta name="keywords" content="${escapeHtml(article.keywords.join(", "))}">
  <meta name="robots" content="${escapeHtml(
    config?.seo?.robots || "index, follow"
  )}">
  <meta name="author" content="${escapeHtml(author)}">

  <link rel="canonical" href="${escapeHtml(url)}">
  <link rel="icon" href="../../logo2%20(1).png" type="image/png">

  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(article.title)}">
  <meta property="og:description" content="${escapeHtml(article.description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:site_name" content="${escapeHtml(
    config?.site?.brand || "Apex Network"
  )}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(article.title)}">
  <meta name="twitter:description" content="${escapeHtml(
    article.description
  )}">
  <meta name="twitter:image" content="${escapeHtml(image)}">

  <script>
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  </script>
  <script defer src="/_vercel/insights/script.js"></script>

  <script src="https://cdn.tailwindcss.com"></script>

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
      margin-top: 1rem;
      margin-bottom: .75rem;
    }
    .article-body ul, .article-body ol {
      color: #cbd5e1;
      margin: 1rem 0 1.5rem 1.5rem;
      line-height: 1.9;
    }
    .article-body ul { list-style: disc; }
    .article-body ol { list-style: decimal; }
    .article-body strong { color: #fff; }
    .article-body a { color: #facc15; font-weight: 800; }
    .article-body a:hover { color: #fde047; }
    .info-box {
      background: rgba(15, 23, 42, .8);
      border: 1px solid rgba(234, 179, 8, .25);
      border-radius: 1rem;
      padding: 1.25rem;
      margin: 1.5rem 0;
    }
  </style>

  <script type="application/ld+json">
${safeJsonForScript(articleSchema)}
  </script>

  <script type="application/ld+json">
${safeJsonForScript(faqSchema)}
  </script>
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

      <a href="https://t.me/ApxMinerBot" target="_blank" rel="noopener noreferrer"
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
            <span class="text-yellow-400">${escapeHtml(
              packet.topic.category
            )}</span>
          </nav>

          <span class="inline-flex border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-widest mb-5">
            ${escapeHtml(packet.topic.category)}
          </span>

          <h1 class="text-4xl sm:text-5xl lg:text-6xl font-black leading-tight mb-6">
            ${escapeHtml(article.title)}
          </h1>

          <p class="text-lg sm:text-xl text-gray-400 leading-relaxed mb-7">
            ${escapeHtml(article.description)}
          </p>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs sm:text-sm text-gray-500">
            <span class="font-bold text-gray-300">${escapeHtml(author)}</span>
            <span>•</span>
            <time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>
            <span>•</span>
            <span>${readingMinutes(words)} min read</span>
          </div>
        </div>
      </section>

      <div class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-12 sm:py-16">
        <div class="article-body">
          <p class="text-lg">${escapeHtml(
            article.intro.text
          )}${citationMarkup(
            article.intro.evidence_ids,
            evidenceMap,
            sourceToNumber
          )}</p>

          ${sectionsHtml}

          <section>
            <h2>Frequently asked questions</h2>
            ${faqHtml}
          </section>

          <section>
            <h2>Conclusion</h2>
            <p>${escapeHtml(
              article.conclusion.text
            )}${citationMarkup(
              article.conclusion.evidence_ids,
              evidenceMap,
              sourceToNumber
            )}</p>
          </section>

          ${relatedHtml}

          <section>
            <h2>Sources and methodology</h2>
            <p>
              A free deterministic research stage collected and screened the evidence before the paid writer was called.
              The writing model received only this approved Research Packet and no web-search tools.
            </p>
            <ol>
              ${sourcesHtml}
            </ol>
          </section>

          <div class="info-box">
            <strong>Editorial note:</strong>
            <p>${escapeHtml(disclaimer)}</p>
          </div>
        </div>
      </div>
    </article>
  </main>

  <footer class="border-t border-slate-800">
    <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-8 text-sm text-gray-500 flex flex-wrap gap-4 justify-between">
      <span>© ${new Date().getUTCFullYear()} Apex Network</span>
      <a href="../index.html" class="hover:text-yellow-400">APXN Blog</a>
    </div>
  </footer>
</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* Manifest / queue state                                                     */
/* -------------------------------------------------------------------------- */

function sortWaitingQueue(manifest) {
  return (manifest.generation_queue || [])
    .filter((item) => item?.status === "waiting")
    .sort(
      (a, b) =>
        Number(a?.priority || 999999) - Number(b?.priority || 999999)
    );
}

function queueItemIndex(manifest, target) {
  return (manifest.generation_queue || []).findIndex((item) => item === target);
}

function markQueueItem(manifest, queueItem, status, details = {}) {
  const index = queueItemIndex(manifest, queueItem);
  if (index < 0) return;

  manifest.generation_queue[index] = {
    ...manifest.generation_queue[index],
    status,
    ...details
  };
}

function markBankItem(bank, metadata, status, details = {}) {
  if (!metadata.topic_bank_id) return;

  const item = bank.topics.find(
    (candidate) => candidate.id === metadata.topic_bank_id
  );

  if (!item) return;

  Object.assign(item, {
    status,
    ...details
  });
}

function refreshStats(manifest) {
  const articles = Array.isArray(manifest.articles) ? manifest.articles : [];

  manifest.stats = {
    total_articles: articles.length,
    published: articles.filter((item) => item.status === "published").length,
    drafts: articles.filter((item) => item.status === "draft").length,
    featured: articles.filter((item) => item.featured === true).length
  };

  const nextWaiting = sortWaitingQueue(manifest)[0];

  manifest.automation_state = manifest.automation_state || {};
  manifest.automation_state.next_queue_priority = nextWaiting?.priority ?? null;
  manifest.automation_state.automatic_generation =
    manifest.automation_state.automatic_generation === true;
  manifest.automation_state.automatic_publishing =
    manifest.automation_state.automatic_publishing === true;
}

function articleManifestRecord({
  article,
  packet,
  config,
  date,
  slug,
  words,
  articleId
}) {
  const baseUrl = String(
    config?.site?.base_url || "https://apxn.network"
  ).replace(/\/+$/, "");

  const url = `${baseUrl}/blog/articles/${slug}.html`;

  return {
    id: articleId,
    slug,
    title: article.title,
    description: article.description,
    category: packet.topic.category,
    language: "en",
    author: config?.site?.author || "Apex Network Editorial",
    status: "published",
    featured: false,
    indexable: true,
    published_at: date,
    updated_at: date,
    reading_minutes: readingMinutes(words),
    word_count: words,
    path: `blog/articles/${slug}.html`,
    url,
    image:
      config?.seo?.default_og_image ||
      `${baseUrl}/logo2%20(1).png`,
    keywords: uniqueStrings(article.keywords, 10),
    source: "automated_research_packet_pipeline",
    content_mode: packet.topic.content_mode,
    source_profile: packet.topic.source_profile,
    topic_bank_id: packet.topic.id || null,
    research_packet_schema_version: packet.schema_version,
    deterministic_local_quality_gate: true,
    paid_ai_calls_for_article: 1,
    seo: {
      canonical: url,
      robots: "index, follow",
      article_schema: true,
      faq_schema: true
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Free source-test compatibility                                             */
/* -------------------------------------------------------------------------- */

async function runSourceTest() {
  const requestedRaw = normalizeSpace(
    process.env.TEST_ID ||
      process.env.BLOG_SOURCE_PROFILE ||
      process.env.SOURCE_PROFILE
  );

  if (!requestedRaw) {
    fail(
      "BLOG_SOURCE_TEST requires TEST_ID, BLOG_SOURCE_PROFILE or SOURCE_PROFILE."
    );
  }

  const profileId = SOURCE_PROFILE_ALIASES[requestedRaw] || requestedRaw;
  const topic = normalizeSpace(
    process.env.TEST_TOPIC || `Official source research test for ${profileId}`
  );

  const metadata = {
    id: `source-test-${profileId}`,
    topic,
    category: normalizeSpace(process.env.TEST_CATEGORY || "Education"),
    risk: "safe",
    status: "available",
    content_mode: "external",
    source_profile: profileId,
    knowledge_sections: [],
    auto_publish_allowed: true
  };

  const packet = await buildResearchPacketForTopic(metadata);

  if (Number(packet?.paid_ai_calls || 0) !== 0) {
    fail("Source test unexpectedly reported paid AI usage.");
  }

  const fetchErrors = Array.isArray(packet?.source_fetch?.errors)
    ? packet.source_fetch.errors
    : [];

  if (fetchErrors.length > 0) {
    const details = fetchErrors
      .slice(0, 5)
      .map((item) => {
        if (typeof item === "string") return item;

        const title = normalizeSpace(item?.title || "Official source");
        const url = normalizeSpace(item?.url || "");
        const error = normalizeSpace(
          item?.error || item?.message || "Unknown fetch error"
        );

        return `${title}${url ? ` (${url})` : ""}: ${error}`;
      })
      .join(" | ");

    fail(
      `SOURCE TEST FETCH FAILED: ${profileId}: ${details || "Official source fetch error."}`
    );
  }

  const metrics = packet.sufficiency?.metrics || {};

  if (packet.status === "INSUFFICIENT_RESEARCH") {
    const reasons = packet?.sufficiency?.reasons || [];

    console.log(`SOURCE TEST SAFE SKIP: ${profileId}`);
    console.log(
      `Reason: ${reasons.join(" | ") || "Research evidence is insufficient for a substantial 1200+ word article."}`
    );
    console.log(
      `Distinct official pages: ${Number(metrics.distinct_external_pages || 0)}`
    );
    console.log(
      `Evidence items: ${Number(metrics.evidence_items || 0)} / required ${Number(
        metrics.required_evidence_items || 0
      )}`
    );
    console.log(`Evidence words: ${Number(metrics.total_words || 0)}`);
    console.log("Research stage: deterministic/free");
    console.log("Paid writer blocked safely: yes");
    console.log("xAI calls: 0");
    return;
  }

  if (packet.status !== "READY_FOR_PAID_WRITER") {
    fail(
      `SOURCE TEST FAILED: ${profileId}: unexpected Research Packet status ${packet.status}.`
    );
  }

  console.log(`SOURCE TEST PASS: ${profileId}`);
  console.log(
    `Distinct official pages: ${Number(metrics.distinct_external_pages || 0)}`
  );
  console.log(
    `Evidence items: ${Number(metrics.evidence_items || 0)} / required ${Number(
      metrics.required_evidence_items || 0
    )}`
  );
  console.log(`Evidence words: ${Number(metrics.total_words || 0)}`);
  console.log("Research stage: deterministic/free");
  console.log("xAI calls: 0");
}

/* -------------------------------------------------------------------------- */
/* Offline self-test                                                          */
/* -------------------------------------------------------------------------- */

function runSelfTest() {
  const allowed = ["E1", "E2"];

  if (!evidenceIdsWithin(["E1"], allowed)) {
    fail("SELF TEST: evidence subset check failed.");
  }

  if (evidenceIdsWithin(["E3"], allowed)) {
    fail("SELF TEST: outside evidence ID was incorrectly accepted.");
  }

  if (!numericTokenSupported("24 hours", "The window lasts 24 hours.")) {
    fail("SELF TEST: supported numeric token was rejected.");
  }

  if (numericTokenSupported("12 hours", "The window lasts 24 hours.")) {
    fail("SELF TEST: unsupported numeric token was accepted.");
  }

  const unsupported = unsupportedHighRiskPatterns(
    "This removes the need for another wallet.",
    "The source describes account access."
  );

  if (!unsupported.includes("removes-the-need claim")) {
    fail("SELF TEST: high-risk inference detection failed.");
  }

  if (jaccardSimilarity("alpha beta gamma delta", "alpha beta gamma delta") < 0.99) {
    fail("SELF TEST: repetition similarity check failed.");
  }

  console.log("APXN BLOG WRITER SELF TEST PASS");
  console.log("Paid AI calls: 0");
}

/* -------------------------------------------------------------------------- */
/* Main pipeline                                                              */
/* -------------------------------------------------------------------------- */

async function main() {
  if (isTruthyEnv("BLOG_WRITER_SELF_TEST")) {
    runSelfTest();
    return;
  }

  const config = readJson(PATHS.config);
  const manifest = readJson(PATHS.articles);
  const bank = readJson(PATHS.topicBank);
  const costs = ensureCostLedger(readJsonIfExists(PATHS.costs));

  validateConfig(config);
  validateTopicBank(bank, config);

  if (isTruthyEnv("BLOG_SOURCE_TEST")) {
    await runSourceTest();
    return;
  }

  const publishRequested = isTruthyEnv("BLOG_PUBLISH");

  if (
    publishRequested &&
    config?.automation?.auto_publish_enabled !== true
  ) {
    fail(
      "BLOG_PUBLISH=true was requested while automation.auto_publish_enabled=false. Publication is blocked safely."
    );
  }

  if (
    publishRequested &&
    config?.automation?.auto_generate_enabled !== true
  ) {
    fail(
      "BLOG_PUBLISH=true was requested while automation.auto_generate_enabled=false. Generation is blocked safely."
    );
  }

  const apiKey = String(process.env.XAI_API_KEY || "").trim();
  if (!apiKey) {
    fail("XAI_API_KEY is missing.");
  }

  const waiting = sortWaitingQueue(manifest);
  if (waiting.length === 0) {
    fail("No waiting topics are available.");
  }

  const maxAttempts = Math.min(MAX_PRE_AI_TOPIC_ATTEMPTS, waiting.length);
  let selected = null;
  let lastPreAiReason = "No eligible topic.";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const queueItem = waiting[attempt];
    const metadata = hydrateTopic(queueItem, bank);

    if (!metadata.ok) {
      lastPreAiReason = metadata.reason;

      console.log(
        `Free preflight skip: ${queueItem.topic}: ${metadata.reason}`
      );

      if (publishRequested) {
        markQueueItem(
          manifest,
          queueItem,
          metadata.retired_legacy ? "retired_legacy" : "skipped_metadata",
          {
            skipped_at: todayISO(),
            skip_reason: metadata.reason
          }
        );
      }

      continue;
    }

    if (!config.categories.includes(metadata.category)) {
      lastPreAiReason = `Unknown category: ${metadata.category}`;

      if (publishRequested) {
        markQueueItem(manifest, queueItem, "skipped_metadata", {
          skipped_at: todayISO(),
          skip_reason: lastPreAiReason
        });
      }

      continue;
    }

    console.log(`FREE RESEARCH: ${metadata.topic}`);
    console.log(`Content mode: ${metadata.content_mode}`);
    console.log(
      `Source profile: ${metadata.source_profile || "APXN knowledge only"}`
    );
    console.log("Paid AI calls before research: 0");

    let packet;

    try {
      packet = await researchTopic(metadata);
    } catch (error) {
      lastPreAiReason = `Free researcher failed: ${error.message}`;

      console.log(`Safe skip before xAI: ${lastPreAiReason}`);

      if (publishRequested) {
        markQueueItem(manifest, queueItem, "skipped_research_error", {
          skipped_at: todayISO(),
          skip_reason: lastPreAiReason
        });
      }

      continue;
    }

    const provisionalSlug = slugify(metadata.topic);
    const packetPath = saveResearchPacket(packet, provisionalSlug);

    console.log(
      `Research Packet saved: ${path.relative(ROOT, packetPath)}`
    );
    console.log(`Research status: ${packet.status}`);

    if (packet.sufficiency?.metrics) {
      const metrics = packet.sufficiency.metrics;
      console.log(`Research evidence items: ${metrics.evidence_items}`);
      console.log(`Research evidence words: ${metrics.total_words}`);
      console.log(`External evidence words: ${metrics.external_words}`);
      console.log(`APXN evidence words: ${metrics.apxn_words}`);
      console.log(
        `Distinct external pages: ${metrics.distinct_external_pages}`
      );
    }

    if (packet.status !== "READY_FOR_PAID_WRITER") {
      const reasons = packet?.sufficiency?.reasons || [];
      lastPreAiReason =
        reasons.join(" | ") ||
        `Research Packet status is ${packet.status}.`;

      console.log(`Safe skip before xAI: ${lastPreAiReason}`);

      if (publishRequested) {
        markQueueItem(
          manifest,
          queueItem,
          "skipped_insufficient_research",
          {
            skipped_at: todayISO(),
            skip_reason: lastPreAiReason,
            content_mode: metadata.content_mode,
            source_profile: metadata.source_profile,
            topic_bank_id: metadata.topic_bank_id
          }
        );

        markBankItem(bank, metadata, "needs_evidence", {
          last_evidence_failure: todayISO(),
          last_evidence_failure_reason: lastPreAiReason
        });
      }

      continue;
    }

    selected = {
      queueItem,
      metadata,
      packet,
      provisionalSlug
    };

    break;
  }

  if (!selected) {
    if (publishRequested) {
      manifest.last_updated = todayISO();
      bank.last_updated = todayISO();
      refreshStats(manifest);
      writeJson(PATHS.articles, manifest);
      writeJson(PATHS.topicBank, bank);
    }

    fail(
      `No topic passed the FREE Research Packet gate. Last reason: ${lastPreAiReason}`
    );
  }

  const { queueItem, metadata, packet, provisionalSlug } = selected;
  const date = todayISO();

  console.log("FREE RESEARCH PASS");
  console.log("Research Packet is now frozen as the writer's sole factual input.");
  console.log("Paid AI calls so far: 0");

  assertGenerationCostPreflight(config, costs);

  const generation = await callPaidWriter({
    config,
    apiKey,
    input: paidWriterInput(packet, config)
  });

  const generationCost = appendCostRecord({
    costs,
    responseJson: generation.responseJson,
    stage: "research_packet_writing",
    topic: metadata.topic,
    slug: provisionalSlug,
    model: generation.model
  });

  assertCostKnown(config, generationCost);

  const runCostUsd = Number(generationCost.cost_usd || 0);
  assertRunCost(config, runCostUsd);

  fs.mkdirSync(PATHS.privateDrafts, { recursive: true });

  const rawGenerationPath = path.join(
    PATHS.privateDrafts,
    `${provisionalSlug}.raw-generation.json`
  );

  writeJson(rawGenerationPath, {
    generated_at: date,
    architecture: "free_research_packet_then_one_paid_writer_call",
    paid_ai_calls: 1,
    topic: metadata.topic,
    category: metadata.category,
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    model: generation.model,
    response_id: generation.responseJson?.id || null,
    generation_cost_usd: runCostUsd,
    research_packet_summary: packetSummary(packet),
    raw_text: generation.rawText,
    parsed: generation.parsed
  });

  console.log(
    `Raw paid-writer output saved: ${path.relative(
      ROOT,
      rawGenerationPath
    )}`
  );

  const article = generation.parsed;

  const local = validateArticleAgainstPacket({
    article,
    packet,
    config
  });

  const validationPath = path.join(
    PATHS.privateDrafts,
    `${provisionalSlug}.local-validation.json`
  );

  writeJson(validationPath, {
    generated_at: date,
    ...local
  });

  console.log(
    `Local validation saved: ${path.relative(ROOT, validationPath)}`
  );
  console.log(`Article body words: ${local.body_word_count}`);

  if (!local.ok) {
    const reason = `FREE local quality gate failed: ${local.errors.join(
      " | "
    )}`;

    if (publishRequested) {
      markQueueItem(manifest, queueItem, "rejected_quality", {
        rejected_at: date,
        reject_reason: reason
      });

      manifest.last_updated = date;
      refreshStats(manifest);
      writeJson(PATHS.articles, manifest);
    }

    fail(reason);
  }

  assertNotDuplicate(article, manifest);

  const finalSlug = slugify(article.title);
  if (!finalSlug) {
    fail("Generated article title could not produce a valid slug.");
  }

  const html = renderArticleHtml({
    article,
    packet,
    config,
    date,
    slug: finalSlug,
    words: local.body_word_count,
    manifest
  });

  const privateHtmlPath = path.join(
    PATHS.privateDrafts,
    `${finalSlug}.html`
  );

  const privateJsonPath = path.join(
    PATHS.privateDrafts,
    `${finalSlug}.json`
  );

  writeText(privateHtmlPath, html);

  writeJson(privateJsonPath, {
    generated_at: date,
    architecture: "free_research_packet_then_one_paid_writer_call",
    paid_ai_calls: 1,
    topic: metadata.topic,
    category: metadata.category,
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    knowledge_sections: metadata.knowledge_sections,
    word_count: local.body_word_count,
    run_cost_usd: runCostUsd,
    local_validation: local,
    research_packet: packet
  });

  if (!publishRequested) {
    console.log("PRIVATE WRITER TEST PASS");
    console.log(`Draft: ${path.relative(ROOT, privateHtmlPath)}`);
    console.log(`Words: ${local.body_word_count}`);
    console.log(
      `Research evidence items: ${packet.evidence.length}; research words: ${packet.sufficiency.metrics.total_words}`
    );
    console.log("Paid AI calls: 1");
    console.log(`Exact tracked run cost: $${runCostUsd.toFixed(6)}`);
    return;
  }

  fs.mkdirSync(PATHS.published, { recursive: true });

  const publishedPath = path.join(
    PATHS.published,
    `${finalSlug}.html`
  );

  writeText(publishedPath, html);

  const articleId = nextArticleId(manifest.articles);

  manifest.articles.push(
    articleManifestRecord({
      article,
      packet,
      config,
      date,
      slug: finalSlug,
      words: local.body_word_count,
      articleId
    })
  );

  markQueueItem(manifest, queueItem, "published", {
    article_id: articleId,
    generated_at: date,
    published_at: date,
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    knowledge_sections: metadata.knowledge_sections,
    topic_bank_id: metadata.topic_bank_id,
    auto_publish_allowed: true
  });

  markBankItem(bank, metadata, "published", {
    published_at: date,
    article_id: articleId,
    article_slug: finalSlug
  });

  manifest.last_updated = date;
  manifest.automation_state = manifest.automation_state || {};
  manifest.automation_state.last_generated_article = articleId;
  manifest.automation_state.last_published_article = articleId;
  manifest.automation_state.automatic_generation = true;
  manifest.automation_state.automatic_publishing = true;

  refreshStats(manifest);

  bank.last_updated = date;

  writeJson(PATHS.articles, manifest);
  writeJson(PATHS.topicBank, bank);

  console.log("PRODUCTION WRITER PASS");
  console.log(`Published file: ${path.relative(ROOT, publishedPath)}`);
  console.log(`Article ID: ${articleId}`);
  console.log(`Words: ${local.body_word_count}`);
  console.log(`Research evidence items: ${packet.evidence.length}`);
  console.log("Paid AI calls: 1");
  console.log(`Exact tracked run cost: $${runCostUsd.toFixed(6)}`);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});


