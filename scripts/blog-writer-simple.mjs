/**
 * APXN Simple Blog Writer — Experimental One-Call Markdown Pipeline
 * Path: scripts/blog-writer-simple.mjs
 *
 * Goal:
 * - Keep the existing production writer untouched.
 * - Reuse scripts/blog-researcher.mjs as the only factual source compiler.
 * - Make exactly one paid Grok call.
 * - Ask Grok for one continuous Markdown article instead of a deeply nested
 *   structured-output article.
 * - Validate the returned Markdown locally for length, structure, citations,
 *   numeric grounding, unsafe claims, duplicate title and obvious repetition.
 * - Save a private draft only. This experimental file NEVER publishes.
 *
 * Default experimental topic:
 *   bank-034 — How Telegram Mini Apps Make Web3 Applications Easier to Access
 *
 * Override with:
 *   SIMPLE_TOPIC_ID=bank-034
 * or:
 *   SIMPLE_TOPIC="exact topic title"
 *
 * Free local self-test:
 *   BLOG_SIMPLE_SELF_TEST=true node scripts/blog-writer-simple.mjs
 *
 * Paid test:
 *   XAI_API_KEY=... node scripts/blog-writer-simple.mjs
 *
 * This file intentionally does not modify blog/index.html, sitemap.xml,
 * data/blog-articles.json, or any published article.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildResearchPacketForTopic,
  loadTopicByIdOrTitle
} from "./blog-researcher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  config: path.join(ROOT, "data", "blog-config.json"),
  articles: path.join(ROOT, "data", "blog-articles.json"),
  topicBank: path.join(ROOT, "data", "blog-topic-bank.json"),
  costs: path.join(ROOT, "data", "blog-costs.json"),
  outputDir: path.join(ROOT, ".workflow-output", "simple-writer")
};

const DEFAULT_TOPIC_SELECTOR = "bank-034";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_ENDPOINT = "/responses";
const DEFAULT_MODEL = "grok-4.3";
const API_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 7_000;
const COST_TICKS_PER_USD = 10_000_000_000;
const DEFAULT_COST_RESERVE_USD = 0.05;
const COST_EPSILON_USD = 0.000000001;
const SIMPLE_MIN_RESEARCH_WORDS = 1000;

function fail(message) {
  throw new Error(message);
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

function wordCount(value) {
  const text = normalizeSpace(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
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

function containsArabicScript(value) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(value || ""));
}

function stripMarkdownSyntax(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function articleWordCount(markdown) {
  return wordCount(stripMarkdownSyntax(markdown));
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
    200
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

function validateConfig(config) {
  if (config?.writer?.enabled !== true) {
    fail("Blog writer is disabled in data/blog-config.json.");
  }

  if (String(config?.site?.default_language || "en").toLowerCase() !== "en") {
    fail("Simple experimental writer is English-only.");
  }

  if (config?.ai?.provider !== "xai") {
    fail('data/blog-config.json must keep ai.provider="xai".');
  }

  if (config?.writer?.allow_external_research !== false) {
    fail("writer.allow_external_research must remain false.");
  }

  const minimum = Number(config?.writer?.minimum_words || 0);
  const target = Number(config?.writer?.target_words || 0);
  const maximum = Number(config?.writer?.maximum_words || 0);

  if (!(minimum >= 1200 && target >= minimum && maximum >= target)) {
    fail("Writer word-count settings are invalid.");
  }
}

function validateTopic(topic) {
  if (!topic || typeof topic !== "object") {
    fail("Topic selector did not resolve to a topic-bank record.");
  }

  if (String(topic.risk || "").toLowerCase() !== "safe") {
    fail(`${topic.topic}: experimental paid writing requires risk=safe.`);
  }

  if (topic.auto_publish_allowed !== true) {
    fail(`${topic.topic}: topic is not approved for automatic content generation.`);
  }

  if (String(topic.content_mode || "").toLowerCase() === "manual") {
    fail(`${topic.topic}: manual topics cannot use the experimental writer.`);
  }

  if (String(topic.status || "").toLowerCase() !== "available") {
    fail(`${topic.topic}: topic status is not available.`);
  }
}

function validateResearchPacket(packet, config) {
  if (!packet || typeof packet !== "object") {
    fail("Researcher returned an invalid packet.");
  }

  if (Number(packet.paid_ai_calls || 0) !== 0) {
    fail("Research stage unexpectedly reports paid AI usage.");
  }

  if (packet.status !== "READY_FOR_PAID_WRITER") {
    const reasons = Array.isArray(packet?.sufficiency?.reasons)
      ? packet.sufficiency.reasons.join(" | ")
      : packet.status;
    fail(`FREE RESEARCH BLOCKED PAID WRITER: ${reasons}`);
  }

  if (packet?.policy?.open_web_research_allowed !== false) {
    fail("Research Packet must explicitly disable open-web research.");
  }

  if (packet?.policy?.model_memory_as_source_allowed !== false) {
    fail("Research Packet must explicitly disable model-memory sourcing.");
  }

  if (packet?.policy?.writer_may_add_facts_outside_packet !== false) {
    fail("Research Packet must explicitly forbid facts outside the packet.");
  }

  const minimumArticleWords = Number(config?.writer?.minimum_words || 1200);
  const configuredResearchMinimum = Number(
    process.env.SIMPLE_MIN_RESEARCH_WORDS || SIMPLE_MIN_RESEARCH_WORDS
  );
  const densityMinimum = Math.max(
    configuredResearchMinimum,
    Math.floor(minimumArticleWords * 0.8)
  );
  const researchWords = Number(packet?.sufficiency?.metrics?.total_words || 0);

  if (researchWords < densityMinimum) {
    fail(
      `FREE RESEARCH DENSITY BLOCK: packet has ${researchWords} evidence words; experimental writer requires at least ${densityMinimum} before a paid call.`
    );
  }

  if (!Array.isArray(packet.evidence) || packet.evidence.length < 6) {
    fail("Research Packet does not contain enough evidence items for the experiment.");
  }
}

function packetEvidenceForPrompt(packet) {
  return (packet.evidence || [])
    .map((item) => {
      const source =
        item.kind === "external"
          ? `${item.source_title} | ${item.source_url}`
          : `${item.source_title}${item.source_path ? ` | ${item.source_path}` : ""}`;

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

function simpleWriterInstructions() {
  return [
    "You are the APXN Blog technical editor.",
    "Write only from the Research Packet included in the user input.",
    "Do not browse, use memory as a factual source, or add outside facts.",
    "Return Markdown only. Do not wrap the answer in a code fence.",
    "Do not return JSON.",
    "Do not include a greeting or commentary before the article.",
    "Use natural, original English suitable for an educational technology blog.",
    "Avoid hype, investment language, predictions, padding and repeated explanations.",
    "Do not invent integrations, examples, statistics, partnerships, listings, prices, wallet behavior, private-key behavior, transaction signing, or on-chain behavior.",
    "Every article section must cite one or more Research Packet evidence IDs using an HTML comment exactly like: <!-- evidence: EXT-01, EXT-02 -->.",
    "Evidence comments are internal provenance markers and must contain only evidence IDs that actually appear in the Research Packet."
  ].join("\n");
}

function simplePrompt(topic, packet, config) {
  const minWords = Number(config.writer.minimum_words || 1200);
  const maxWords = Number(config.writer.maximum_words || 1900);
  const preferredMin = Math.max(minWords + 150, 1400);
  const preferredMax = Math.min(maxWords - 100, 1750);

  return [
    `TOPIC: ${topic.topic}`,
    `CATEGORY: ${topic.category}`,
    `CONTENT MODE: ${topic.content_mode}`,
    topic.editorial_guard
      ? `EDITORIAL GUARD: ${topic.editorial_guard}`
      : "EDITORIAL GUARD: none beyond packet policy.",
    "",
    `LENGTH: Write ${preferredMin}-${preferredMax} article words. The local gate will reject anything below ${minWords} or above ${maxWords}.`,
    "",
    "REQUIRED MARKDOWN SHAPE:",
    `# ${topic.topic}`,
    "",
    "Opening paragraphs that directly explain what the reader will learn.",
    "<!-- evidence: ID, ID -->",
    "",
    "Then use 5 to 8 useful ## sections. Choose sections based on the strongest evidence, not a preset template.",
    "Each ## section should contain enough explanation to be useful, normally 2 to 4 paragraphs.",
    "End every ## section with its own evidence comment.",
    "Include a practical FAQ section only if the packet can support it without repetition.",
    "End with a concise conclusion section and an evidence comment.",
    "",
    "GROUNDING RULES:",
    "- Every factual statement must be supported by the evidence IDs cited for that section.",
    "- You may cite the same evidence item in multiple sections when genuinely relevant.",
    "- You may choose ANY valid evidence ID from the packet; there is no per-section evidence-ID whitelist.",
    "- Do not write a number, date, percentage, version, count or measurement unless that exact numeric fact appears in evidence cited by that section.",
    "- If the evidence is too thin for a claim, omit the claim instead of filling the gap.",
    "- Do not mention the Research Packet, evidence system or these instructions in visible prose.",
    "",
    "FORBIDDEN CLAIMS / GUARDS:",
    ...(packet.forbidden_claims || []).map((item) => `- ${item}`),
    "",
    "APPROVED RESEARCH PACKET EVIDENCE:",
    packetEvidenceForPrompt(packet)
  ].join("\n");
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

async function callXaiOnce({ config, apiKey, prompt }) {
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
    instructions: simpleWriterInstructions(),
    input: prompt,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    truncation: "disabled"
  };

  const effort = String(config?.ai?.reasoning_effort || "none").trim();
  if (effort) body.reasoning = { effort };

  if (
    config?.cost_control?.use_prompt_caching === true &&
    config?.ai?.prompt_cache_key
  ) {
    body.prompt_cache_key = `${String(config.ai.prompt_cache_key)}-simple-markdown-v1`;
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
      fail(`xAI returned non-JSON transport response: ${raw.slice(0, 500)}`);
    }

    if (!response.ok) {
      fail(
        `xAI HTTP ${response.status}: ${JSON.stringify(responseJson).slice(0, 900)}`
      );
    }

    const markdown = extractResponseText(responseJson);
    if (!markdown) {
      fail("xAI response did not contain article text.");
    }

    return { responseJson, markdown, model };
  } finally {
    clearTimeout(timer);
  }
}

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

function costReserve(config) {
  const configured = Number(config?.cost_control?.generation_cost_reserve_usd);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COST_RESERVE_USD;
}

function assertCostPreflight(config, costs) {
  if (config?.cost_control?.enabled !== true) return;

  const reserve = costReserve(config);
  const monthlyBudget = Number(config?.cost_control?.monthly_budget_usd || 0);
  const spent = monthSpendUsd(costs, monthKey());
  const remaining =
    monthlyBudget > 0 ? Math.max(0, monthlyBudget - spent) : Infinity;

  if (
    config?.cost_control?.stop_when_monthly_budget_reached === true &&
    monthlyBudget > 0 &&
    remaining + COST_EPSILON_USD < reserve
  ) {
    fail(
      `Cost preflight blocked simple writer: $${remaining.toFixed(6)} remains, below $${reserve.toFixed(3)} reserve.`
    );
  }

  const perArticle = Number(
    config?.cost_control?.maximum_cost_per_article_usd || 0
  );

  if (perArticle > 0 && perArticle + COST_EPSILON_USD < reserve) {
    fail(
      `Per-article limit $${perArticle.toFixed(3)} is below the $${reserve.toFixed(3)} reserve.`
    );
  }

  console.log(
    `COST PREFLIGHT PASS: one paid call; reserve $${reserve.toFixed(3)}; monthly remaining ${
      Number.isFinite(remaining) ? `$${remaining.toFixed(6)}` : "unlimited"
    }.`
  );
}

function appendCostRecord({ costs, responseJson, topic, slug, model }) {
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
    stage: "simple_markdown_writing",
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

function assertExactAndBoundedCost(config, record) {
  if (
    config?.cost_control?.track_exact_api_cost === true &&
    !Number.isFinite(Number(record?.cost_usd))
  ) {
    fail("xAI did not return exact usage.cost_in_usd_ticks.");
  }

  const max = Number(config?.cost_control?.maximum_cost_per_article_usd || 0);
  if (max > 0 && Number(record?.cost_usd || 0) > max) {
    fail(
      `Simple writer call cost $${Number(record.cost_usd).toFixed(6)} exceeds $${max.toFixed(2)} per-article limit.`
    );
  }
}

function parseEvidenceComment(value) {
  const match = String(value || "").match(
    /<!--\s*evidence\s*:\s*([^>]+?)\s*-->/i
  );

  if (!match) return [];

  return uniqueStrings(
    match[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    30
  );
}

function parseMarkdownSections(markdown) {
  const text = String(markdown || "").replace(/\r/g, "");
  const h1Matches = [...text.matchAll(/^#\s+(.+)$/gm)];

  if (h1Matches.length !== 1) {
    return {
      title: h1Matches.length === 1 ? normalizeSpace(h1Matches[0][1]) : "",
      intro: "",
      sections: [],
      parse_errors: [`Expected exactly one H1 title; found ${h1Matches.length}.`]
    };
  }

  const titleMatch = h1Matches[0];
  const afterTitleIndex = titleMatch.index + titleMatch[0].length;
  const h2Regex = /^##\s+(.+)$/gm;
  const h2Matches = [...text.matchAll(h2Regex)];

  const introEnd = h2Matches.length ? h2Matches[0].index : text.length;
  const intro = text.slice(afterTitleIndex, introEnd).trim();

  const sections = h2Matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end =
      index + 1 < h2Matches.length ? h2Matches[index + 1].index : text.length;
    const raw = text.slice(start, end).trim();
    return {
      heading: normalizeSpace(match[1]),
      raw,
      evidence_ids: parseEvidenceComment(raw),
      visible_text: raw.replace(/<!--[\s\S]*?-->/g, " ").trim()
    };
  });

  return {
    title: normalizeSpace(titleMatch[1]),
    intro,
    intro_evidence_ids: parseEvidenceComment(intro),
    intro_visible_text: intro.replace(/<!--[\s\S]*?-->/g, " ").trim(),
    sections,
    parse_errors: []
  };
}

function evidenceMap(packet) {
  return new Map(
    (packet.evidence || []).map((item) => [String(item.id), item])
  );
}

function evidenceTextForIds(packet, ids) {
  const map = evidenceMap(packet);
  return (ids || [])
    .map((id) => map.get(id)?.text || "")
    .filter(Boolean)
    .join(" ");
}

function invalidEvidenceIds(packet, ids) {
  const map = evidenceMap(packet);
  return (ids || []).filter((id) => !map.has(id));
}

function claimPatterns() {
  return [
    {
      label: "guaranteed profit/value",
      regex: /\b(?:guaranteed?|risk[- ]?free)\b.{0,35}\b(?:profit|return|value|price|gain)\b/i
    },
    {
      label: "unverified listing",
      regex: /\b(?:will|is going to|confirmed to)\s+(?:list|be listed)\b/i
    },
    {
      label: "unverified partnership",
      regex: /\b(?:partnered|partnership|collaboration)\s+with\b/i
    },
    {
      label: "wallet/private-key behavior",
      regex: /\b(?:stores?|holds?|manages?|controls?)\b.{0,45}\b(?:private keys?|seed phrases?|wallet keys?)\b/i
    },
    {
      label: "transaction signing behavior",
      regex: /\b(?:signs?|signing|approves?)\b.{0,35}\b(?:transaction|on-chain transaction)\b/i
    },
    {
      label: "unsupported future certainty",
      regex: /\b(?:will|guaranteed to|certain to)\b.{0,50}\b(?:enable|bring|provide|deliver|support|integrate)\b/i
    }
  ];
}

function highRiskPatternErrors(sectionLabel, visibleText, evidenceText) {
  const errors = [];

  for (const pattern of claimPatterns()) {
    const articleMatch = visibleText.match(pattern.regex);
    if (!articleMatch) continue;

    if (!pattern.regex.test(evidenceText)) {
      errors.push(
        `${sectionLabel} contains high-risk claim pattern "${pattern.label}" not mirrored in its cited evidence.`
      );
    }
  }

  return errors;
}

function repeatedParagraphErrors(markdown) {
  const paragraphs = String(markdown || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(
      (item) =>
        item &&
        !item.startsWith("#") &&
        wordCount(stripMarkdownSyntax(item)) >= 35
    );

  const errors = [];

  for (let i = 0; i < paragraphs.length; i++) {
    for (let j = i + 1; j < paragraphs.length; j++) {
      const similarity = jaccardSimilarity(paragraphs[i], paragraphs[j]);
      if (similarity >= 0.78) {
        errors.push(
          `Paragraphs ${i + 1} and ${j + 1} are too repetitive (Jaccard ${similarity.toFixed(2)}).`
        );
      }
    }
  }

  return errors;
}

function validateMarkdownArticle({
  markdown,
  topic,
  packet,
  config,
  skipRepetitionCheck = false
}) {
  const errors = [];
  const parsed = parseMarkdownSections(markdown);
  errors.push(...parsed.parse_errors);

  const minimum = Number(config?.writer?.minimum_words || 1200);
  const maximum = Number(config?.writer?.maximum_words || 1900);
  const words = articleWordCount(markdown);

  if (words < minimum) {
    errors.push(`Article has ${words} words; minimum is ${minimum}.`);
  }

  if (words > maximum) {
    errors.push(`Article has ${words} words; maximum is ${maximum}.`);
  }

  if (containsArabicScript(markdown)) {
    errors.push("Article contains Arabic script; this blog pipeline is English-only.");
  }

  if (parsed.title) {
    const expected = normalizeTopic(topic.topic);
    const actual = normalizeTopic(parsed.title);
    if (expected !== actual) {
      errors.push(
        `H1 title must match the selected topic exactly. Got "${parsed.title}".`
      );
    }
  }

  if (parsed.sections.length < 5 || parsed.sections.length > 8) {
    errors.push(
      `Article must contain 5-8 H2 sections; found ${parsed.sections.length}.`
    );
  }

  const introWords = wordCount(stripMarkdownSyntax(parsed.intro_visible_text || ""));
  if (introWords < 90) {
    errors.push(`Opening section is too thin (${introWords} words; need at least 90).`);
  }

  const introInvalidIds = invalidEvidenceIds(packet, parsed.intro_evidence_ids);
  if (!parsed.intro_evidence_ids?.length) {
    errors.push("Opening section has no <!-- evidence: ... --> comment.");
  }
  if (introInvalidIds.length) {
    errors.push(`Opening section cites unknown evidence IDs: ${introInvalidIds.join(", ")}.`);
  }

  if (parsed.intro_evidence_ids?.length && introInvalidIds.length === 0) {
    const evidenceText = evidenceTextForIds(packet, parsed.intro_evidence_ids);
    for (const token of numericTokens(parsed.intro_visible_text)) {
      if (!numericTokens(evidenceText).includes(token)) {
        errors.push(
          `Opening section numeric token "${token}" is absent from its cited evidence.`
        );
      }
    }
    errors.push(
      ...highRiskPatternErrors(
        "Opening section",
        parsed.intro_visible_text,
        evidenceText
      )
    );
  }

  parsed.sections.forEach((section, index) => {
    const label = `Section ${index + 1} (${section.heading})`;
    const sectionWords = wordCount(stripMarkdownSyntax(section.visible_text));

    if (sectionWords < 120) {
      errors.push(`${label} is too thin (${sectionWords} words; need at least 120).`);
    }

    if (!section.evidence_ids.length) {
      errors.push(`${label} has no <!-- evidence: ... --> comment.`);
      return;
    }

    const invalidIds = invalidEvidenceIds(packet, section.evidence_ids);
    if (invalidIds.length) {
      errors.push(`${label} cites unknown evidence IDs: ${invalidIds.join(", ")}.`);
      return;
    }

    const evidenceText = evidenceTextForIds(packet, section.evidence_ids);
    const allowedNumeric = new Set(numericTokens(evidenceText));

    for (const token of numericTokens(section.visible_text)) {
      if (!allowedNumeric.has(token)) {
        errors.push(
          `${label} numeric token "${token}" is absent from its cited evidence.`
        );
      }
    }

    errors.push(
      ...highRiskPatternErrors(label, section.visible_text, evidenceText)
    );
  });

  if (/\[[^\]]+\]\((?:https?:\/\/)[^)]+\)/i.test(markdown)) {
    errors.push(
      "Article contains visible external links. The experimental writer should use hidden evidence IDs only; source links will be handled by the publisher later."
    );
  }

  if (!skipRepetitionCheck) {
    errors.push(...repeatedParagraphErrors(markdown));
  }

  const visibleLower = stripMarkdownSyntax(markdown).toLowerCase();
  for (const forbidden of [
    "research packet",
    "evidence id",
    "according to my instructions",
    "as an ai",
    "language model"
  ]) {
    if (visibleLower.includes(forbidden)) {
      errors.push(`Visible article leaks internal pipeline phrase: "${forbidden}".`);
    }
  }

  return {
    ok: errors.length === 0,
    word_count: words,
    title: parsed.title,
    section_count: parsed.sections.length,
    errors
  };
}

function duplicateTitleError(topic, articlesFile) {
  const target = normalizeTopic(topic.topic);
  const duplicate = (articlesFile?.articles || []).find(
    (article) => normalizeTopic(article?.title) === target
  );

  return duplicate
    ? `Duplicate published title already exists: ${duplicate.title}`
    : null;
}

function saveExperimentFiles({ topic, packet, markdown, validation, responseJson, costRecord }) {
  fs.mkdirSync(PATHS.outputDir, { recursive: true });
  const slug = slugify(topic.topic);

  const packetPath = path.join(PATHS.outputDir, `${slug}.research-packet.json`);
  const rawPath = path.join(PATHS.outputDir, `${slug}.raw-response.json`);
  const markdownPath = path.join(PATHS.outputDir, `${slug}.md`);
  const validationPath = path.join(PATHS.outputDir, `${slug}.validation.json`);

  writeJson(packetPath, packet);
  writeJson(rawPath, responseJson);
  writeTextAtomic(markdownPath, `${markdown.trim()}\n`);
  writeJson(validationPath, {
    experiment: "simple_markdown_one_call_v1",
    topic_id: topic.id,
    topic: topic.topic,
    category: topic.category,
    content_mode: topic.content_mode,
    generated_at: todayISO(),
    paid_calls: 1,
    published: false,
    cost: costRecord,
    validation
  });

  return { packetPath, rawPath, markdownPath, validationPath };
}

function runSelfTest() {
  const evidence = Array.from({ length: 8 }, (_, index) => ({
    id: `EXT-${String(index + 1).padStart(2, "0")}`,
    kind: "external",
    source_title: "Official Fixture",
    source_url: "https://example.test/docs",
    text: `Telegram Mini Apps run inside Telegram clients and expose documented interface capabilities for web applications. This fixture passage ${index + 1} discusses interface context, application presentation, platform integration boundaries, and user interaction concepts without adding wallet custody or investment claims.`,
    word_count: 34,
    numeric_tokens: []
  }));

  const packet = {
    evidence,
    forbidden_claims: [],
    policy: {
      open_web_research_allowed: false,
      model_memory_as_source_allowed: false,
      writer_may_add_facts_outside_packet: false
    }
  };

  const topic = {
    id: "fixture",
    topic: "How Telegram Mini Apps Make Web3 Applications Easier to Access",
    category: "Web3",
    content_mode: "external"
  };

  const filler = [
    "The documented platform context gives developers a web application surface inside Telegram while keeping the explanation focused on interface behavior rather than unsupported financial claims.",
    "For readers, the useful distinction is that access and presentation can be discussed from the official interface documentation without assuming how a separate blockchain wallet or transaction system behaves.",
    "This approach keeps the article educational: it explains what the platform exposes, what developers can build around the documented surface, and where the evidence stops.",
    "A careful technical article should separate documented client capabilities from any product-specific implementation that is not explicitly present in the source material."
  ].join(" ");

  const section = (heading, ids) =>
    `## ${heading}\n\n${filler} ${filler}\n\n<!-- evidence: ${ids} -->`;

  const markdown = [
    `# ${topic.topic}`,
    "",
    `${filler} ${filler}`,
    "",
    "<!-- evidence: EXT-01, EXT-02 -->",
    "",
    section("The Mini App surface", "EXT-01, EXT-02"),
    "",
    section("Access inside Telegram", "EXT-02, EXT-03"),
    "",
    section("Interface capabilities", "EXT-03, EXT-04"),
    "",
    section("Development boundaries", "EXT-04, EXT-05"),
    "",
    section("What users should understand", "EXT-05, EXT-06"),
    "",
    section("Conclusion", "EXT-07, EXT-08")
  ].join("\n");

  const config = {
    writer: {
      minimum_words: 900,
      maximum_words: 1900
    }
  };

  const result = validateMarkdownArticle({
    markdown,
    topic,
    packet,
    config,
    skipRepetitionCheck: true
  });

  if (!result.ok) {
    fail(`SELF TEST FAILED: ${result.errors.join(" | ")}`);
  }

  const bad = markdown.replace(
    "<!-- evidence: EXT-03, EXT-04 -->",
    "<!-- evidence: DOES-NOT-EXIST -->"
  );

  const badResult = validateMarkdownArticle({
    markdown: bad,
    topic,
    packet,
    config,
    skipRepetitionCheck: true
  });

  if (badResult.ok || !badResult.errors.some((item) => item.includes("unknown evidence IDs"))) {
    fail("SELF TEST FAILED: invalid evidence ID was not rejected.");
  }

  console.log("APXN SIMPLE WRITER SELF TEST PASS");
  console.log(`Fixture words: ${result.word_count}`);
  console.log("Paid AI calls: 0");
}

async function main() {
  if (
    ["1", "true", "yes", "on"].includes(
      String(process.env.BLOG_SIMPLE_SELF_TEST || "").trim().toLowerCase()
    )
  ) {
    runSelfTest();
    return;
  }

  const config = readJson(PATHS.config);
  const topicBank = readJson(PATHS.topicBank);
  const articlesFile = readJson(PATHS.articles);
  const costs = ensureCostLedger(readJsonIfExists(PATHS.costs));

  validateConfig(config);

  const selector = normalizeSpace(
    process.env.SIMPLE_TOPIC_ID ||
      process.env.SIMPLE_TOPIC ||
      DEFAULT_TOPIC_SELECTOR
  );

  const topic = loadTopicByIdOrTitle(selector, topicBank);
  validateTopic(topic);

  const duplicateError = duplicateTitleError(topic, articlesFile);
  if (duplicateError) fail(duplicateError);

  console.log("APXN SIMPLE BLOG WRITER — EXPERIMENT");
  console.log("------------------------------------");
  console.log(`Topic: ${topic.topic}`);
  console.log(`Topic ID: ${topic.id}`);
  console.log(`Content mode: ${topic.content_mode}`);
  console.log("Publishing: HARD DISABLED in this experimental file");
  console.log("Paid calls before research: 0");

  const packet = await buildResearchPacketForTopic(topic);
  validateResearchPacket(packet, config);

  const slug = slugify(topic.topic);
  fs.mkdirSync(PATHS.outputDir, { recursive: true });
  writeJson(
    path.join(PATHS.outputDir, `${slug}.research-packet.json`),
    packet
  );

  console.log("FREE RESEARCH PASS");
  console.log(`Evidence items: ${packet.evidence.length}`);
  console.log(
    `Evidence words: ${Number(packet?.sufficiency?.metrics?.total_words || 0)}`
  );
  console.log(
    `Distinct external pages: ${Number(
      packet?.sufficiency?.metrics?.distinct_external_pages || 0
    )}`
  );
  console.log("Paid calls so far: 0");

  assertCostPreflight(config, costs);

  const prompt = simplePrompt(topic, packet, config);
  const generation = await callXaiOnce({
    config,
    apiKey: process.env.XAI_API_KEY,
    prompt
  });

  const costRecord = appendCostRecord({
    costs,
    responseJson: generation.responseJson,
    topic: topic.topic,
    slug,
    model: generation.model
  });

  assertExactAndBoundedCost(config, costRecord);

  const validation = validateMarkdownArticle({
    markdown: generation.markdown,
    topic,
    packet,
    config
  });

  const files = saveExperimentFiles({
    topic,
    packet,
    markdown: generation.markdown,
    validation,
    responseJson: generation.responseJson,
    costRecord
  });

  console.log(`Paid calls: 1`);
  console.log(
    `Exact call cost: ${
      Number.isFinite(Number(costRecord.cost_usd))
        ? `$${Number(costRecord.cost_usd).toFixed(8)}`
        : "unknown"
    }`
  );
  console.log(`Article words: ${validation.word_count}`);
  console.log(`H2 sections: ${validation.section_count}`);
  console.log(`Draft Markdown: ${path.relative(ROOT, files.markdownPath)}`);
  console.log(`Validation: ${path.relative(ROOT, files.validationPath)}`);
  console.log("Published: NO");

  if (!validation.ok) {
    fail(`FREE LOCAL GATE FAILED: ${validation.errors.join(" | ")}`);
  }

  console.log("SIMPLE WRITER PASS");
  console.log("Private Markdown draft is ready for human inspection.");
}

main().catch((error) => {
  console.error("");
  console.error(`ERROR: ${error?.message || error}`);
  process.exitCode = 1;
});

