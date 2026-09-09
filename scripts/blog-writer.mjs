/**
 * APXN Blog Writer — Metadata-Routed Evidence Pipeline
 * Path: scripts/blog-writer.mjs
 *
 * Goals:
 * - English-only long-form educational content.
 * - Topic routing is driven by topic-bank metadata, never guessed from the title.
 * - APXN facts come only from approved knowledge_sections in apxn-blog-knowledge.json.
 * - External facts come only from the allowlisted source_profile in blog-source-profiles.json.
 * - Hybrid topics keep APXN and external provenance separate.
 * - Open-web research and model-memory sourcing are forbidden.
 * - Evidence sufficiency is checked BEFORE any paid xAI request.
 * - One generation request + one verification request; no paid repair loop.
 * - Weak or unsupported drafts are rejected instead of padded.
 * - Source-test mode uses the same source fetch/extraction functions as production and never calls xAI.
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
  sourceProfiles: path.join(ROOT, "data", "blog-source-profiles.json"),
  costs: path.join(ROOT, "data", "blog-costs.json"),
  published: path.join(ROOT, "blog", "articles"),
  privateDrafts: path.join(ROOT, ".workflow-output", "drafts")
};

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_ENDPOINT = "/responses";
const DEFAULT_MODEL = "grok-4.3";
const COST_TICKS_PER_USD = 10_000_000_000;

// Conservative preflight reserves. These are not provider guarantees; they are
// safety floors used to avoid starting a paid stage when the remaining monthly
// or per-article budget is already too small to complete it safely.
const DEFAULT_GENERATION_COST_RESERVE_USD = 0.05;
const DEFAULT_VERIFIER_COST_RESERVE_USD = 0.025;
const COST_PREFLIGHT_EPSILON_USD = 0.000000001;

const API_TIMEOUT_MS = 180_000;
const SOURCE_FETCH_TIMEOUT_MS = 22_000;
const MAX_SOURCE_BYTES = 800_000;
const MAX_SOURCE_TEXT_CHARS = 120_000;
const MAX_SOURCE_PASSAGE_CHARS = 1_650;
const MAX_EXTERNAL_EVIDENCE_CHARS = 18_000;
const MAX_APXN_EVIDENCE_CHARS = 18_000;
const MAX_EVIDENCE_ITEMS = 18;

const GENERATION_OUTPUT_TOKENS = 5_600;
const VERIFIER_OUTPUT_TOKENS = 1_600;

const MAX_PRE_AI_TOPIC_ATTEMPTS = 4;
const MIN_EVIDENCE_WORDS = {
  apxn: 240,
  external: 800,
  hybrid: 900
};
const MIN_EXTERNAL_EVIDENCE_WORDS = 800;

const CONTENT_MODES = new Set(["apxn", "external", "hybrid", "manual"]);

const SOURCE_PROFILE_ALIASES = {
  security: "wallet_security",
  ethereum: "blockchain_transactions",
  blockchain: "blockchain_transactions",
  web3: "telegram_web3"
};

/*
 * The current generation queue predates schema v2 topic metadata.
 * These compatibility records let the repaired writer hydrate those exact
 * legacy queue titles without forcing a destructive queue rewrite.
 */
const LEGACY_TOPIC_OVERRIDES = {
  "what is bsc understanding bep 20 tokens and gas fees": {
    content_mode: "external",
    source_profile: "bsc",
    knowledge_sections: [],
    auto_publish_allowed: false,
    retired: true,
    retired_reason:
      "Legacy composite topic retired: BNB Smart Chain, BEP-20 and gas fees are now separate schema-v2 topics with dedicated source profiles."
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
    "status",
    "reason",
    "title",
    "description",
    "keywords",
    "intro",
    "sections",
    "faq",
    "conclusion"
  ],
  properties: {
    status: {
      type: "string",
      enum: ["ready", "insufficient_evidence"]
    },
    reason: { type: "string" },
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

const VERIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "unsupported_blocks", "policy_issues", "summary"],
  properties: {
    status: {
      type: "string",
      enum: ["pass", "fail"]
    },
    unsupported_blocks: {
      type: "array",
      maxItems: 20,
      items: { type: "string" }
    },
    policy_issues: {
      type: "array",
      maxItems: 20,
      items: { type: "string" }
    },
    summary: { type: "string" }
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
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, value, "utf8");
  fs.renameSync(temp, filePath);
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

function monthKey(date = todayISO()) {
  return String(date).slice(0, 7);
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

function uniqueStrings(values, max = 50) {
  const seen = new Set();
  const result = [];

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
  return clean ? clean.split(/\s+/).filter(Boolean).length : 0;
}

function readingMinutes(words) {
  return Math.max(1, Math.ceil(Number(words || 0) / 220));
}

function containsArabicScript(value) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(value || ""));
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] || "").trim().toLowerCase()
  );
}

function hostnameOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function nextArticleId(articles) {
  let max = 0;

  for (const article of Array.isArray(articles) ? articles : []) {
    const match = String(article?.id || "").match(/^apxn-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }

  return `apxn-${String(max + 1).padStart(3, "0")}`;
}

function getAtPath(root, dottedPath) {
  let current = root;

  for (const part of String(dottedPath || "").split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function humanizeKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
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
    matches.map((item) =>
      normalizeSpace(item).toLowerCase().replace(/,/g, "")
    ),
    60
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
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

  if (!Array.isArray(config?.categories) || config.categories.length === 0) {
    fail("blog-config.json must contain categories.");
  }

  const minWords = Number(config?.writer?.minimum_words || 0);
  const targetWords = Number(config?.writer?.target_words || 0);
  const maxWords = Number(config?.writer?.maximum_words || 0);

  if (!(minWords >= 1200 && targetWords >= minWords && maxWords >= targetWords)) {
    fail("Writer word-count settings are invalid.");
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
    if (!item?.id || !item?.topic || !item?.category) {
      fail("A topic-bank entry is missing id, topic or category.");
    }

    if (!categories.has(item.category)) {
      fail(`Topic ${item.id} uses unknown category "${item.category}".`);
    }

    if (!CONTENT_MODES.has(String(item.content_mode || "").toLowerCase())) {
      fail(`Topic ${item.id} has invalid content_mode.`);
    }

    if (!Array.isArray(item.knowledge_sections)) {
      fail(`Topic ${item.id} must contain knowledge_sections.`);
    }
  }
}

function validateSourceProfiles(sourceFile) {
  if (Number(sourceFile?.schema_version || 0) < 1) {
    fail("data/blog-source-profiles.json has an invalid schema version.");
  }

  if (sourceFile?.rules?.open_web_research_allowed !== false) {
    fail("Source profiles must keep open_web_research_allowed=false.");
  }

  if (sourceFile?.rules?.approved_sources_only !== true) {
    fail("Source profiles must keep approved_sources_only=true.");
  }

  if (!sourceFile?.profiles || typeof sourceFile.profiles !== "object") {
    fail("data/blog-source-profiles.json must contain profiles.");
  }

  for (const [profileId, profile] of Object.entries(sourceFile.profiles)) {
    if (!["active", "manual_only"].includes(String(profile?.status || ""))) {
      fail(`Source profile ${profileId} has an invalid status.`);
    }

    const allowedDomains = new Set(
      (Array.isArray(profile.allowed_domains) ? profile.allowed_domains : [])
        .map((value) => String(value).toLowerCase().replace(/^www\./, ""))
        .filter(Boolean)
    );

    for (const source of Array.isArray(profile.sources) ? profile.sources : []) {
      let url;

      try {
        url = new URL(source.url);
      } catch {
        fail(`Source profile ${profileId} contains an invalid URL.`);
      }

      if (url.protocol !== "https:") {
        fail(`Source profile ${profileId} contains a non-HTTPS source.`);
      }

      const host = url.hostname.toLowerCase().replace(/^www\./, "");

      if (!allowedDomains.has(host)) {
        fail(
          `Source profile ${profileId} contains source host "${host}" outside allowed_domains.`
        );
      }
    }
  }
}

function validateRoutingCompatibility(bank, sourceFile) {
  for (const item of bank.topics) {
    const mode = String(item?.content_mode || "").toLowerCase();

    if (!["external", "hybrid", "manual"].includes(mode)) {
      continue;
    }

    const requested = normalizeSpace(item?.source_profile);

    if (!requested) {
      if (mode === "manual") continue;
      fail(`Topic ${item.id} requires a source_profile.`);
    }

    const profileId = SOURCE_PROFILE_ALIASES[requested] || requested;
    const profile = sourceFile.profiles?.[profileId];

    if (!profile) {
      fail(`Topic ${item.id} references unknown source_profile "${requested}".`);
    }

    if (
      item.auto_publish_allowed === true &&
      profile.status !== "active"
    ) {
      fail(
        `Topic ${item.id} is auto-publishable but source profile "${profileId}" is not active.`
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Topic metadata routing                                                     */
/* -------------------------------------------------------------------------- */

function findTopicBankItem(queueItem, bank) {
  const explicitId = normalizeSpace(queueItem?.topic_bank_id);

  if (explicitId) {
    const byId = bank.topics.find((item) => item.id === explicitId);
    if (byId) return byId;
  }

  const queueTopic = normalizeTopic(queueItem?.topic);

  const exact = bank.topics.find(
    (item) => normalizeTopic(item.topic) === queueTopic
  );

  if (exact) return exact;

  return null;
}

function hydrateTopic(queueItem, bank) {
  const bankItem = findTopicBankItem(queueItem, bank);
  const legacy = LEGACY_TOPIC_OVERRIDES[normalizeTopic(queueItem?.topic)] || null;

  if (legacy?.retired === true) {
    return {
      ok: false,
      retired_legacy: true,
      reason:
        normalizeSpace(legacy.retired_reason) ||
        "Legacy composite topic has been retired in favor of narrower schema-v2 topics."
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
    return {
      ok: false,
      reason: "Manual-only topic cannot enter automatic generation."
    };
  }

  if (autoPublishAllowed !== true) {
    return {
      ok: false,
      reason: "Topic is not approved for automatic publishing."
    };
  }

  if (
    ["external", "hybrid"].includes(contentMode) &&
    !normalizeSpace(sourceProfile)
  ) {
    return {
      ok: false,
      reason: "External/hybrid topic has no source_profile."
    };
  }

  if (
    ["apxn", "hybrid"].includes(contentMode) &&
    knowledgeSections.length === 0
  ) {
    return {
      ok: false,
      reason: "APXN/hybrid topic has no knowledge_sections."
    };
  }

  return {
    ok: true,
    bankItem,
    topic: normalizeSpace(queueItem.topic),
    category: normalizeSpace(queueItem.category || bankItem?.category),
    content_mode: contentMode,
    source_profile: sourceProfile ? normalizeSpace(sourceProfile) : null,
    knowledge_sections: uniqueStrings(knowledgeSections, 20),
    auto_publish_allowed: true,
    editorial_guard: editorialGuard,
    topic_bank_id: bankItem?.id || queueItem?.topic_bank_id || null
  };
}

/* -------------------------------------------------------------------------- */
/* APXN evidence                                                              */
/* -------------------------------------------------------------------------- */

function flattenKnowledge(value, prefix = "") {
  const lines = [];

  if (value === null || value === undefined) {
    return lines;
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    lines.push(`${prefix || "Value"}: ${String(value)}`);
    return lines;
  }

  if (Array.isArray(value)) {
    if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      lines.push(`${prefix || "Values"}: ${value.map(String).join("; ")}`);
      return lines;
    }

    value.forEach((item, index) => {
      const next = prefix ? `${prefix} item ${index + 1}` : `Item ${index + 1}`;
      lines.push(...flattenKnowledge(item, next));
    });

    return lines;
  }

  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix} — ${humanizeKey(key)}` : humanizeKey(key);

    if (["string", "number", "boolean"].includes(typeof child)) {
      lines.push(`${next}: ${String(child)}`);
    } else {
      lines.push(...flattenKnowledge(child, next));
    }
  }

  return lines;
}

function chunkPlainText(text, maxChars = 3000) {
  const lines = String(text || "")
    .split(/\n+/)
    .map(normalizeSpace)
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    current = line.slice(0, maxChars);
  }

  if (current) chunks.push(current);

  return chunks;
}

function collectApxnEvidence(metadata, knowledge) {
  const evidence = [];
  let usedChars = 0;
  let counter = 1;

  for (const sectionPath of metadata.knowledge_sections) {
    const node = getAtPath(knowledge, sectionPath);

    if (node === undefined) {
      return {
        ok: false,
        reason: `Knowledge section not found: ${sectionPath}`,
        evidence: []
      };
    }

    const text = flattenKnowledge(node).join("\n");

    for (const chunk of chunkPlainText(text, 3200)) {
      if (!chunk || wordCount(chunk) < 18) continue;
      if (usedChars + chunk.length > MAX_APXN_EVIDENCE_CHARS) break;

      evidence.push({
        id: `A${counter}`,
        kind: "apxn",
        source_title: `APXN reviewed project knowledge — ${sectionPath}`,
        source_url: null,
        source_path: sectionPath,
        text: chunk,
        numeric_tokens: numericTokens(chunk)
      });

      usedChars += chunk.length;
      counter += 1;

      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
    }

    if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
  }

  return {
    ok: evidence.length > 0,
    reason: evidence.length ? "ready" : "No APXN evidence could be created.",
    evidence
  };
}

/* -------------------------------------------------------------------------- */
/* Official external source evidence                                          */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what",
  "when", "where", "which", "why", "with", "your", "you", "into", "about",
  "guide", "understanding", "explained", "beginner", "beginners"
]);

function topicKeywords(topic) {
  return uniqueStrings(
    normalizeTopic(topic)
      .split(" ")
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    30
  );
}

function decodeBasicEntities(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : " ";
    });
}

function htmlToReadableText(html) {
  return decodeBasicEntities(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<form[\s\S]*?<\/form>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\n+/)
    .map((line) => normalizeSpace(line))
    .filter((line) => line.length >= 20)
    .join("\n")
    .slice(0, MAX_SOURCE_TEXT_CHARS);
}

function markdownToReadableText(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[>*+-]\s+/gm, "")
    .replace(/\|/g, " ")
    .split(/\n+/)
    .map((line) => normalizeSpace(line))
    .filter((line) => line.length >= 20)
    .join("\n")
    .slice(0, MAX_SOURCE_TEXT_CHARS);
}

function sourceTextFromResponse(raw, contentType) {
  if (
    /text\/html|application\/xhtml\+xml/i.test(contentType) ||
    /<html|<body|<article|<main/i.test(raw.slice(0, 2000))
  ) {
    return htmlToReadableText(raw);
  }

  if (/markdown|text\/plain/i.test(contentType)) {
    return markdownToReadableText(raw);
  }

  return normalizeSpace(raw).slice(0, MAX_SOURCE_TEXT_CHARS);
}

function chunkSourceText(text) {
  const paragraphs = String(text || "")
    .split(/\n+/)
    .map(normalizeSpace)
    .filter((part) => wordCount(part) >= 18);

  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_SOURCE_PASSAGE_CHARS) {
      const sentences =
        paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(normalizeSpace) || [paragraph];

      for (const sentence of sentences) {
        const candidate = current ? `${current} ${sentence}` : sentence;

        if (candidate.length <= MAX_SOURCE_PASSAGE_CHARS) {
          current = candidate;
        } else {
          if (wordCount(current) >= 45) chunks.push(current);
          current = sentence.slice(0, MAX_SOURCE_PASSAGE_CHARS);
        }
      }

      continue;
    }

    const candidate = current ? `${current}\n${paragraph}` : paragraph;

    if (candidate.length <= MAX_SOURCE_PASSAGE_CHARS) {
      current = candidate;
    } else {
      if (wordCount(current) >= 45) chunks.push(current);
      current = paragraph;
    }
  }

  if (wordCount(current) >= 45) chunks.push(current);

  return chunks;
}

function scorePassage(text, keywords) {
  const comparable = normalizeTopic(text);
  let score = 0;

  for (const keyword of keywords) {
    if (comparable.includes(keyword)) {
      score += keyword.length >= 8 ? 3 : 1;
    }
  }

  if (/\b(definition|means|works|transaction|security|wallet|token|blockchain|authentication|standard|network)\b/i.test(text)) {
    score += 1;
  }

  return score;
}

function isAllowedHost(host, allowedDomains) {
  const normalized = String(host || "").toLowerCase().replace(/^www\./, "");
  return allowedDomains.includes(normalized);
}

async function fetchOfficialSource(source, profile) {
  const originalUrl = new URL(source.url);
  const allowedDomains = (profile.allowed_domains || []).map((domain) =>
    String(domain).toLowerCase().replace(/^www\./, "")
  );

  if (originalUrl.protocol !== "https:") {
    throw new Error("Non-HTTPS official source rejected.");
  }

  if (!isAllowedHost(originalUrl.hostname, allowedDomains)) {
    throw new Error(`Source host is outside allowed_domains: ${originalUrl.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(originalUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "APXN-Blog-Writer/2.0 (+https://apxn.network)",
        Accept: "text/html,text/plain,text/markdown,application/xhtml+xml;q=0.9,*/*;q=0.5"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const finalUrl = new URL(response.url || originalUrl);

    if (!isAllowedHost(finalUrl.hostname, allowedDomains)) {
      throw new Error(
        `Redirect left the approved domain allowlist: ${finalUrl.hostname}`
      );
    }

    const contentLength = Number(response.headers.get("content-length") || 0);

    if (contentLength > MAX_SOURCE_BYTES) {
      throw new Error(`Source exceeds ${MAX_SOURCE_BYTES} bytes.`);
    }

    const raw = (await response.text()).slice(0, MAX_SOURCE_BYTES);
    const contentType = response.headers.get("content-type") || "";
    const readable = sourceTextFromResponse(raw, contentType);

    if (wordCount(readable) < 80) {
      throw new Error("Official source returned too little readable text.");
    }

    return {
      title: normalizeSpace(source.title || finalUrl.hostname),
      original_url: originalUrl.toString(),
      final_url: finalUrl.toString(),
      text: readable
    };
  } finally {
    clearTimeout(timer);
  }
}

async function collectExternalEvidence(metadata, sourceFile) {
  const requestedProfileId = SOURCE_PROFILE_ALIASES[metadata.source_profile] || metadata.source_profile;
  const profile = sourceFile.profiles?.[requestedProfileId];

  if (!profile) {
    return {
      ok: false,
      reason: `Unknown source_profile: ${metadata.source_profile}`,
      evidence: [],
      profile_id: requestedProfileId
    };
  }

  if (profile.status !== "active") {
    return {
      ok: false,
      reason: `Source profile ${requestedProfileId} is not active.`,
      evidence: [],
      profile_id: requestedProfileId
    };
  }

  const sources = Array.isArray(profile.sources) ? profile.sources : [];
  const minSources = Math.max(1, Number(profile.min_sources || 1));
  const keywords = topicKeywords(metadata.topic);

  const fetched = [];
  const errors = [];

  for (const source of sources) {
    try {
      const page = await fetchOfficialSource(source, profile);
      fetched.push(page);
    } catch (error) {
      errors.push(`${source.title || source.url}: ${error.message}`);
    }
  }

  if (fetched.length < minSources) {
    return {
      ok: false,
      reason:
        `Only ${fetched.length}/${minSources} required official source page(s) were usable.` +
        (errors.length ? ` Errors: ${errors.join(" | ")}` : ""),
      evidence: [],
      profile_id: requestedProfileId
    };
  }

  const evidence = [];
  let usedChars = 0;
  let counter = 1;

  for (const page of fetched) {
    const ranked = chunkSourceText(page.text)
      .map((text, index) => ({
        text,
        index,
        score: scorePassage(text, keywords)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 4);

    for (const passage of ranked) {
      if (usedChars + passage.text.length > MAX_EXTERNAL_EVIDENCE_CHARS) break;

      evidence.push({
        id: `E${counter}`,
        kind: "external",
        source_title: page.title,
        source_url: page.final_url,
        source_path: null,
        text: passage.text,
        numeric_tokens: numericTokens(passage.text)
      });

      usedChars += passage.text.length;
      counter += 1;

      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
    }

    if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
  }

  return {
    ok: evidence.length > 0,
    reason: evidence.length ? "ready" : "No source passages were extracted.",
    evidence,
    profile_id: requestedProfileId,
    fetched_source_count: fetched.length,
    fetch_errors: errors
  };
}

/* -------------------------------------------------------------------------- */
/* Evidence preparation and feasibility                                       */
/* -------------------------------------------------------------------------- */

function totalEvidenceWords(evidence) {
  return evidence.reduce((sum, item) => sum + wordCount(item.text), 0);
}

function uniqueExternalSourceCount(evidence) {
  return new Set(
    evidence
      .filter((item) => item.kind === "external" && item.source_url)
      .map((item) => item.source_url)
  ).size;
}

function validateEvidenceFeasibility(metadata, evidence) {
  const totalWords = totalEvidenceWords(evidence);
  const externalWords = totalEvidenceWords(
    evidence.filter((item) => item.kind === "external")
  );
  const required = MIN_EVIDENCE_WORDS[metadata.content_mode] || 800;

  if (totalWords < required) {
    return {
      ok: false,
      reason:
        `Evidence provides ${totalWords} words; this ${metadata.content_mode} topic requires at least ${required} source/knowledge words before a 1200+ word article is attempted.`
    };
  }

  if (
    ["external", "hybrid"].includes(metadata.content_mode) &&
    externalWords < MIN_EXTERNAL_EVIDENCE_WORDS
  ) {
    return {
      ok: false,
      reason:
        `Official external evidence provides ${externalWords} words; at least ${MIN_EXTERNAL_EVIDENCE_WORDS} external-source words are required before xAI is called.`
    };
  }

  if (metadata.content_mode === "hybrid") {
    if (!evidence.some((item) => item.kind === "apxn")) {
      return { ok: false, reason: "Hybrid topic has no APXN evidence." };
    }

    if (!evidence.some((item) => item.kind === "external")) {
      return { ok: false, reason: "Hybrid topic has no external official evidence." };
    }
  }

  return { ok: true, reason: "ready" };
}

async function buildEvidence(metadata, knowledge, sourceFile) {
  const evidence = [];
  const diagnostics = {
    apxn: null,
    external: null
  };

  if (["apxn", "hybrid"].includes(metadata.content_mode)) {
    const result = collectApxnEvidence(metadata, knowledge);
    diagnostics.apxn = result;

    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        evidence: [],
        diagnostics
      };
    }

    evidence.push(...result.evidence);
  }

  if (["external", "hybrid"].includes(metadata.content_mode)) {
    const result = await collectExternalEvidence(metadata, sourceFile);
    diagnostics.external = result;

    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        evidence: [],
        diagnostics
      };
    }

    evidence.push(...result.evidence);
  }

  const limited = evidence.slice(0, MAX_EVIDENCE_ITEMS);
  const feasibility = validateEvidenceFeasibility(metadata, limited);

  return {
    ok: feasibility.ok,
    reason: feasibility.reason,
    evidence: limited,
    diagnostics
  };
}

function compactEvidenceDiagnostics(metadata, evidence, diagnostics) {
  const externalEvidence = evidence.filter((item) => item.kind === "external");
  const apxnEvidence = evidence.filter((item) => item.kind === "apxn");

  return {
    topic: metadata.topic,
    category: metadata.category,
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    totals: {
      evidence_items: evidence.length,
      evidence_words: totalEvidenceWords(evidence),
      external_passages: externalEvidence.length,
      external_words: totalEvidenceWords(externalEvidence),
      apxn_passages: apxnEvidence.length,
      apxn_words: totalEvidenceWords(apxnEvidence)
    },
    external: diagnostics?.external
      ? {
          profile_id: diagnostics.external.profile_id || metadata.source_profile || null,
          fetched_source_count: Number(
            diagnostics.external.fetched_source_count || 0
          ),
          fetch_errors: Array.isArray(diagnostics.external.fetch_errors)
            ? diagnostics.external.fetch_errors
            : []
        }
      : null,
    apxn: diagnostics?.apxn
      ? {
          evidence_items: Array.isArray(diagnostics.apxn.evidence)
            ? diagnostics.apxn.evidence.length
            : apxnEvidence.length,
          reason: diagnostics.apxn.reason || null
        }
      : null
  };
}

/* -------------------------------------------------------------------------- */
/* xAI request + exact cost ledger                                            */
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

  return {
    ticks,
    usd: ticks / COST_TICKS_PER_USD
  };
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
    costs.months[key] = {
      requests: []
    };
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
    fail("xAI did not return exact usage.cost_in_usd_ticks; publication is blocked.");
  }
}

function configuredCostReserve(config, field, fallback) {
  const value = Number(config?.cost_control?.[field]);

  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  return fallback;
}

function assertPaidCallPreflight({
  config,
  costs,
  stage,
  runCostUsd = 0,
  reserveUsd,
  downstreamReserveUsd = 0
}) {
  if (config?.cost_control?.enabled !== true) return;

  const stageReserve = Number(reserveUsd);
  const downstreamReserve = Number(downstreamReserveUsd);

  if (!Number.isFinite(stageReserve) || stageReserve <= 0) {
    fail(`Invalid xAI cost reserve for ${stage}.`);
  }

  if (!Number.isFinite(downstreamReserve) || downstreamReserve < 0) {
    fail(`Invalid downstream xAI cost reserve for ${stage}.`);
  }

  const requiredReserve = stageReserve + downstreamReserve;
  const spentThisRun = Math.max(0, Number(runCostUsd) || 0);

  const monthlyBudget = Number(config?.cost_control?.monthly_budget_usd || 0);
  const monthlySpent = monthSpendUsd(costs, monthKey());
  const monthlyRemaining =
    monthlyBudget > 0 ? Math.max(0, monthlyBudget - monthlySpent) : Infinity;

  if (
    config?.cost_control?.stop_when_monthly_budget_reached === true &&
    monthlyBudget > 0 &&
    monthlyRemaining + COST_PREFLIGHT_EPSILON_USD < requiredReserve
  ) {
    fail(
      `Cost preflight blocked ${stage}: monthly budget has $${monthlyRemaining.toFixed(6)} remaining, but at least $${requiredReserve.toFixed(3)} is reserved for this stage${
        downstreamReserve > 0 ? " plus the next paid stage" : ""
      }.`
    );
  }

  const articleLimit = Number(
    config?.cost_control?.maximum_cost_per_article_usd || 0
  );
  const articleRemaining =
    articleLimit > 0 ? Math.max(0, articleLimit - spentThisRun) : Infinity;

  if (
    articleLimit > 0 &&
    articleRemaining + COST_PREFLIGHT_EPSILON_USD < requiredReserve
  ) {
    fail(
      `Cost preflight blocked ${stage}: article budget has $${articleRemaining.toFixed(6)} remaining, but at least $${requiredReserve.toFixed(3)} is reserved for this stage${
        downstreamReserve > 0 ? " plus the next paid stage" : ""
      }.`
    );
  }

  console.log(
    `COST PREFLIGHT PASS: ${stage}; reserved $${requiredReserve.toFixed(3)}; ` +
      `monthly remaining $${
        Number.isFinite(monthlyRemaining) ? monthlyRemaining.toFixed(6) : "unlimited"
      }; article remaining $${
        Number.isFinite(articleRemaining) ? articleRemaining.toFixed(6) : "unlimited"
      }.`
  );
}

function assertRunCost(config, runCostUsd) {
  if (config?.cost_control?.enabled !== true) return;

  const max = Number(config?.cost_control?.maximum_cost_per_article_usd || 0);

  if (max > 0 && runCostUsd > max) {
    fail(
      `Article pipeline cost $${runCostUsd.toFixed(6)} exceeds the per-article limit $${max.toFixed(2)}.`
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

  for (const output of Array.isArray(responseJson?.output) ? responseJson.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        pieces.push(content.text.trim());
      }
    }
  }

  return pieces.join("\n").trim();
}

async function callStructuredXai({
  config,
  apiKey,
  instructions,
  input,
  schemaName,
  schema,
  maxOutputTokens
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
    instructions,
    input,
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

  const effort = String(config?.ai?.reasoning_effort || "none").trim();

  if (effort) {
    body.reasoning = { effort };
  }

  if (
    config?.cost_control?.use_prompt_caching === true &&
    config?.ai?.prompt_cache_key
  ) {
    body.prompt_cache_key = String(config.ai.prompt_cache_key);
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

    let json;

    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(
        `xAI returned non-JSON response: ${raw.slice(0, 500)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `xAI HTTP ${response.status}: ${JSON.stringify(json).slice(0, 900)}`
      );
    }

    const text = extractResponseText(json);

    if (!text) {
      throw new Error("xAI response did not contain output text.");
    }

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Structured xAI output was not valid JSON: ${error.message}`);
    }

    return {
      responseJson: json,
      parsed,
      rawText: text,
      model
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Evidence block plan                                                        */
/* -------------------------------------------------------------------------- */

function evidenceSourceKey(item) {
  if (item.kind === "external") {
    return `external:${item.source_url || item.source_title || item.id}`;
  }

  return `apxn:${item.source_path || item.source_title || item.id}`;
}

function evidenceGroupsBySource(evidence) {
  const groups = new Map();

  for (const item of evidence) {
    const key = evidenceSourceKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: item.kind,
        source_title: item.source_title,
        source_url: item.source_url || null,
        items: []
      });
    }

    groups.get(key).items.push(item);
  }

  return [...groups.values()];
}

function buildEvidenceBlockPlan(metadata, evidence) {
  const sourceGroups = evidenceGroupsBySource(evidence);

  if (evidence.length < 4 || sourceGroups.length === 0) {
    fail(
      `Evidence block plan requires at least 4 evidence passages; received ${evidence.length}.`
    );
  }

  const idsFromItems = (...items) =>
    uniqueStrings(items.filter(Boolean).map((item) => item.id), 4);

  const groupItem = (group, index) =>
    group.items[index % group.items.length];

  const sections = [];
  const usesPerGroup = new Map();

  // Exactly six source-contained sections and two paragraphs per section.
  // A section never mixes source groups; this prevents the model from turning
  // adjacent facts from unrelated official documents into an invented causal
  // or product-integration claim.
  for (let sectionIndex = 0; sectionIndex < 6; sectionIndex++) {
    const group = sourceGroups[sectionIndex % sourceGroups.length];
    const previousUses = usesPerGroup.get(group.key) || 0;
    const first = groupItem(group, previousUses * 2);
    const second = groupItem(group, previousUses * 2 + 1);
    usesPerGroup.set(group.key, previousUses + 1);

    sections.push({
      section_index: sectionIndex,
      source_group: {
        kind: group.kind,
        source_title: group.source_title,
        source_url: group.source_url
      },
      purpose:
        "Explain only the concepts, capabilities, constraints or context documented by this one source group. Keep the two paragraphs source-contained and do not bridge them to another product or document.",
      paragraphs: [
        {
          paragraph_index: 0,
          evidence_ids: idsFromItems(first),
          rule:
            "Stay within this assigned passage. Paraphrase or explain what it explicitly states. Do not add examples, implementation steps, benefits, risks, integrations or future uses that the passage does not state."
        },
        {
          paragraph_index: 1,
          evidence_ids: idsFromItems(second),
          rule:
            "Stay within this assigned passage. Paraphrase or explain what it explicitly states. Do not add examples, implementation steps, benefits, risks, integrations or future uses that the passage does not state."
        }
      ]
    });
  }

  const introItems = sourceGroups.slice(0, 2).map((group) => groupItem(group, 0));
  if (introItems.length === 1 && sourceGroups[0].items.length > 1) {
    introItems.push(groupItem(sourceGroups[0], 1));
  }

  const conclusionItems = sourceGroups.slice(0, 2).map((group) =>
    groupItem(group, Math.max(0, group.items.length - 1))
  );
  if (conclusionItems.length === 1 && sourceGroups[0].items.length > 1) {
    conclusionItems.push(
      groupItem(sourceGroups[0], Math.max(0, sourceGroups[0].items.length - 2))
    );
  }

  const faq = [];
  for (let index = 0; index < 3; index++) {
    const group = sourceGroups[index % sourceGroups.length];
    const item = groupItem(group, index + 1);

    faq.push({
      faq_index: index,
      source_group: {
        kind: group.kind,
        source_title: group.source_title,
        source_url: group.source_url
      },
      evidence_ids: idsFromItems(item),
      rule:
        index === 2
          ? "Use this FAQ to clarify a limitation, distinction or directly documented capability. Do not speculate or introduce another source group."
          : "Answer only what the assigned passage directly supports. Do not introduce another source group."
    });
  }

  return {
    version: 2,
    topic: metadata.topic,
    content_mode: metadata.content_mode,
    global_rules: [
      "Every factual block may use only the evidence IDs assigned to that block.",
      "A citation is not permission to infer beyond the cited passage.",
      "Every section is source-contained. Do not combine its assigned source with facts from another source group.",
      "Do not convert correlation, coexistence or conceptual similarity into a causal relationship.",
      "Do not invent wallet behavior, private-key handling, transaction signing, on-chain settlement, blockchain integration, cryptographic operations or custody behavior unless the assigned passage explicitly states it.",
      "Do not invent future possibilities or roadmap-like claims with phrases such as could later, can later, may eventually, will enable, once users are comfortable, or can help unless that future relationship is explicit in the assigned passage.",
      "Do not claim that one product removes the need for another product unless the assigned passage explicitly says so.",
      "For the intro and conclusion, if evidence from two source groups is assigned, state the source-backed facts separately. Do not claim that one source implements, enables, inherits or solves the concept described by the other source unless the evidence explicitly establishes that relationship.",
      "Use neutral educational language. If the topic wording itself implies more than the evidence proves, narrow the article title and framing to what the evidence actually supports."
    ],
    intro: {
      evidence_ids: idsFromItems(...introItems),
      rule:
        "Introduce the assigned source-backed facts separately. Do not announce an integration, benefit, replacement or causal bridge that the passages do not explicitly establish."
    },
    sections,
    faq,
    conclusion: {
      evidence_ids: idsFromItems(...conclusionItems),
      rule:
        "Summarize the assigned facts separately. Do not predict adoption, price, future integration, reduced friction or technical behavior that is not explicit in the passages."
    }
  };
}

function evidenceBlockPlanForPrompt(plan) {
  const lines = [
    "GLOBAL PLAN RULES:",
    ...plan.global_rules.map((rule) => `- ${rule}`),
    "",
    `INTRO: evidence_ids=${plan.intro.evidence_ids.join(",")}`,
    `INTRO RULE: ${plan.intro.rule}`
  ];

  for (const section of plan.sections) {
    lines.push("");
    lines.push(`SECTION ${section.section_index + 1}: ${section.purpose}`);

    for (const paragraph of section.paragraphs) {
      lines.push(
        `- paragraph ${paragraph.paragraph_index + 1}: evidence_ids=${paragraph.evidence_ids.join(",")}`
      );
      lines.push(`  rule: ${paragraph.rule}`);
    }
  }

  lines.push("");

  for (const item of plan.faq) {
    lines.push(
      `FAQ ${item.faq_index + 1}: evidence_ids=${item.evidence_ids.join(",")}`
    );
    lines.push(`FAQ ${item.faq_index + 1} RULE: ${item.rule}`);
  }

  lines.push("");
  lines.push(`CONCLUSION: evidence_ids=${plan.conclusion.evidence_ids.join(",")}`);
  lines.push(`CONCLUSION RULE: ${plan.conclusion.rule}`);

  return lines.join("\n");
}

function sameEvidenceSet(actual, allowed) {
  const actualSet = new Set(uniqueStrings(actual, 10));
  const allowedSet = new Set(uniqueStrings(allowed, 10));

  if (actualSet.size === 0) return false;

  for (const id of actualSet) {
    if (!allowedSet.has(id)) return false;
  }

  return true;
}

function validateEvidenceBlockPlanCompliance(article, plan) {
  const errors = [];

  if (!sameEvidenceSet(article?.intro?.evidence_ids, plan.intro.evidence_ids)) {
    errors.push("intro uses evidence IDs outside its preassigned evidence block.");
  }

  if ((article?.sections || []).length !== plan.sections.length) {
    errors.push(
      `article has ${(article?.sections || []).length} sections; evidence block plan requires ${plan.sections.length}.`
    );
  }

  for (let s = 0; s < Math.min((article?.sections || []).length, plan.sections.length); s++) {
    const actualSection = article.sections[s];
    const plannedSection = plan.sections[s];

    if ((actualSection?.paragraphs || []).length !== plannedSection.paragraphs.length) {
      errors.push(
        `section ${s + 1} has ${(actualSection?.paragraphs || []).length} paragraphs; plan requires ${plannedSection.paragraphs.length}.`
      );
      continue;
    }

    for (let p = 0; p < plannedSection.paragraphs.length; p++) {
      if (
        !sameEvidenceSet(
          actualSection.paragraphs[p]?.evidence_ids,
          plannedSection.paragraphs[p].evidence_ids
        )
      ) {
        errors.push(
          `section ${s + 1} paragraph ${p + 1} uses evidence IDs outside its preassigned block.`
        );
      }
    }
  }

  if ((article?.faq || []).length !== plan.faq.length) {
    errors.push(
      `article has ${(article?.faq || []).length} FAQ items; evidence block plan requires ${plan.faq.length}.`
    );
  }

  for (let f = 0; f < Math.min((article?.faq || []).length, plan.faq.length); f++) {
    if (!sameEvidenceSet(article.faq[f]?.evidence_ids, plan.faq[f].evidence_ids)) {
      errors.push(`FAQ ${f + 1} uses evidence IDs outside its preassigned block.`);
    }
  }

  if (
    !sameEvidenceSet(
      article?.conclusion?.evidence_ids,
      plan.conclusion.evidence_ids
    )
  ) {
    errors.push("conclusion uses evidence IDs outside its preassigned evidence block.");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                        */
/* -------------------------------------------------------------------------- */

function evidenceForPrompt(evidence) {
  return evidence
    .map((item) => {
      const origin =
        item.kind === "external"
          ? `${item.source_title} | ${item.source_url}`
          : `${item.source_title}`;

      return [
        `[${item.id}]`,
        `TYPE: ${item.kind}`,
        `SOURCE: ${origin}`,
        "PASSAGE:",
        item.text
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function combinedEditorialGuard(metadata, sourceFile) {
  const guards = [];

  if (metadata.editorial_guard) {
    guards.push(metadata.editorial_guard);
  }

  if (metadata.source_profile) {
    const profileId =
      SOURCE_PROFILE_ALIASES[metadata.source_profile] || metadata.source_profile;

    const profileGuard = normalizeSpace(
      sourceFile?.profiles?.[profileId]?.editorial_guard
    );

    if (profileGuard) guards.push(profileGuard);
  }

  guards.push(
    "Never promise profit, token value, exchange listing, partnership, price appreciation or financial return."
  );

  guards.push(
    "Never present planned, UI-only, verify-before-publish or official-UI claims as implemented runtime facts."
  );

  guards.push(
    "The current APXN in-app balance must be called APXN Points unless the evidence explicitly concerns a future or separate token concept."
  );

  return uniqueStrings(guards, 12);
}

function generationInstructions() {
  return [
    "You are the Apex Network Editorial evidence-grounded writer.",
    "Write only from the evidence supplied by the user.",
    "Do not use model memory as a factual source.",
    "Do not browse the web or introduce facts from outside the evidence.",
    "The article must be original, educational, useful to a real reader, and natural rather than keyword-stuffed.",
    "Do not pad sections merely to hit a word target.",
    "Each factual paragraph must cite one or more supplied evidence IDs in evidence_ids.",
    "Follow the EVIDENCE BLOCK PLAN exactly: use only the evidence IDs preassigned to each intro/paragraph/FAQ/conclusion block.",
    "Treat every assigned passage as a hard claim boundary, not as inspiration. Explain and paraphrase what it states; do not invent adjacent use cases, implementation details, technical consequences, future possibilities or product integrations.",
    "Do not bridge two sources into a new claim merely because their concepts seem compatible. If one source describes a platform capability and another describes a Web3 principle, present those facts separately unless the evidence explicitly documents the integration.",
    "Do not claim built-in wallet storage, private-key storage, wallet replacement, transaction signing, on-chain settlement, cryptographic processing or blockchain inheritance unless the assigned passage explicitly states that behavior.",
    "The pre-AI evidence gate has already required a substantial evidence base. Produce a complete schema-compliant draft of at least 1200 useful words when the evidence supports it.",
    "If the evidence still cannot honestly support the required article, set status=insufficient_evidence rather than inventing facts or repeating material; keep every returned field evidence-grounded.",
    "Separate APXN project-specific statements from general technical statements on hybrid topics.",
    "Avoid financial advice, investment recommendations, guaranteed outcomes and promotional hype.",
    "Return only the requested JSON schema."
  ].join("\n");
}

function generationInput({ metadata, evidence, config, guards, blockPlan }) {
  return [
    `TOPIC: ${metadata.topic}`,
    `CATEGORY: ${metadata.category}`,
    `CONTENT MODE: ${metadata.content_mode}`,
    "",
    `WORD REQUIREMENT: minimum ${config.writer.minimum_words}; target ${config.writer.target_words}; maximum ${config.writer.maximum_words}.`,
    "Produce exactly 6 substantive sections, exactly 2 paragraphs per section, and exactly 3 FAQ items. Prefer clarity and depth over repetition.",
    "",
    "EVIDENCE BLOCK PLAN:",
    evidenceBlockPlanForPrompt(blockPlan),
    "",
    "EDITORIAL GUARDS:",
    ...guards.map((guard) => `- ${guard}`),
    "",
    "EVIDENCE:",
    evidenceForPrompt(evidence)
  ].join("\n");
}

function verificationInstructions() {
  return [
    "You are a strict evidence verifier for the Apex Network Editorial pipeline.",
    "Evaluate only whether every factual statement in the supplied article is supported by the assigned evidence IDs.",
    "Use the PREASSIGNED EVIDENCE BLOCK PLAN as an additional hard boundary: a block must not rely on evidence outside the IDs assigned to that block.",
    "Treat causal bridges, future possibilities, implied integrations and implementation details as unsupported unless the assigned passage explicitly states them.",
    "Also check that APXN status distinctions and editorial guards are respected.",
    "Do not browse the web and do not use outside knowledge.",
    "Fail if a paragraph materially exceeds what its evidence supports, contains an unsupported number, or turns planned/UI-only material into a live fact.",
    "Fail if the draft contains investment advice, guaranteed profit/value/listing claims, or deceptive promotional language.",
    "Return only the requested JSON schema."
  ].join("\n");
}

function verificationInput({ metadata, evidence, article, guards, blockPlan }) {
  return [
    `TOPIC: ${metadata.topic}`,
    `CONTENT MODE: ${metadata.content_mode}`,
    "",
    "EDITORIAL GUARDS:",
    ...guards.map((guard) => `- ${guard}`),
    "",
    "PREASSIGNED EVIDENCE BLOCK PLAN:",
    evidenceBlockPlanForPrompt(blockPlan),
    "",
    "EVIDENCE:",
    evidenceForPrompt(evidence),
    "",
    "ARTICLE JSON:",
    JSON.stringify(article)
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Local quality + grounding validation                                       */
/* -------------------------------------------------------------------------- */

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

function articlePlainText(article) {
  return [
    article?.title,
    article?.description,
    article?.intro?.text,
    ...(article?.sections || []).flatMap((section) => [
      section.heading,
      ...(section.paragraphs || []).map((paragraph) => paragraph.text)
    ]),
    ...(article?.faq || []).flatMap((item) => [item.question, item.answer]),
    article?.conclusion?.text
  ]
    .filter(Boolean)
    .join("\n");
}

function numericTokenSupported(token, assignedText) {
  const normalizedToken = normalizeSpace(token).toLowerCase().replace(/,/g, "");
  const normalizedEvidence = normalizeSpace(assignedText)
    .toLowerCase()
    .replace(/,/g, "");

  return normalizedEvidence.includes(normalizedToken);
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

const HIGH_RISK_INFERENCE_PATTERNS = [
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

function unsupportedInferencePatterns(blockText, assignedText) {
  const unsupported = [];

  for (const rule of HIGH_RISK_INFERENCE_PATTERNS) {
    rule.regex.lastIndex = 0;
    const appearsInBlock = rule.regex.test(String(blockText || ""));
    rule.regex.lastIndex = 0;
    const appearsInEvidence = rule.regex.test(String(assignedText || ""));

    if (appearsInBlock && !appearsInEvidence) {
      unsupported.push(rule.name);
    }
  }

  return unsupported;
}

function validateArticleLocal({
  article,
  metadata,
  evidence,
  config
}) {
  const errors = [];
  const evidenceMap = new Map(evidence.map((item) => [item.id, item]));
  const text = articlePlainText(article);
  const words = wordCount(text);

  if (article?.status !== "ready") {
    errors.push(`Generator status is ${article?.status || "missing"}.`);
  }

  if (containsArabicScript(text)) {
    errors.push("Article contains Arabic-script text; blog writer is English-only.");
  }

  if (words < Number(config.writer.minimum_words)) {
    errors.push(
      `Article has ${words} words; minimum is ${config.writer.minimum_words}.`
    );
  }

  if (words > Number(config.writer.maximum_words) + 80) {
    errors.push(
      `Article has ${words} words; maximum is ${config.writer.maximum_words}.`
    );
  }

  if (!normalizeSpace(article.title) || article.title.length > 120) {
    errors.push("Article title is missing or too long.");
  }

  if (
    !normalizeSpace(article.description) ||
    article.description.length < 90 ||
    article.description.length > 180
  ) {
    errors.push("Meta description must be 90-180 characters.");
  }

  if (!Array.isArray(article.keywords) || article.keywords.length < 5) {
    errors.push("Article must contain at least five useful keywords.");
  }

  if (!Array.isArray(article.sections) || article.sections.length < 5) {
    errors.push("Article must contain at least five substantive sections.");
  }

  if (!Array.isArray(article.faq) || article.faq.length < 3) {
    errors.push("Article must contain at least three FAQ items.");
  }

  if (hasDangerousClaims(text)) {
    errors.push("Article contains a prohibited guaranteed/promotional claim.");
  }

  const profileId =
    SOURCE_PROFILE_ALIASES[metadata.source_profile] || metadata.source_profile;

  if (
    profileId &&
    hasVolatileMetricClaims(text)
  ) {
    errors.push("Article contains a volatile metric claim blocked by the source policy.");
  }

  if (["apxn", "hybrid"].includes(metadata.content_mode)) {
    if (/\bcurrent\s+apxn\s+token\s+balance\b/i.test(text)) {
      errors.push("Current in-app balance must be described as APXN Points.");
    }

    if (/\bproof[- ]of[- ]work\s+mining\b/i.test(text)) {
      errors.push("Current APXN Points accumulation must not be called proof-of-work mining.");
    }
  }

  for (const block of allArticleBlocks(article)) {
    const ids = uniqueStrings(block.evidence_ids, 10);

    if (ids.length === 0) {
      errors.push(`${block.label} has no evidence_ids.`);
      continue;
    }

    const unknown = ids.filter((id) => !evidenceMap.has(id));

    if (unknown.length) {
      errors.push(`${block.label} references unknown evidence IDs: ${unknown.join(", ")}.`);
      continue;
    }

    const assignedText = ids
      .map((id) => evidenceMap.get(id).text)
      .join("\n");

    for (const token of numericTokens(block.text)) {
      if (!numericTokenSupported(token, assignedText)) {
        errors.push(
          `${block.label} contains unsupported numeric token "${token}".`
        );
      }
    }

    for (const patternName of unsupportedInferencePatterns(block.text, assignedText)) {
      errors.push(
        `${block.label} contains unsupported high-risk inference pattern: ${patternName}.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    word_count: words
  };
}

/* -------------------------------------------------------------------------- */
/* Duplicate protection                                                       */
/* -------------------------------------------------------------------------- */

function assertNotDuplicate(article, manifest) {
  const candidateTitle = normalizeTopic(article.title);
  const candidateSlug = slugify(article.title);

  for (const existing of Array.isArray(manifest.articles) ? manifest.articles : []) {
    if (normalizeTopic(existing.title) === candidateTitle) {
      fail(`Duplicate article title rejected: ${article.title}`);
    }

    if (slugify(existing.slug || existing.title) === candidateSlug) {
      fail(`Duplicate article slug rejected: ${candidateSlug}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* HTML rendering                                                              */
/* -------------------------------------------------------------------------- */

function evidenceSourceCatalog(evidence) {
  const catalog = [];
  const seen = new Map();

  for (const item of evidence) {
    const key =
      item.kind === "external"
        ? `url:${item.source_url}`
        : `apxn:${item.source_path || item.source_title}`;

    if (!seen.has(key)) {
      const number = catalog.length + 1;
      seen.set(key, number);

      catalog.push({
        number,
        kind: item.kind,
        title: item.source_title,
        url: item.source_url,
        source_path: item.source_path
      });
    }
  }

  return { catalog, seen };
}

function citationMarkup(evidenceIds, evidenceMap, sourceSeen) {
  const numbers = [];

  for (const id of uniqueStrings(evidenceIds, 10)) {
    const item = evidenceMap.get(id);
    if (!item) continue;

    const key =
      item.kind === "external"
        ? `url:${item.source_url}`
        : `apxn:${item.source_path || item.source_title}`;

    const number = sourceSeen.get(key);

    if (number && !numbers.includes(number)) {
      numbers.push(number);
    }
  }

  if (!numbers.length) return "";

  return `<sup class="ml-1 text-yellow-400">${numbers
    .map((number) => `<a href="#source-${number}" aria-label="Source ${number}">[${number}]</a>`)
    .join("")}</sup>`;
}

function renderArticleHtml({
  article,
  metadata,
  evidence,
  config,
  date,
  slug,
  words,
  manifest
}) {
  const baseUrl = String(config.site.base_url || "https://apxn.network").replace(/\/+$/, "");
  const url = `${baseUrl}/blog/articles/${slug}.html`;
  const image = config?.seo?.default_og_image || `${baseUrl}/logo2%20(1).png`;
  const author = config?.site?.author || "Apex Network Editorial";
  const { catalog, seen } = evidenceSourceCatalog(evidence);
  const evidenceMap = new Map(evidence.map((item) => [item.id, item]));

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
    mainEntity: article.faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer
      }
    }))
  };

  const sectionHtml = article.sections
    .map((section) => {
      const paragraphs = section.paragraphs
        .map(
          (paragraph) =>
            `<p>${escapeHtml(paragraph.text)}${citationMarkup(
              paragraph.evidence_ids,
              evidenceMap,
              seen
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
          seen
        )}</p>
      </div>`
    )
    .join("\n");

  const sourcesHtml = catalog
    .map((source) => {
      if (source.kind === "external") {
        return `<li id="source-${source.number}">
          <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(source.title)}
          </a>
          <span class="text-gray-500"> — official external documentation</span>
        </li>`;
      }

      return `<li id="source-${source.number}">
        <strong>${escapeHtml(source.title)}</strong>
        <span class="text-gray-500"> — reviewed APXN implementation knowledge</span>
      </li>`;
    })
    .join("\n");

  const related = (manifest.articles || [])
    .filter((item) => item?.status === "published" && item?.slug !== slug)
    .slice(-3)
    .reverse();

  const relatedHtml = related.length
    ? `<section>
        <h2>Related reading</h2>
        <ul>
          ${related
            .map(
              (item) =>
                `<li><a href="./${escapeHtml(item.slug)}.html">${escapeHtml(item.title)}</a></li>`
            )
            .join("\n")}
        </ul>
      </section>`
    : "";

  const disclaimer =
    metadata.content_mode === "apxn" || metadata.content_mode === "hybrid"
      ? "APXN Points are the current in-app point balance described by the reviewed application logic. This article does not promise future token value, profit, exchange listing or withdrawal value."
      : "This article is educational and does not provide financial, investment or trading advice.";

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>${escapeHtml(article.title)}</title>
  <meta name="description" content="${escapeHtml(article.description)}">
  <meta name="keywords" content="${escapeHtml(article.keywords.join(", "))}">
  <meta name="robots" content="${escapeHtml(config?.seo?.robots || "index, follow")}">
  <meta name="author" content="${escapeHtml(author)}">

  <link rel="canonical" href="${escapeHtml(url)}">
  <link rel="icon" href="../../logo2%20(1).png" type="image/png">

  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(article.title)}">
  <meta property="og:description" content="${escapeHtml(article.description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:site_name" content="${escapeHtml(config?.site?.brand || "Apex Network")}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(article.title)}">
  <meta name="twitter:description" content="${escapeHtml(article.description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">

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

      <div class="flex items-center gap-3">
        <a href="../index.html" class="hidden sm:inline-flex text-sm font-bold text-gray-400 hover:text-yellow-400 transition-colors">Blog Home</a>
        <a href="https://t.me/ApxMinerBot" target="_blank" rel="noopener noreferrer"
           class="bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black text-xs sm:text-sm px-4 sm:px-5 py-3 rounded-xl hover:scale-[1.03] transition-transform">
          Open APXN App
        </a>
      </div>
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
            <span class="text-yellow-400">${escapeHtml(metadata.category)}</span>
          </nav>

          <span class="inline-flex border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-widest mb-5">
            ${escapeHtml(metadata.category)}
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
          <p class="text-lg">${escapeHtml(article.intro.text)}${citationMarkup(
            article.intro.evidence_ids,
            evidenceMap,
            seen
          )}</p>

          ${sectionHtml}

          <section>
            <h2>Frequently asked questions</h2>
            ${faqHtml}
          </section>

          <section>
            <h2>Conclusion</h2>
            <p>${escapeHtml(article.conclusion.text)}${citationMarkup(
              article.conclusion.evidence_ids,
              evidenceMap,
              seen
            )}</p>
          </section>

          ${relatedHtml}

          <section>
            <h2>Sources and methodology</h2>
            <p>
              This article was generated from a restricted evidence set. APXN-specific claims use reviewed project knowledge,
              while general technical claims use only allowlisted official documentation.
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

  const item = bank.topics.find((candidate) => candidate.id === metadata.topic_bank_id);

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
  metadata,
  config,
  date,
  slug,
  words,
  articleId,
  published
}) {
  const baseUrl = String(config.site.base_url || "https://apxn.network").replace(/\/+$/, "");
  const relativePath = `blog/articles/${slug}.html`;
  const url = `${baseUrl}/blog/articles/${slug}.html`;

  return {
    id: articleId,
    slug,
    title: article.title,
    description: article.description,
    category: metadata.category,
    language: "en",
    author: config?.site?.author || "Apex Network Editorial",
    status: published ? "published" : "draft",
    featured: false,
    indexable: published,
    published_at: published ? date : null,
    updated_at: date,
    reading_minutes: readingMinutes(words),
    word_count: words,
    path: relativePath,
    url,
    image:
      config?.seo?.default_og_image ||
      `${baseUrl}/logo2%20(1).png`,
    keywords: uniqueStrings(article.keywords, 10),
    source: "automated_evidence_pipeline",
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    topic_bank_id: metadata.topic_bank_id,
    verified_against_evidence: true,
    seo: {
      canonical: url,
      robots: published ? "index, follow" : "noindex, nofollow",
      article_schema: true,
      faq_schema: true
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Source test                                                                */
/* -------------------------------------------------------------------------- */

async function runSourceTest({ sourceFile }) {
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

  const requested = SOURCE_PROFILE_ALIASES[requestedRaw] || requestedRaw;
  const topic = normalizeSpace(
    process.env.TEST_TOPIC || `Official source test for ${requested}`
  );

  const profile = sourceFile.profiles?.[requested];

  if (!profile) {
    fail(`Unknown source profile in source test: ${requestedRaw}`);
  }

  const metadata = {
    topic,
    category: normalizeSpace(process.env.TEST_CATEGORY || "Education"),
    content_mode: "external",
    source_profile: requested,
    knowledge_sections: [],
    auto_publish_allowed: true,
    editorial_guard: ""
  };

  const result = await collectExternalEvidence(metadata, sourceFile);

  if (!result.ok) {
    fail(result.reason);
  }

  const feasibility = validateEvidenceFeasibility(metadata, result.evidence);

  if (!feasibility.ok) {
    fail(feasibility.reason);
  }

  console.log(`SOURCE TEST PASS: ${requested}`);
  console.log(`Official pages fetched: ${result.fetched_source_count}`);
  console.log(`Evidence passages: ${result.evidence.length}`);
  console.log(`Evidence words: ${totalEvidenceWords(result.evidence)}`);
  console.log("xAI calls: 0");
}

/* -------------------------------------------------------------------------- */
/* Main writer pipeline                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const config = readJson(PATHS.config);
  const knowledge = readJson(PATHS.knowledge);
  const manifest = readJson(PATHS.articles);
  const bank = readJson(PATHS.topicBank);
  const sourceFile = readJson(PATHS.sourceProfiles);
  const costs = ensureCostLedger(readJsonIfExists(PATHS.costs));

  validateConfig(config);
  validateTopicBank(bank, config);
  validateSourceProfiles(sourceFile);
  validateRoutingCompatibility(bank, sourceFile);

  if (isTruthyEnv("BLOG_SOURCE_TEST")) {
    await runSourceTest({ sourceFile });
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

  const apiKey = String(process.env.XAI_API_KEY || "").trim();

  if (!apiKey) {
    fail("XAI_API_KEY is missing.");
  }

  const waiting = sortWaitingQueue(manifest);

  if (waiting.length === 0) {
    fail("No waiting topics are available.");
  }

  const maxAttempts = Math.min(MAX_PRE_AI_TOPIC_ATTEMPTS, waiting.length);
  let lastPreAiReason = "No eligible topic.";
  let selected = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const queueItem = waiting[attempt];
    const metadata = hydrateTopic(queueItem, bank);

    if (!metadata.ok) {
      lastPreAiReason = metadata.reason;

      if (publishRequested) {
        markQueueItem(manifest, queueItem, "skipped_metadata", {
          skipped_at: todayISO(),
          skip_reason: metadata.reason
        });
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

    console.log(`Preparing topic: ${metadata.topic}`);
    console.log(`Content mode: ${metadata.content_mode}`);
    console.log(
      `Source profile: ${metadata.source_profile || "APXN knowledge only"}`
    );

    const evidenceResult = await buildEvidence(metadata, knowledge, sourceFile);

    if (!evidenceResult.ok) {
      lastPreAiReason = evidenceResult.reason;

      console.log(`Safe skip before xAI: ${evidenceResult.reason}`);

      if (publishRequested) {
        markQueueItem(manifest, queueItem, "skipped_insufficient_evidence", {
          skipped_at: todayISO(),
          skip_reason: evidenceResult.reason,
          content_mode: metadata.content_mode,
          source_profile: metadata.source_profile,
          topic_bank_id: metadata.topic_bank_id
        });

        markBankItem(bank, metadata, "needs_evidence", {
          last_evidence_failure: todayISO(),
          last_evidence_failure_reason: evidenceResult.reason
        });
      }

      continue;
    }

    selected = {
      queueItem,
      metadata,
      evidence: evidenceResult.evidence,
      diagnostics: evidenceResult.diagnostics
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

    fail(`No topic passed the pre-AI evidence gate. Last reason: ${lastPreAiReason}`);
  }

  const { queueItem, metadata, evidence, diagnostics } = selected;
  const date = todayISO();
  const provisionalSlug = slugify(metadata.topic);
  const evidenceDiagnostics = compactEvidenceDiagnostics(
    metadata,
    evidence,
    diagnostics
  );

  fs.mkdirSync(PATHS.privateDrafts, { recursive: true });

  const evidenceDiagnosticsPath = path.join(
    PATHS.privateDrafts,
    `${provisionalSlug}.evidence-diagnostics.json`
  );

  writeJson(evidenceDiagnosticsPath, {
    generated_at: date,
    ...evidenceDiagnostics,
    evidence
  });

  console.log(`Evidence items: ${evidenceDiagnostics.totals.evidence_items}`);
  console.log(`Evidence words: ${evidenceDiagnostics.totals.evidence_words}`);
  console.log(
    `External evidence: ${evidenceDiagnostics.totals.external_passages} passage(s), ${evidenceDiagnostics.totals.external_words} words`
  );
  console.log(
    `APXN evidence: ${evidenceDiagnostics.totals.apxn_passages} passage(s), ${evidenceDiagnostics.totals.apxn_words} words`
  );

  if (evidenceDiagnostics.external) {
    console.log(
      `Official pages fetched: ${evidenceDiagnostics.external.fetched_source_count}`
    );
    console.log(
      `Official source fetch errors: ${evidenceDiagnostics.external.fetch_errors.length}`
    );
  }

  console.log(
    `Evidence diagnostics saved: ${path.relative(ROOT, evidenceDiagnosticsPath)}`
  );

  const blockPlan = buildEvidenceBlockPlan(metadata, evidence);
  const blockPlanPath = path.join(
    PATHS.privateDrafts,
    `${provisionalSlug}.evidence-block-plan.json`
  );

  writeJson(blockPlanPath, {
    generated_at: date,
    ...blockPlan
  });

  console.log(
    `Evidence block plan saved: ${path.relative(ROOT, blockPlanPath)}`
  );

  const guards = combinedEditorialGuard(metadata, sourceFile);
  const generationCostReserveUsd = configuredCostReserve(
    config,
    "generation_cost_reserve_usd",
    DEFAULT_GENERATION_COST_RESERVE_USD
  );
  const verifierCostReserveUsd = configuredCostReserve(
    config,
    "verification_cost_reserve_usd",
    DEFAULT_VERIFIER_COST_RESERVE_USD
  );

  assertPaidCallPreflight({
    config,
    costs,
    stage: "generation",
    runCostUsd: 0,
    reserveUsd: generationCostReserveUsd,
    downstreamReserveUsd: verifierCostReserveUsd
  });

  const generation = await callStructuredXai({
    config,
    apiKey,
    instructions: generationInstructions(),
    input: generationInput({
      metadata,
      evidence,
      config,
      guards,
      blockPlan
    }),
    schemaName: "apxn_article",
    schema: ARTICLE_SCHEMA,
    maxOutputTokens: GENERATION_OUTPUT_TOKENS
  });

  const generationCost = appendCostRecord({
    costs,
    responseJson: generation.responseJson,
    stage: "generation",
    topic: metadata.topic,
    slug: provisionalSlug,
    model: generation.model
  });

  assertCostKnown(config, generationCost);

  let runCostUsd = Number(generationCost.cost_usd || 0);
  assertRunCost(config, runCostUsd);

  const rawGenerationPath = path.join(
    PATHS.privateDrafts,
    `${provisionalSlug}.raw-generation.json`
  );

  writeJson(rawGenerationPath, {
    generated_at: date,
    topic: metadata.topic,
    category: metadata.category,
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    model: generation.model,
    response_id: generation.responseJson?.id || null,
    generation_cost_usd: Number(generationCost.cost_usd || 0),
    evidence_block_plan: blockPlan,
    raw_text: generation.rawText,
    parsed: generation.parsed
  });

  console.log(
    `Raw generation saved: ${path.relative(ROOT, rawGenerationPath)}`
  );

  const article = generation.parsed;

  if (article.status !== "ready") {
    const reason =
      normalizeSpace(article.reason) ||
      "Generator reported insufficient evidence.";

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

  const planCompliance = validateEvidenceBlockPlanCompliance(article, blockPlan);

  if (!planCompliance.ok) {
    const reason = `Evidence block plan failed: ${planCompliance.errors.join(" | ")}`;

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

  const local = validateArticleLocal({
    article,
    metadata,
    evidence,
    config
  });

  if (!local.ok) {
    const reason = `Local quality gate failed: ${local.errors.join(" | ")}`;

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

  assertPaidCallPreflight({
    config,
    costs,
    stage: "verification",
    runCostUsd,
    reserveUsd: verifierCostReserveUsd
  });

  const verification = await callStructuredXai({
    config,
    apiKey,
    instructions: verificationInstructions(),
    input: verificationInput({
      metadata,
      evidence,
      article,
      guards,
      blockPlan
    }),
    schemaName: "apxn_article_verification",
    schema: VERIFIER_SCHEMA,
    maxOutputTokens: VERIFIER_OUTPUT_TOKENS
  });

  const verifierCost = appendCostRecord({
    costs,
    responseJson: verification.responseJson,
    stage: "verification",
    topic: metadata.topic,
    slug: slugify(article.title),
    model: verification.model
  });

  assertCostKnown(config, verifierCost);

  runCostUsd += Number(verifierCost.cost_usd || 0);
  assertRunCost(config, runCostUsd);

  const verifier = verification.parsed;

  if (
    verifier.status !== "pass" ||
    (verifier.unsupported_blocks || []).length > 0 ||
    (verifier.policy_issues || []).length > 0
  ) {
    const reason = [
      `Verifier status: ${verifier.status}`,
      ...(verifier.unsupported_blocks || []).map(
        (item) => `unsupported: ${item}`
      ),
      ...(verifier.policy_issues || []).map(
        (item) => `policy: ${item}`
      )
    ].join(" | ");

    if (publishRequested) {
      markQueueItem(manifest, queueItem, "rejected_verifier", {
        rejected_at: date,
        reject_reason: reason
      });

      manifest.last_updated = date;
      refreshStats(manifest);
      writeJson(PATHS.articles, manifest);
    }

    fail(reason);
  }

  const finalSlug = slugify(article.title);

  if (!finalSlug) {
    fail("Generated article title could not produce a valid slug.");
  }

  const html = renderArticleHtml({
    article,
    metadata,
    evidence,
    config,
    date,
    slug: finalSlug,
    words: local.word_count,
    manifest
  });

  const privateHtmlPath = path.join(PATHS.privateDrafts, `${finalSlug}.html`);
  const privateJsonPath = path.join(PATHS.privateDrafts, `${finalSlug}.json`);

  writeText(privateHtmlPath, html);
  writeJson(privateJsonPath, {
    generated_at: date,
    topic: metadata.topic,
    category: metadata.category,
    content_mode: metadata.content_mode,
    source_profile: metadata.source_profile,
    knowledge_sections: metadata.knowledge_sections,
    word_count: local.word_count,
    run_cost_usd: runCostUsd,
    verifier,
    evidence_block_plan: blockPlan,
    evidence_diagnostics: evidenceDiagnostics,
    evidence
  });

  if (!publishRequested) {
    console.log("PRIVATE WRITER TEST PASS");
    console.log(`Draft: ${path.relative(ROOT, privateHtmlPath)}`);
    console.log(`Words: ${local.word_count}`);
    console.log(`Evidence items: ${evidence.length}`);
    console.log(`Exact tracked run cost: $${runCostUsd.toFixed(6)}`);
    return;
  }

  fs.mkdirSync(PATHS.published, { recursive: true });
  const publishedPath = path.join(PATHS.published, `${finalSlug}.html`);
  writeText(publishedPath, html);

  const articleId = nextArticleId(manifest.articles);

  const record = articleManifestRecord({
    article,
    metadata,
    config,
    date,
    slug: finalSlug,
    words: local.word_count,
    articleId,
    published: true
  });

  manifest.articles.push(record);

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
  console.log(`Words: ${local.word_count}`);
  console.log(`Evidence items: ${evidence.length}`);
  console.log(`Official external source pages: ${uniqueExternalSourceCount(evidence)}`);
  console.log(`Exact tracked run cost: $${runCostUsd.toFixed(6)}`);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});



