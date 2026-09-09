/**
 * APXN Blog AI Writer — Direct Official Sources Pipeline
 * Path: scripts/blog-writer.mjs
 *
 * Design goals:
 * - English-only automated articles.
 * - APXN topics use the reviewed internal APXN knowledge file.
 * - External topics fetch a small curated set of official pages directly with Node.js.
 * - xAI Web Search is NOT used. Official page retrieval itself does not consume xAI API tokens.
 * - Grok extracts atomic evidence only from supplied official excerpts.
 * - Every body paragraph and FAQ answer is mapped to evidence BEFORE verification.
 * - Local checks reject invented numbers and unknown evidence IDs.
 * - One compact paragraph-level verifier checks the final text against assigned evidence.
 * - At most one evidence-grounded rewrite is allowed, followed by mandatory fresh verification.
 * - Publication is allowed only after local checks + fresh verification pass + cost checks.
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
const API_TIMEOUT_MS = 180_000;
const SOURCE_FETCH_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 700_000;
const MAX_EXCERPT_CHARS = 2_000;
const MAX_TOTAL_EXCERPT_CHARS = 24_000;
const MAX_EXCERPTS_PER_SOURCE = 3;
const MIN_EXTERNAL_EVIDENCE_FACTS = 8;
const MAX_EXTERNAL_EVIDENCE_FACTS = 18;
const EVIDENCE_OUTPUT_TOKENS = 2_200;
const ARTICLE_OUTPUT_TOKENS = 5_400;
const VERIFIER_OUTPUT_TOKENS = 2_400;
const MAX_REWRITE_ROUNDS = 1;
const MAX_PRODUCTION_TOPIC_ATTEMPTS = 3;
const MAX_TEST_TOPIC_ATTEMPTS = 1;
const MIN_REWRITE_RESERVE_USD = 0.020;

const SOURCE_PROFILES = {
  bsc: {
    name: "BNB Smart Chain",
    minSources: 2,
    keywords: [
      "bnb smart chain", "bsc", "bep-20", "bep20", "gas", "transaction fee",
      "validator", "posa", "evm", "finality", "block time", "bnb", "token standard",
      "transfer", "approve", "allowance"
    ],
    sources: [
      {
        title: "BNB Smart Chain Introduction",
        url: "https://docs.bnbchain.org/bnb-smart-chain/introduction/"
      },
      {
        title: "BNB Smart Chain Overview",
        url: "https://docs.bnbchain.org/bnb-smart-chain/overview/"
      },
      {
        title: "BNB Smart Chain Quick Guide",
        url: "https://docs.bnbchain.org/bnb-smart-chain/developers/quick-guide/"
      },
      {
        title: "BEP-20 Specification — official BNB Chain repository",
        url: "https://raw.githubusercontent.com/bnb-chain/BEPs/master/BEPs/BEP20.md"
      }
    ]
  },

  telegram_auth: {
    name: "Telegram Mini App authentication",
    minSources: 1,
    keywords: [
      "telegram mini apps", "initdata", "init data", "validating data", "hash",
      "hmac", "auth_date", "bot token", "webappdata", "authorization", "signature",
      "third-party validation"
    ],
    sources: [
      {
        title: "Telegram Mini Apps",
        url: "https://core.telegram.org/bots/webapps"
      }
    ]
  },

  telegram_web3: {
    name: "Telegram Mini Apps and Web3",
    minSources: 2,
    keywords: [
      "telegram mini apps", "javascript", "authorization", "payments", "web3",
      "decentralized", "ownership", "wallet", "dapp", "blockchain", "identity"
    ],
    sources: [
      {
        title: "Telegram Mini Apps",
        url: "https://core.telegram.org/bots/webapps"
      },
      {
        title: "Introduction to Web3",
        url: "https://ethereum.org/web3/"
      },
      {
        title: "Ethereum Development Documentation",
        url: "https://ethereum.org/developers/docs/"
      }
    ]
  },

  security: {
    name: "Web3 and account security",
    minSources: 2,
    keywords: [
      "phishing", "password", "password manager", "mfa", "multifactor authentication",
      "software updates", "private key", "wallet", "account", "authentication", "security",
      "seed", "recovery", "credential", "sign"
    ],
    sources: [
      {
        title: "CISA — Four Cybersecurity Essentials",
        url: "https://www.cisa.gov/resources-tools/resources/four-cybersecurity-essentials-sltts"
      },
      {
        title: "CISA — Turn On MFA",
        url: "https://www.cisa.gov/secure-our-world/turn-mfa"
      },
      {
        title: "CISA — Password Manager Guidance",
        url: "https://www.cisa.gov/resources-tools/training/cyb3rsmrt-use-password-manager-create-and-remember-strong-passwords"
      },
      {
        title: "Ethereum Accounts",
        url: "https://ethereum.org/developers/docs/accounts"
      }
    ]
  },

  blockchain: {
    name: "Blockchain fundamentals",
    minSources: 2,
    keywords: [
      "blockchain", "blocks", "transactions", "accounts", "validator", "consensus",
      "state", "hash", "proof of stake", "gas", "smart contract", "decentralized"
    ],
    sources: [
      {
        title: "Technical Introduction to Ethereum",
        url: "https://ethereum.org/developers/docs/intro-to-ethereum/"
      },
      {
        title: "Ethereum Blocks",
        url: "https://ethereum.org/developers/docs/blocks/"
      },
      {
        title: "Ethereum Transactions",
        url: "https://ethereum.org/developers/docs/transactions"
      },
      {
        title: "Ethereum Accounts",
        url: "https://ethereum.org/developers/docs/accounts"
      }
    ]
  },

  ethereum: {
    name: "Ethereum",
    minSources: 2,
    keywords: [
      "ethereum", "ether", "eth", "account", "transaction", "gas", "smart contract",
      "evm", "block", "validator", "proof of stake", "dapp"
    ],
    sources: [
      {
        title: "What Is Ethereum?",
        url: "https://ethereum.org/what-is-ethereum/"
      },
      {
        title: "Ethereum Development Documentation",
        url: "https://ethereum.org/developers/docs/"
      },
      {
        title: "Ethereum Transactions",
        url: "https://ethereum.org/developers/docs/transactions"
      },
      {
        title: "Ethereum Accounts",
        url: "https://ethereum.org/developers/docs/accounts"
      }
    ]
  },

  web3: {
    name: "Web3",
    minSources: 1,
    keywords: [
      "web3", "decentralized", "permissionless", "ownership", "wallet", "dapp",
      "blockchain", "cryptocurrency", "identity", "native payments", "trustless"
    ],
    sources: [
      {
        title: "Introduction to Web3",
        url: "https://ethereum.org/web3/"
      },
      {
        title: "Ethereum Development Documentation",
        url: "https://ethereum.org/developers/docs/"
      }
    ]
  }
};

/* -------------------------------------------------------------------------- */
/* Basic utilities                                                            */
/* -------------------------------------------------------------------------- */

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) fail(`Required file not found: ${path.relative(ROOT, filePath)}`);
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

function uniqueStrings(values, max = 20) {
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
  return clean ? clean.split(/\s+/).filter(Boolean).length : 0;
}

function readingMinutes(words) {
  return Math.max(1, Math.ceil(words / 220));
}

function containsArabicScript(value) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(value || ""));
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
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

function numericTokens(value) {
  const text = String(value || "").toLowerCase();
  const matches = text.match(/(?:[$€£]\s*)?\b\d+(?:[.,]\d+)?(?:\s*%|\s*(?:gwei|wei|bnb|eth|usdt|seconds?|minutes?|hours?|days?|weeks?|months?|years?|blocks?|validators?|transactions?))?/gi) || [];
  return uniqueStrings(matches.map((item) => normalizeSpace(item).toLowerCase().replace(/,/g, "")), 40);
}

function normalizeComparable(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[^a-z0-9$€£%+./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteIsPresent(quote, sourceText) {
  const q = normalizeComparable(quote);
  const s = normalizeComparable(sourceText);
  return q.length >= 24 && s.includes(q);
}

/* -------------------------------------------------------------------------- */
/* Configuration and topic selection                                          */
/* -------------------------------------------------------------------------- */

function validateConfig(config) {
  if (config?.writer?.enabled !== true) fail("AI writer is disabled in data/blog-config.json.");
  if (config?.ai?.provider !== "xai") fail('blog-config.json must set ai.provider to "xai".');
  if (String(config?.site?.default_language || "en").toLowerCase() !== "en") {
    fail("APXN Blog Writer is English-only.");
  }
  const min = Number(config?.writer?.minimum_words || 1200);
  const target = Number(config?.writer?.target_words || 1500);
  const max = Number(config?.writer?.maximum_words || 1900);
  if (!(min > 0 && target >= min && max >= target)) fail("Invalid writer word-count settings.");
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest?.articles)) fail("data/blog-articles.json is missing articles[].");
  if (!Array.isArray(manifest?.generation_queue)) fail("data/blog-articles.json is missing generation_queue[].");
}

function isApXnSpecificTopic(topic) {
  const text = `${topic?.topic || ""} ${topic?.category || ""}`.toLowerCase();
  return /\bapxn\b|\bapex network\b/.test(text) || /^apxn\b/i.test(String(topic?.category || ""));
}

function profileForTopic(topic) {
  if (isApXnSpecificTopic(topic)) return null;
  const text = `${topic?.topic || ""} ${topic?.category || ""}`.toLowerCase();

  if (/\b(bsc|bnb smart chain|bnb chain|bep-?20|gas fee)\b/.test(text)) return SOURCE_PROFILES.bsc;
  if (/\btelegram\b/.test(text) && /\b(initdata|authentication|auth|verification)\b/.test(text)) return SOURCE_PROFILES.telegram_auth;
  if (/\b(security|phishing|private key|seed phrase|password|mfa|wallet security|account security)\b/.test(text)) return SOURCE_PROFILES.security;
  if (/\btelegram\b/.test(text)) return SOURCE_PROFILES.telegram_web3;
  if (/\b(ethereum|evm|smart contract|solidity)\b/.test(text)) return SOURCE_PROFILES.ethereum;
  if (/\b(blockchain|blocks|transactions|consensus)\b/.test(text)) return SOURCE_PROFILES.blockchain;
  if (/\b(web3|decentralized|dapp|dapps)\b/.test(text)) return SOURCE_PROFILES.web3;
  return null;
}

function detectDuplicateTopic(topic, manifest) {
  const topicText = normalizeSpace(topic).toLowerCase();
  const topicSlug = slugify(topicText);
  return manifest.articles.find((article) => {
    const title = normalizeSpace(article?.title).toLowerCase();
    const slug = slugify(article?.slug || article?.title || "");
    return title === topicText || slug === topicSlug;
  }) || null;
}

function chooseNextTopic(manifest) {
  const waiting = manifest.generation_queue
    .filter((item) => item?.status === "waiting")
    .sort((a, b) => Number(a.priority || 9999) - Number(b.priority || 9999));

  for (const item of waiting) {
    const language = String(item?.language || "en").toLowerCase();
    if (language !== "en") continue;
    if (detectDuplicateTopic(item.topic, manifest)) continue;
    if (!isApXnSpecificTopic(item) && !profileForTopic(item)) continue;
    return item;
  }
  fail("No eligible waiting topic has a supported evidence profile.");
}

/* -------------------------------------------------------------------------- */
/* Free direct retrieval from official pages                                  */
/* -------------------------------------------------------------------------- */

function decodeHtmlEntities(text) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'",
    rdquo: '"', ldquo: '"', middot: "·"
  };

  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function htmlToText(html) {
  let text = String(html || "");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|svg|noscript|template)[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre)>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchOneOfficialSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "APXN-Blog-Research/1.0 (+https://apxn.network)",
        "Accept": "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.2"
      },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_SOURCE_BYTES) throw new Error(`source too large (${length} bytes)`);

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const raw = await response.text();
    if (raw.length > MAX_SOURCE_BYTES) throw new Error(`source body too large (${raw.length} chars)`);

    const text = contentType.includes("html") ? htmlToText(raw) : decodeHtmlEntities(raw);
    if (normalizeSpace(text).length < 300) throw new Error("not enough readable source text");

    return {
      title: source.title,
      url: source.url,
      domain: hostnameOf(source.url),
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

function topicKeywords(queueItem, profile) {
  const stop = new Set([
    "what", "is", "are", "the", "and", "or", "to", "for", "how", "why", "with",
    "from", "into", "understanding", "explained", "beginners", "bringing", "everyday",
    "users", "basics", "protecting", "your", "works", "work"
  ]);
  const words = `${queueItem.topic} ${queueItem.category}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !stop.has(word));
  return uniqueStrings([...(profile?.keywords || []), ...words], 40);
}

function chunkSourceText(text, maxChars = 1_700) {
  const blocks = String(text || "")
    .split(/\n{2,}|(?=^#{1,4}\s)/m)
    .map((part) => normalizeSpace(part))
    .filter((part) => part.length >= 60);

  const chunks = [];
  let current = "";
  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    if (current.length + 2 + block.length <= maxChars) {
      current += `\n${block}`;
    } else {
      chunks.push(current.slice(0, maxChars));
      current = block;
    }
  }
  if (current) chunks.push(current.slice(0, maxChars));
  return chunks;
}

function scoreChunk(chunk, keywords) {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const term = keyword.toLowerCase();
    if (!term) continue;
    let index = 0;
    let count = 0;
    while ((index = lower.indexOf(term, index)) !== -1) {
      count += 1;
      index += Math.max(1, term.length);
      if (count >= 4) break;
    }
    score += count * (term.includes(" ") ? 4 : 2);
  }
  if (/\b(?:fee|gas|validator|transaction|security|authentication|standard|block|wallet|token)\b/i.test(chunk)) score += 2;
  if (/\b\d+(?:\.\d+)?\b/.test(chunk)) score += 1;
  return score;
}

function selectRelevantExcerpts(fetchedSources, queueItem, profile) {
  const keywords = topicKeywords(queueItem, profile);
  const selected = [];

  for (const source of fetchedSources) {
    const chunks = chunkSourceText(source.text);
    const ranked = chunks
      .map((text, index) => ({ text, index, score: scoreChunk(text, keywords) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, MAX_EXCERPTS_PER_SOURCE);

    for (const item of ranked) {
      selected.push({
        source_url: source.url,
        source_title: source.title,
        domain: source.domain,
        excerpt: item.text.slice(0, MAX_EXCERPT_CHARS),
        score: item.score
      });
    }
  }

  selected.sort((a, b) => b.score - a.score);
  const final = [];
  const perSource = new Map();
  let totalChars = 0;

  for (const item of selected) {
    const count = perSource.get(item.source_url) || 0;
    if (count >= MAX_EXCERPTS_PER_SOURCE) continue;
    if (totalChars + item.excerpt.length > MAX_TOTAL_EXCERPT_CHARS && final.length >= 6) continue;
    final.push(item);
    perSource.set(item.source_url, count + 1);
    totalChars += item.excerpt.length;
    if (totalChars >= MAX_TOTAL_EXCERPT_CHARS) break;
  }
  return final;
}

async function buildDirectSourceBundle(queueItem, profile) {
  const settled = await Promise.allSettled(profile.sources.map(fetchOneOfficialSource));
  const fetched = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      fetched.push(result.value);
    } else {
      console.warn(`Official source fetch failed: ${profile.sources[i].url} — ${result.reason?.message || result.reason}`);
    }
  }

  if (fetched.length < profile.minSources) {
    fail(`Only ${fetched.length} official source page(s) could be fetched; ${profile.minSources} required for ${profile.name}.`);
  }

  const excerpts = selectRelevantExcerpts(fetched, queueItem, profile);
  const sourceUrls = new Set(excerpts.map((item) => item.source_url));
  if (sourceUrls.size < profile.minSources) {
    fail(`Relevant excerpts came from only ${sourceUrls.size} official source page(s); ${profile.minSources} required.`);
  }

  return {
    profile: profile.name,
    sources: fetched.map(({ text, ...source }) => source),
    fullTextByUrl: new Map(fetched.map((source) => [source.url, source.text])),
    excerpts
  };
}

/* -------------------------------------------------------------------------- */
/* xAI structured-output client                                               */
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
  const text = String(rawText || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)); } catch {}
    }
  }
  fail("Grok returned invalid JSON.");
}

function resolveXaiEndpoint(config) {
  const base = String(config?.ai?.api_base_url || DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
  const endpoint = String(config?.ai?.responses_endpoint || "/responses");
  return `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

async function callStructuredXAI({ apiKey, model, config, instructions, input, schema, schemaName, maxOutputTokens }) {
  const body = {
    model,
    input: [
      { role: "system", content: instructions },
      { role: "user", content: input }
    ],
    max_output_tokens: maxOutputTokens,
    store: false,
    truncation: "disabled",
    text: {
      format: { type: "json_schema", name: schemaName, schema, strict: true }
    }
  };

  const effort = String(config?.ai?.reasoning_effort || "none").trim();
  if (effort) body.reasoning = { effort };
  if (config?.cost_control?.use_prompt_caching === true && config?.ai?.prompt_cache_key) {
    body.prompt_cache_key = String(config.ai.prompt_cache_key);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(resolveXaiEndpoint(config), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") fail("xAI request timed out.");
    fail(`xAI request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { fail(`xAI returned non-JSON HTTP ${response.status}.`); }
  if (!response.ok) fail(data?.error?.message || data?.message || `xAI HTTP ${response.status}.`);
  if (data?.status && data.status !== "completed") {
    fail(`xAI response incomplete: ${data?.incomplete_details?.reason || data.status}.`);
  }
  const output = extractResponseText(data);
  if (!output) fail("xAI returned no structured output.");
  return { response: data, generated: parseGeneratedJson(output) };
}

/* -------------------------------------------------------------------------- */
/* Cost control                                                               */
/* -------------------------------------------------------------------------- */

function readCostLedger() {
  return readJsonIfExists(PATHS.costs) || {
    schema_version: 1,
    provider: "xai",
    currency: "USD",
    months: {}
  };
}

function monthlySpend(ledger, month = monthKey()) {
  const rows = Array.isArray(ledger?.months?.[month]?.requests) ? ledger.months[month].requests : [];
  return rows.reduce((sum, row) => sum + (Number.isFinite(Number(row?.cost_usd)) ? Number(row.cost_usd) : 0), 0);
}

function responseCost(responseJson) {
  const ticks = Number(responseJson?.usage?.cost_in_usd_ticks);
  if (!Number.isFinite(ticks) || ticks < 0) return { ticks: null, usd: null };
  return { ticks, usd: ticks / COST_TICKS_PER_USD };
}

function recordCost({ ledger, response, model, topic, articleSlug, date, stage }) {
  const month = monthKey(date);
  ledger.months = ledger.months || {};
  ledger.months[month] = ledger.months[month] || { requests: [] };
  const cost = responseCost(response);
  const entry = {
    date,
    response_id: response?.id || null,
    model,
    topic,
    article_slug: articleSlug || null,
    stage,
    input_tokens: Number(response?.usage?.input_tokens || 0),
    cached_input_tokens: Number(response?.usage?.input_tokens_details?.cached_tokens || 0),
    output_tokens: Number(response?.usage?.output_tokens || 0),
    reasoning_tokens: Number(response?.usage?.output_tokens_details?.reasoning_tokens || 0),
    total_tokens: Number(response?.usage?.total_tokens || 0),
    server_side_tools_used: 0,
    web_research_enabled: false,
    web_source_count: 0,
    cost_in_usd_ticks: cost.ticks,
    cost_usd: cost.usd
  };
  ledger.months[month].requests.push(entry);
  ledger.months[month].total_cost_usd = monthlySpend(ledger, month);
  ledger.last_updated = date;
  return entry;
}

function topicSpend(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((sum, row) => sum + (Number(row?.cost_usd) || 0), 0);
}

function ensureMonthlyBudget(config, ledger) {
  const control = config?.cost_control || {};
  if (control.enabled !== true) return;
  const budget = Number(control.monthly_budget_usd || 0);
  const perArticle = Number(control.maximum_cost_per_article_usd || 0);
  const spent = monthlySpend(ledger);
  if (budget > 0 && control.stop_when_monthly_budget_reached === true && spent >= budget) {
    fail(`Monthly xAI budget reached: $${spent.toFixed(4)} of $${budget.toFixed(2)}.`);
  }
  if (budget > 0 && perArticle > 0 && control.stop_when_monthly_budget_reached === true && spent + perArticle > budget) {
    fail(`Monthly budget reserve blocks another article: $${spent.toFixed(4)} spent, $${perArticle.toFixed(2)} reserved, budget $${budget.toFixed(2)}.`);
  }
}

function withinPerArticleBudget(config, entries, reserve = 0) {
  const max = Number(config?.cost_control?.maximum_cost_per_article_usd || 0);
  return !(max > 0) || topicSpend(entries) + reserve <= max;
}

/* -------------------------------------------------------------------------- */
/* Evidence extraction and deterministic grounding                            */
/* -------------------------------------------------------------------------- */

function evidenceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["facts", "warnings"],
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "claim", "kind", "source_url", "support_quote"],
          properties: {
            id: { type: "string" },
            claim: { type: "string" },
            kind: { type: "string", enum: ["technical", "numeric", "security", "historical", "current_status", "general"] },
            source_url: { type: "string" },
            support_quote: { type: "string" }
          }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function evidenceInstructions(queueItem, profile) {
  return `
You are an evidence extractor, not an article writer.
You receive selected excerpts fetched DIRECTLY from official sources for the topic "${queueItem.topic}".

STRICT RULES:
- Use ONLY the supplied source excerpts. Never use memory or outside knowledge.
- Produce ${MIN_EXTERNAL_EVIDENCE_FACTS}-${MAX_EXTERNAL_EVIDENCE_FACTS} useful ATOMIC facts when the excerpts support them.
- Each fact must contain exactly one material claim.
- support_quote must be copied VERBATIM from one supplied excerpt and should normally be 30-220 characters.
- source_url must exactly match the URL attached to that excerpt.
- If a number appears in claim, the same number and context must appear in support_quote.
- Do not infer causal mechanisms, user recommendations, fee behavior, bridge behavior, wallet safety, validator behavior, or current status unless the excerpt explicitly supports it.
- Prefer facts that together can support a complete beginner guide: definition, mechanics, terminology, standards, fees/performance when documented, limitations, and safe-use guidance when documented.
- Do not combine facts from separate excerpts into one claim.
- IDs should be E01, E02, E03 ...
- Return JSON only.

Source profile: ${profile.name}
Current date: ${todayISO()}
`.trim();
}

function normalizeEvidence(raw, sourceBundle) {
  const validUrls = new Set(sourceBundle.excerpts.map((item) => item.source_url));
  const sourceTextByUrl = sourceBundle.fullTextByUrl;
  const seenClaims = new Set();
  const facts = [];

  for (const item of Array.isArray(raw?.facts) ? raw.facts : []) {
    const claim = normalizeSpace(item?.claim);
    const sourceUrl = normalizeSpace(item?.source_url);
    const quote = normalizeSpace(item?.support_quote);
    if (!claim || !sourceUrl || !quote || !validUrls.has(sourceUrl)) continue;
    const fullText = sourceTextByUrl.get(sourceUrl) || "";
    if (!quoteIsPresent(quote, fullText)) continue;

    const claimNums = numericTokens(claim);
    const quoteComparable = normalizeComparable(quote).replace(/,/g, "");
    if (claimNums.some((token) => !quoteComparable.includes(normalizeComparable(token)))) continue;

    const key = slugify(claim);
    if (!key || seenClaims.has(key)) continue;
    seenClaims.add(key);

    facts.push({
      id: `E${String(facts.length + 1).padStart(2, "0")}`,
      claim,
      kind: ["technical", "numeric", "security", "historical", "current_status", "general"].includes(item?.kind) ? item.kind : "general",
      source_url: sourceUrl,
      support_quote: quote
    });
    if (facts.length >= MAX_EXTERNAL_EVIDENCE_FACTS) break;
  }

  const sourceUrls = uniqueStrings(facts.map((fact) => fact.source_url), 12);
  const sourceInfo = sourceBundle.sources.filter((source) => sourceUrls.includes(source.url));
  return {
    as_of_date: todayISO(),
    facts,
    sources: sourceInfo,
    warnings: uniqueStrings(raw?.warnings, 12)
  };
}

async function extractEvidence({ apiKey, model, config, queueItem, profile, sourceBundle }) {
  const input = JSON.stringify({
    topic: queueItem.topic,
    category: queueItem.category,
    excerpts: sourceBundle.excerpts.map(({ score, ...item }) => item)
  }, null, 2);

  const result = await callStructuredXAI({
    apiKey,
    model,
    config,
    instructions: evidenceInstructions(queueItem, profile),
    input,
    schema: evidenceSchema(),
    schemaName: "apxn_direct_official_evidence",
    maxOutputTokens: EVIDENCE_OUTPUT_TOKENS
  });
  return { result, evidence: normalizeEvidence(result.generated, sourceBundle) };
}

/* -------------------------------------------------------------------------- */
/* Evidence-mapped article generation                                         */
/* -------------------------------------------------------------------------- */

function articleSchema(config) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title", "slug", "description", "excerpt", "category", "keywords",
      "sections", "faq", "disclaimer", "requires_manual_review", "review_reasons"
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
            paragraphs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "evidence_ids"],
                properties: {
                  text: { type: "string" },
                  evidence_ids: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        }
      },
      faq: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "answer", "evidence_ids"],
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
            evidence_ids: { type: "array", items: { type: "string" } }
          }
        }
      },
      disclaimer: { type: "string" },
      requires_manual_review: { type: "boolean" },
      review_reasons: { type: "array", items: { type: "string" } }
    }
  };
}

function writerInstructions(config, queueItem, external) {
  const min = Number(config.writer.minimum_words || 1200);
  const target = Number(config.writer.target_words || 1500);
  const max = Number(config.writer.maximum_words || 1900);

  const sourceRules = external ? `
EVIDENCE-MAPPED MODE:
- The evidence pack is the ONLY source of external facts.
- Every body paragraph MUST list 1-3 evidence_ids and may state only facts directly supported by those evidence items.
- Every FAQ answer MUST list evidence_ids and may state only facts supported by them.
- Do NOT create a section whose subject is not supported by the evidence pack.
- Do NOT add generic wallet/security/bridge/validator/fee advice unless an evidence item directly supports it.
- Do NOT invent examples containing amounts, fees, percentages, durations, speeds, counts, dates, block numbers, token quantities, or reserve balances.
- You may explain a supported fact in beginner-friendly language, but explanation must not introduce a new mechanism, recommendation, comparison, cause, guarantee, or numeric detail.
- Reusing an evidence item across multiple paragraphs is allowed when each paragraph stays within that evidence.
` : `
APXN KNOWLEDGE MODE:
- The reviewed APXN knowledge JSON is the only authority for APXN project facts.
- Every body paragraph and FAQ answer must use evidence_ids=["APXN-KNOWLEDGE"].
- Never promote planned or UI-only features as live.
- Current in-app balances are APXN Points.
- Never describe the Claim action as blockchain consensus mining.
- Never promise token value, profit, exchange listing, conversion value, or withdrawal availability.
`;

  return `
You are the APXN Blog editorial writer.
Write an accurate, original, useful ENGLISH-ONLY article about: ${queueItem.topic}

${sourceRules}

STRUCTURE:
- ${target} words target; hard minimum ${min}; stay at or below ${max} when possible.
- Use 6-8 substantive sections.
- Prefer exactly 2 substantial paragraphs per section, normally about 80-120 words each.
- Include 2-4 FAQ items.
- Use beginner-friendly explanations and neutral educational tone.
- Metadata must summarize the article without adding a new factual claim not present in the body.
- No Arabic.
- No hype, guaranteed outcomes, fabricated examples, or unsupported current claims.
- If the available evidence cannot safely support a subtopic, OMIT that subtopic instead of guessing.
- Set requires_manual_review=true only if the supplied evidence itself contains an unresolved project risk; do not set it merely because evidence is concise.
- Return JSON only, matching the schema exactly.
`.trim();
}

function writerInput({ queueItem, config, knowledge, evidence }) {
  const external = Boolean(evidence);
  return JSON.stringify({
    current_date: todayISO(),
    topic: queueItem.topic,
    category: queueItem.category,
    writer_settings: {
      minimum_words: config.writer.minimum_words,
      target_words: config.writer.target_words,
      maximum_words: config.writer.maximum_words
    },
    evidence_pack: external ? evidence : undefined,
    apxn_knowledge: external ? undefined : knowledge,
    valid_evidence_ids: external ? evidence.facts.map((fact) => fact.id) : ["APXN-KNOWLEDGE"]
  }, null, 2);
}

function normalizeArticle(raw, queueItem, config) {
  const title = normalizeSpace(raw?.title || queueItem.topic);
  const slug = safeFilename(raw?.slug || title);
  let category = normalizeSpace(raw?.category || queueItem.category);
  if (!config.categories.includes(category)) category = config.categories.includes(queueItem.category) ? queueItem.category : config.categories[0];

  const sections = (Array.isArray(raw?.sections) ? raw.sections : [])
    .map((section) => ({
      heading: normalizeSpace(section?.heading),
      paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
        .map((paragraph) => ({
          text: normalizeSpace(paragraph?.text),
          evidence_ids: uniqueStrings(paragraph?.evidence_ids, 4)
        }))
        .filter((paragraph) => paragraph.text)
    }))
    .filter((section) => section.heading && section.paragraphs.length > 0);

  const faq = (Array.isArray(raw?.faq) ? raw.faq : [])
    .map((item) => ({
      question: normalizeSpace(item?.question),
      answer: normalizeSpace(item?.answer),
      evidence_ids: uniqueStrings(item?.evidence_ids, 4)
    }))
    .filter((item) => item.question && item.answer)
    .slice(0, 6);

  return {
    title,
    slug,
    description: normalizeSpace(raw?.description),
    excerpt: normalizeSpace(raw?.excerpt || raw?.description),
    category,
    language: "en",
    keywords: uniqueStrings(raw?.keywords, 12),
    sections,
    faq,
    disclaimer: normalizeSpace(raw?.disclaimer),
    requires_manual_review: raw?.requires_manual_review === true,
    review_reasons: uniqueStrings(raw?.review_reasons, 20)
  };
}

function articlePlainText(article) {
  const parts = [article.title, article.description, article.excerpt];
  for (const section of article.sections) {
    parts.push(section.heading);
    for (const paragraph of section.paragraphs) parts.push(paragraph.text);
  }
  for (const item of article.faq) parts.push(item.question, item.answer);
  parts.push(article.disclaimer);
  return parts.filter(Boolean).join("\n");
}

function buildVerificationUnits(article) {
  const units = [];
  const allEvidenceIds = uniqueStrings([
    ...article.sections.flatMap((section) => section.paragraphs.flatMap((paragraph) => paragraph.evidence_ids)),
    ...article.faq.flatMap((item) => item.evidence_ids)
  ], 24);

  // Metadata is verified too so SEO text cannot introduce unsupported facts.
  if (article.description) {
    units.push({
      id: "M01",
      location: "meta_description",
      text: article.description,
      evidence_ids: allEvidenceIds
    });
  }
  if (article.excerpt) {
    units.push({
      id: "M02",
      location: "excerpt",
      text: article.excerpt,
      evidence_ids: allEvidenceIds
    });
  }

  let index = 1;
  for (const section of article.sections) {
    for (const paragraph of section.paragraphs) {
      units.push({
        id: `P${String(index++).padStart(2, "0")}`,
        location: section.heading,
        text: paragraph.text,
        evidence_ids: paragraph.evidence_ids
      });
    }
  }
  let faqIndex = 1;
  for (const item of article.faq) {
    units.push({
      id: `F${String(faqIndex++).padStart(2, "0")}`,
      location: item.question,
      text: `Question: ${item.question} Answer: ${item.answer}`,
      evidence_ids: item.evidence_ids
    });
  }
  return units;
}

function riskyApXnReasons(article) {
  const text = articlePlainText(article).toLowerCase();
  const reasons = [];
  const checks = [
    [/\b(?:gate\.io|coinbase|kucoin|bybit|bitmart)\b.{0,60}\b(?:list|listed|listing)\b/i, "Named exchange-listing claim requires manual verification."],
    [/\b(?:guaranteed profit|guaranteed return|risk[- ]free profit)\b/i, "Guaranteed financial outcome language is not allowed."],
    [/\b(?:withdraw apxn now|currently withdrawable apxn)\b/i, "APXN Points must not be presented as currently withdrawable tokens."],
    [/\b(?:testnet is live|mainnet is live|staking is live|presale is active)\b/i, "Roadmap/planned feature was presented as live."],
    [/\b(?:audited contract|locked liquidity|no hidden taxes|minting disabled forever)\b/i, "Unverified smart-contract/liquidity claim requires manual verification."],
    [/\b60\s*%\s+(?:airdrop|of the airdrop)\b/i, "Airdrop entitlement claim requires current project verification."],
    [/\bfirst\s+10[,.]?000\s+(?:active\s+)?miners\b/i, "First-10,000 eligibility claim requires current verification."]
  ];
  for (const [regex, reason] of checks) if (regex.test(text)) reasons.push(reason);
  return uniqueStrings(reasons, 20);
}

function localArticleChecks({ article, config, manifest, evidence, knowledge }) {
  const errors = [];
  const warnings = [];
  const text = articlePlainText(article);
  const words = wordCount(text);
  const min = Number(config.writer.minimum_words || 1200);
  const max = Number(config.writer.maximum_words || 1900);

  if (containsArabicScript(text)) errors.push("Arabic-script text detected; blog is English-only.");
  if (article.sections.length < 6) errors.push(`Only ${article.sections.length} sections; minimum is 6.`);
  if (article.faq.length < 2) errors.push(`Only ${article.faq.length} FAQ items; minimum is 2.`);
  if (words < min) errors.push(`Article is too short: ${words} words; minimum is ${min}.`);
  if (words > max + 200) errors.push(`Article is too long: ${words} words; hard maximum is ${max + 200}.`);
  else if (words > max) warnings.push(`Article is above target maximum: ${words} words.`);

  const duplicate = manifest.articles.find((item) => slugify(item?.slug || item?.title || "") === article.slug);
  if (duplicate) errors.push(`Duplicate slug already exists: ${article.slug}.`);

  const validIds = new Set(evidence ? evidence.facts.map((fact) => fact.id) : ["APXN-KNOWLEDGE"]);
  const evidenceById = new Map(evidence ? evidence.facts.map((fact) => [fact.id, fact]) : []);
  const knowledgeText = normalizeComparable(JSON.stringify(knowledge));

  for (const unit of buildVerificationUnits(article)) {
    if (unit.evidence_ids.length === 0) {
      errors.push(`${unit.id} has no evidence_ids.`);
      continue;
    }
    const unknown = unit.evidence_ids.filter((id) => !validIds.has(id));
    if (unknown.length) errors.push(`${unit.id} references unknown evidence IDs: ${unknown.join(", ")}.`);

    const nums = numericTokens(unit.text);
    if (nums.length > 0) {
      const supportText = evidence
        ? normalizeComparable(unit.evidence_ids.map((id) => {
            const fact = evidenceById.get(id);
            return fact ? `${fact.claim} ${fact.support_quote}` : "";
          }).join(" ")).replace(/,/g, "")
        : knowledgeText.replace(/,/g, "");

      for (const token of nums) {
        const normalized = normalizeComparable(token).replace(/,/g, "");
        if (normalized && !supportText.includes(normalized)) {
          errors.push(`${unit.id} contains numeric detail not present in its assigned evidence: ${token}.`);
        }
      }
    }
  }

  if (!evidence) {
    const risky = riskyApXnReasons(article);
    if (risky.length) {
      article.requires_manual_review = true;
      article.review_reasons = uniqueStrings([...article.review_reasons, ...risky], 30);
    }
  }

  if (article.requires_manual_review) errors.push(...article.review_reasons.map((r) => `Manual review: ${r}`));

  return { words, reading_minutes: readingMinutes(words), errors: uniqueStrings(errors, 80), warnings };
}

async function generateMappedArticle({ apiKey, model, config, queueItem, knowledge, evidence }) {
  return callStructuredXAI({
    apiKey,
    model,
    config,
    instructions: writerInstructions(config, queueItem, Boolean(evidence)),
    input: writerInput({ queueItem, config, knowledge, evidence }),
    schema: articleSchema(config),
    schemaName: "apxn_evidence_mapped_article",
    maxOutputTokens: ARTICLE_OUTPUT_TOKENS
  });
}

/* -------------------------------------------------------------------------- */
/* Compact paragraph-level final verifier                                     */
/* -------------------------------------------------------------------------- */

function verifierSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "confidence", "summary", "checks"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fix"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      summary: { type: "string" },
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["unit_id", "status", "problem", "correction"],
          properties: {
            unit_id: { type: "string" },
            status: { type: "string", enum: ["supported", "unsupported"] },
            problem: { type: "string" },
            correction: { type: "string" }
          }
        }
      }
    }
  };
}

function buildVerifierPayload(article, evidence, knowledge) {
  const units = buildVerificationUnits(article);
  const evidenceById = new Map(evidence ? evidence.facts.map((fact) => [fact.id, fact]) : []);
  return {
    units: units.map((unit) => ({
      unit_id: unit.id,
      location: unit.location,
      text: unit.text,
      assigned_evidence_ids: unit.evidence_ids,
      assigned_evidence: evidence
        ? unit.evidence_ids.map((id) => evidenceById.get(id)).filter(Boolean)
        : undefined
    })),
    apxn_knowledge: evidence ? undefined : knowledge
  };
}

function verifierInstructions(external) {
  return `
You are the FINAL factual gate for an automated blog. Do not rewrite the article.
${external
  ? "For each paragraph/FAQ unit, use ONLY the evidence objects assigned to that unit. Do not use other evidence, web browsing, or model memory."
  : "For each paragraph/FAQ unit, use ONLY the supplied reviewed APXN knowledge. Do not use outside memory."}

RULES:
- Return exactly one check for EVERY supplied unit_id, no omissions and no duplicates.
- A unit is supported only if EVERY material factual assertion and recommendation in it is directly supported.
- If any part adds an unstated mechanism, comparison, causal explanation, recommendation, numeric detail, current-status claim, security claim, or generalization, mark the unit unsupported.
- Beginner-friendly paraphrase is allowed; new facts are not.
- Do not treat plausible statements as supported.
- For numeric claims, the exact number and context must be present in assigned evidence/knowledge.
- If unsupported, give one concise problem and one concise correction instruction.
- verdict=pass and confidence=high only if every unit is supported.
- Return JSON only.
`.trim();
}

function normalizeVerifier(raw, expectedUnits) {
  const expected = new Set(expectedUnits.map((unit) => unit.id));
  const seen = new Set();
  const checks = [];
  const structuralErrors = [];

  for (const item of Array.isArray(raw?.checks) ? raw.checks : []) {
    const id = normalizeSpace(item?.unit_id).toUpperCase();
    if (!expected.has(id)) {
      structuralErrors.push(`Verifier returned unknown unit ${id}.`);
      continue;
    }
    if (seen.has(id)) {
      structuralErrors.push(`Verifier returned duplicate unit ${id}.`);
      continue;
    }
    seen.add(id);
    checks.push({
      unit_id: id,
      status: item?.status === "supported" ? "supported" : "unsupported",
      problem: normalizeSpace(item?.problem),
      correction: normalizeSpace(item?.correction)
    });
  }

  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) structuralErrors.push(`Verifier omitted units: ${missing.join(", ")}.`);
  const unsupported = checks.filter((item) => item.status !== "supported");
  const pass =
    raw?.verdict === "pass" &&
    raw?.confidence === "high" &&
    structuralErrors.length === 0 &&
    unsupported.length === 0 &&
    checks.length === expected.size;

  return {
    verdict: pass ? "pass" : "fix",
    confidence: ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "low",
    summary: normalizeSpace(raw?.summary),
    checks,
    structural_errors: structuralErrors,
    unsupported,
    pass
  };
}

async function verifyMappedArticle({ apiKey, model, config, article, evidence, knowledge }) {
  const units = buildVerificationUnits(article);
  const result = await callStructuredXAI({
    apiKey,
    model,
    config,
    instructions: verifierInstructions(Boolean(evidence)),
    input: JSON.stringify(buildVerifierPayload(article, evidence, knowledge), null, 2),
    schema: verifierSchema(),
    schemaName: "apxn_paragraph_grounding_verification",
    maxOutputTokens: VERIFIER_OUTPUT_TOKENS
  });
  return { result, verification: normalizeVerifier(result.generated, units) };
}

function rewriteInstructions(config, queueItem, external) {
  return `
You are repairing an evidence-mapped APXN Blog article about "${queueItem.topic}".
Return a COMPLETE replacement article JSON.

MANDATORY:
- Fix every failed verifier unit and every local error.
- Keep the article at least ${config.writer.minimum_words} words and normally near ${config.writer.target_words} words.
- Preserve 6-8 substantive sections and at least 2 FAQ items.
- ${external
    ? "Use ONLY the supplied evidence pack. Every paragraph and FAQ answer must keep valid evidence_ids and must not add any fact outside those assigned evidence items."
    : "Use ONLY the supplied reviewed APXN knowledge. Every paragraph and FAQ answer must use evidence_ids=[\"APXN-KNOWLEDGE\"]."}
- Remove unsupported subtopics completely rather than replacing them with generic unsupported advice.
- Do not invent numeric examples, fee estimates, timings, balances, security recommendations, comparisons, or mechanisms.
- When more words are needed, deepen the explanation of supported evidence instead of adding new claims.
- Return JSON only.
`.trim();
}

async function rewriteArticle({ apiKey, model, config, queueItem, article, verification, localChecks, evidence, knowledge }) {
  return callStructuredXAI({
    apiKey,
    model,
    config,
    instructions: rewriteInstructions(config, queueItem, Boolean(evidence)),
    input: JSON.stringify({
      current_article: article,
      verifier_failures: [...verification.structural_errors, ...verification.unsupported],
      local_errors: localChecks.errors,
      evidence_pack: evidence || undefined,
      apxn_knowledge: evidence ? undefined : knowledge
    }, null, 2),
    schema: articleSchema(config),
    schemaName: "apxn_evidence_mapped_rewrite",
    maxOutputTokens: ARTICLE_OUTPUT_TOKENS
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function chooseRelatedArticles(manifest, article, limit = 3) {
  const published = manifest.articles.filter((item) => item?.status === "published" && item?.slug && item.slug !== article.slug);
  return [
    ...published.filter((item) => item.category === article.category),
    ...published.filter((item) => item.category !== article.category)
  ].slice(0, limit);
}

function renderSources(evidence) {
  if (!evidence?.sources?.length) return "";
  const items = evidence.sources.map((source) => `
                    <li>
                      <a class="font-bold text-yellow-400 hover:text-yellow-300" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>
                      <span class="text-gray-600"> — ${escapeHtml(source.domain)}</span>
                    </li>`).join("\n");
  return `
                <section class="mt-12 rounded-2xl border border-slate-800 bg-slate-900/70 p-6 sm:p-8">
                  <h2 class="text-2xl font-black mb-3">Official sources</h2>
                  <p class="text-sm text-gray-500 leading-relaxed mb-5">The factual evidence for this guide was extracted from these official pages before the article was written.</p>
                  <ol class="list-decimal pl-5 space-y-3 text-sm text-gray-400">${items}</ol>
                </section>`;
}

function renderRelated(related) {
  if (!related.length) return "";
  return `
                <section class="mt-12">
                  <h2 class="text-2xl font-black mb-5">Related APXN Blog guides</h2>
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    ${related.map((item) => `<a href="${encodeURIComponent(item.slug)}.html" class="block rounded-2xl border border-slate-800 bg-slate-900 p-5 hover:border-yellow-500/40"><div class="text-[11px] font-black uppercase tracking-widest text-yellow-500 mb-2">${escapeHtml(item.category || "APXN Blog")}</div><div class="font-black text-white">${escapeHtml(item.title || item.slug)}</div></a>`).join("\n")}
                  </div>
                </section>`;
}

function renderArticleHtml({ article, config, date, quality, related, evidence, indexable }) {
  const baseUrl = String(config.site?.base_url || "https://apxn.network").replace(/\/+$/, "");
  const articleUrl = `${baseUrl}/blog/articles/${article.slug}.html`;
  const ogImage = config.seo?.default_og_image || `${baseUrl}/logo2%20(1).png`;
  const articleSchemaJson = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.description,
    image: ogImage,
    mainEntityOfPage: articleUrl,
    datePublished: date,
    dateModified: date,
    author: { "@type": "Organization", name: config.site?.author || "Apex Network Editorial" },
    publisher: { "@type": "Organization", name: config.site?.brand || "Apex Network", url: baseUrl }
  };
  const faqSchema = article.faq.length ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: article.faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer }
    }))
  } : null;

  const body = article.sections.map((section) => `
                    <h2>${escapeHtml(section.heading)}</h2>
                    ${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.text)}</p>`).join("\n")}`).join("\n");

  const faq = article.faq.length ? `
                    <h2>Frequently asked questions</h2>
                    ${article.faq.map((item) => `<h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p>`).join("\n")}` : "";

  return `<!doctype html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(article.title)}</title>
  <meta name="description" content="${escapeHtml(article.description)}">
  <meta name="keywords" content="${escapeHtml(article.keywords.join(", "))}">
  <meta name="robots" content="${indexable ? "index, follow" : "noindex, nofollow"}">
  <link rel="canonical" href="${escapeHtml(articleUrl)}">
  <link rel="icon" href="../../logo2%20(1).png" type="image/png">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(article.title)}">
  <meta property="og:description" content="${escapeHtml(article.description)}">
  <meta property="og:url" content="${escapeHtml(articleUrl)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <script>window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};</script>
  <script defer src="/_vercel/insights/script.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config={theme:{extend:{colors:{slate:{800:'#1e293b',900:'#0f172a',950:'#020617'}}}}}</script>
  <style>
    html{background:#020617}.gold-text{background:linear-gradient(90deg,#fde047,#f59e0b,#fb923c);-webkit-background-clip:text;background-clip:text;color:transparent}
    .article-body p{color:#cbd5e1;line-height:1.9;margin:1rem 0 1.5rem}.article-body h2{color:#fff;font-size:1.75rem;font-weight:900;margin-top:2.7rem;margin-bottom:1rem;line-height:1.25}.article-body h3{color:#facc15;font-size:1.2rem;font-weight:900;margin-top:2rem;margin-bottom:.75rem}
  </style>
  <script type="application/ld+json">${safeJsonForScript(articleSchemaJson)}</script>
  ${faqSchema ? `<script type="application/ld+json">${safeJsonForScript(faqSchema)}</script>` : ""}
</head>
<body class="bg-slate-950 text-white font-sans selection:bg-yellow-500 selection:text-slate-950">
  <header class="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-xl">
    <div class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-5">
      <a href="../index.html" class="flex items-center gap-3"><img src="../../logo2%20(1).png" alt="Apex Network" class="w-11 h-11 rounded-full border border-yellow-500/50 object-cover"><div><div class="font-black tracking-wider gold-text">APEX NETWORK</div><div class="text-[10px] text-gray-500 font-bold uppercase tracking-[.2em]">APXN Blog</div></div></a>
      <a href="https://t.me/ApxMinerBot" target="_blank" rel="noopener noreferrer" class="rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 px-5 py-3 text-sm font-black text-slate-950">Open APXN App</a>
    </div>
  </header>
  <main>
    <article>
      <section class="border-b border-slate-800 bg-gradient-to-b from-yellow-500/[.06] to-transparent">
        <div class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-16 sm:py-20">
          <nav class="text-xs text-gray-500 font-bold mb-7"><a href="../../index.html" class="hover:text-yellow-400">Home</a><span class="mx-2">/</span><a href="../index.html" class="hover:text-yellow-400">Blog</a><span class="mx-2">/</span><span class="text-yellow-400">${escapeHtml(article.category)}</span></nav>
          <span class="inline-flex rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-xs font-black uppercase tracking-widest text-yellow-400 mb-5">${escapeHtml(article.category)}</span>
          <h1 class="text-4xl sm:text-5xl lg:text-6xl font-black leading-tight mb-6">${escapeHtml(article.title)}</h1>
          <p class="text-lg sm:text-xl text-gray-400 leading-relaxed mb-7">${escapeHtml(article.excerpt)}</p>
          <div class="flex flex-wrap gap-x-3 gap-y-2 text-sm text-gray-500"><span class="font-bold text-gray-300">${escapeHtml(config.site?.author || "Apex Network Editorial")}</span><span>•</span><time datetime="${date}">${date}</time><span>•</span><span>${quality.reading_minutes} min read</span><span>•</span><span>${quality.words.toLocaleString("en-US")} words</span></div>
        </div>
      </section>
      <section class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-12 sm:py-16">
        <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 sm:p-8 mb-10"><h2 class="text-2xl font-black mb-2">In this guide</h2><p class="text-gray-400 leading-relaxed">${escapeHtml(article.description)}</p></div>
        <div class="article-body">${body}${faq}</div>
        ${article.disclaimer ? `<div class="mt-12 rounded-2xl border border-amber-500/20 bg-amber-500/[.07] p-6"><h2 class="font-black text-amber-300 mb-2">Educational disclaimer</h2><p class="text-sm text-gray-400 leading-relaxed">${escapeHtml(article.disclaimer)}</p></div>` : ""}
        ${renderSources(evidence)}
        ${renderRelated(related)}
        <div class="mt-10 rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center"><img src="../../logo2%20(1).png" alt="Apex Network" class="w-20 h-20 mx-auto rounded-full border border-yellow-500/40 object-cover mb-5"><h2 class="text-3xl font-black mb-3">Explore Apex Network</h2><p class="text-gray-400 mb-6">Learn about the APXN ecosystem and access the official Telegram Mini App.</p><a href="https://t.me/ApxMinerBot" target="_blank" rel="noopener noreferrer" class="inline-flex rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 px-7 py-4 font-black text-slate-950">Open APXN on Telegram</a></div>
      </section>
    </article>
  </main>
  <footer class="border-t border-slate-800"><div class="max-w-7xl mx-auto px-5 py-10 text-xs text-gray-600 flex flex-wrap justify-between gap-4"><p>&copy; ${new Date().getFullYear()} Apex Network. All rights reserved.</p><div class="flex flex-wrap gap-4"><a href="../../about.html">About</a><a href="../../contact.html">Contact</a><a href="../../editorial-policy.html">Editorial Policy</a><a href="../../disclaimer.html">Disclaimer</a><a href="../../privacy.html">Privacy</a><a href="../../terms.html">Terms</a></div></div></footer>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Manifest / topic updates                                                   */
/* -------------------------------------------------------------------------- */

function recalculateStats(manifest) {
  manifest.stats = {
    total_articles: manifest.articles.length,
    published: manifest.articles.filter((a) => a.status === "published").length,
    drafts: manifest.articles.filter((a) => a.status === "draft").length,
    featured: manifest.articles.filter((a) => a.status === "published" && a.featured === true).length
  };
}

function updateTopicBank(bank, queueItem, status, articleId, slug, reason = null) {
  if (!bank || !Array.isArray(bank.topics) || !queueItem?.topic_bank_id) return;
  const item = bank.topics.find((entry) => entry?.id === queueItem.topic_bank_id);
  if (!item) return;
  Object.assign(item, {
    status: status === "published" ? "published" : status === "drafted" ? "drafted" : "used",
    article_id: articleId || null,
    article_slug: slug || null,
    used_at: todayISO(),
    result: status,
    rejection_reason: reason || null
  });
  bank.last_updated = todayISO();
}

function markRejected(manifest, bank, queueItem, reasons) {
  const reason = uniqueStrings(reasons, 16).join(" | ") || "Automated evidence pipeline rejected this topic.";
  Object.assign(queueItem, {
    status: "skipped_verification",
    skipped_at: todayISO(),
    skipped_reason: reason
  });
  updateTopicBank(bank, queueItem, "rejected_verification", null, null, reason);
  manifest.last_updated = todayISO();
}

function addManifestRecord({ manifest, queueItem, article, config, quality, verification, evidence, model, published, structuredPath }) {
  const id = nextArticleId(manifest.articles);
  const baseUrl = String(config.site?.base_url || "https://apxn.network").replace(/\/+$/, "");
  const relativePath = published ? `blog/articles/${article.slug}.html` : null;
  const url = published ? `${baseUrl}/${relativePath}` : null;
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
    published_at: published ? todayISO() : null,
    updated_at: todayISO(),
    reading_minutes: quality.reading_minutes,
    word_count: quality.words,
    path: relativePath,
    url,
    draft_artifact_path: published ? null : path.relative(ROOT, structuredPath).replaceAll(path.sep, "/"),
    image: config.seo?.default_og_image || `${baseUrl}/logo2%20(1).png`,
    keywords: article.keywords,
    source: "ai",
    ai_model: model,
    verified_against_knowledge: !evidence,
    verified_with_web_sources: false,
    verified_with_direct_official_sources: Boolean(evidence),
    requires_manual_review: false,
    review_reasons: [],
    verification: {
      verdict: verification.verdict,
      confidence: verification.confidence,
      checked_units: verification.checks.length,
      unsupported_units: verification.unsupported.length
    },
    research: {
      mode: evidence ? "direct_official_sources" : "apxn_knowledge_only",
      xai_web_search_enabled: false,
      source_count: evidence?.sources?.length || 0,
      source_domains: uniqueStrings((evidence?.sources || []).map((s) => s.domain), 10)
    },
    seo: {
      canonical: published ? url : null,
      robots: published ? "index, follow" : "noindex, nofollow",
      article_schema: published,
      faq_schema: published && article.faq.length > 0
    }
  };
  manifest.articles.push(record);
  Object.assign(queueItem, {
    status: published ? "published" : "drafted",
    article_id: id,
    slug: article.slug,
    generated_at: todayISO(),
    requires_manual_review: false
  });
  manifest.automation_state = manifest.automation_state || {};
  manifest.automation_state.last_generated_article = id;
  if (published) manifest.automation_state.last_published_article = id;
  const waiting = manifest.generation_queue.filter((item) => item.status === "waiting").sort((a, b) => Number(a.priority || 9999) - Number(b.priority || 9999));
  manifest.automation_state.next_queue_priority = waiting[0]?.priority ?? null;
  manifest.last_updated = todayISO();
  recalculateStats(manifest);
  return record;
}

/* -------------------------------------------------------------------------- */
/* Topic pipeline                                                             */
/* -------------------------------------------------------------------------- */

async function processTopic({ config, knowledge, manifest, topicBank, queueItem, apiKey, model, ledger, publishRequested }) {
  const date = todayISO();
  const costEntries = [];
  const external = !isApXnSpecificTopic(queueItem);
  const profile = external ? profileForTopic(queueItem) : null;
  let evidence = null;

  console.log("\nTopic attempt");
  console.log("-------------");
  console.log(`Topic: ${queueItem.topic}`);
  console.log(`Category: ${queueItem.category}`);
  console.log(`Research mode: ${external ? "direct_official_sources" : "apxn_knowledge_only"}`);
  console.log("xAI Web Search: disabled");

  if (external) {
    if (!profile) {
      markRejected(manifest, topicBank, queueItem, ["No curated official source profile exists for this topic."]);
      return { success: false, reason: "unsupported_source_profile" };
    }

    console.log(`Source profile: ${profile.name}`);
    console.log("Fetching official pages directly (no xAI Web Search cost)...");
    let sourceBundle;
    try {
      sourceBundle = await buildDirectSourceBundle(queueItem, profile);
    } catch (error) {
      markRejected(manifest, topicBank, queueItem, [error.message]);
      return { success: false, reason: "source_fetch_failed" };
    }

    console.log(`Official pages fetched: ${sourceBundle.sources.length}`);
    console.log(`Relevant excerpts selected: ${sourceBundle.excerpts.length}`);

    const extracted = await extractEvidence({ apiKey, model, config, queueItem, profile, sourceBundle });
    const entry = recordCost({
      ledger,
      response: extracted.result.response,
      model,
      topic: queueItem.topic,
      articleSlug: safeFilename(queueItem.topic),
      date,
      stage: "evidence_extract_direct_sources"
    });
    costEntries.push(entry);
    writeJson(PATHS.costs, ledger);
    evidence = extracted.evidence;

    console.log(`Locally validated evidence facts: ${evidence.facts.length}`);
    console.log(`Evidence source pages used: ${evidence.sources.length}`);

    if (evidence.facts.length < MIN_EXTERNAL_EVIDENCE_FACTS || evidence.sources.length < profile.minSources) {
      markRejected(manifest, topicBank, queueItem, [
        `Direct-source evidence was insufficient after deterministic quote validation: ${evidence.facts.length} facts from ${evidence.sources.length} sources.`
      ]);
      return { success: false, reason: "insufficient_direct_evidence" };
    }
  }

  if (!withinPerArticleBudget(config, costEntries, 0.015)) {
    markRejected(manifest, topicBank, queueItem, [`Per-article budget reached before generation: $${topicSpend(costEntries).toFixed(4)}.`]);
    return { success: false, reason: "budget_before_generation" };
  }

  console.log("Generating evidence-mapped article...");
  const generation = await generateMappedArticle({ apiKey, model, config, queueItem, knowledge, evidence });
  let article = normalizeArticle(generation.generated, queueItem, config);
  let entry = recordCost({
    ledger,
    response: generation.response,
    model,
    topic: queueItem.topic,
    articleSlug: article.slug,
    date,
    stage: "generation_evidence_mapped"
  });
  costEntries.push(entry);
  writeJson(PATHS.costs, ledger);

  let local = localArticleChecks({ article, config, manifest, evidence, knowledge });
  console.log(`Initial words: ${local.words}`);
  console.log(`Initial local errors: ${local.errors.length}`);

  if (!withinPerArticleBudget(config, costEntries, 0.010)) {
    markRejected(manifest, topicBank, queueItem, [`Per-article budget reached before final verification: $${topicSpend(costEntries).toFixed(4)}.`]);
    return { success: false, reason: "budget_before_verification" };
  }

  console.log("Running paragraph-level evidence verification...");
  let verifiedCall = await verifyMappedArticle({ apiKey, model, config, article, evidence, knowledge });
  let verification = verifiedCall.verification;
  entry = recordCost({
    ledger,
    response: verifiedCall.result.response,
    model,
    topic: queueItem.topic,
    articleSlug: article.slug,
    date,
    stage: "paragraph_verification_0"
  });
  costEntries.push(entry);
  writeJson(PATHS.costs, ledger);

  let accepted = local.errors.length === 0 && verification.pass;

  if (!accepted && MAX_REWRITE_ROUNDS > 0 && withinPerArticleBudget(config, costEntries, MIN_REWRITE_RESERVE_USD)) {
    console.log("One evidence-grounded full rewrite is required...");
    const rewrite = await rewriteArticle({
      apiKey, model, config, queueItem, article, verification, localChecks: local, evidence, knowledge
    });
    article = normalizeArticle(rewrite.generated, queueItem, config);
    entry = recordCost({
      ledger,
      response: rewrite.response,
      model,
      topic: queueItem.topic,
      articleSlug: article.slug,
      date,
      stage: "rewrite_1"
    });
    costEntries.push(entry);
    writeJson(PATHS.costs, ledger);

    local = localArticleChecks({ article, config, manifest, evidence, knowledge });

    if (withinPerArticleBudget(config, costEntries, 0.010)) {
      console.log("Mandatory fresh verification of rewritten article...");
      verifiedCall = await verifyMappedArticle({ apiKey, model, config, article, evidence, knowledge });
      verification = verifiedCall.verification;
      entry = recordCost({
        ledger,
        response: verifiedCall.result.response,
        model,
        topic: queueItem.topic,
        articleSlug: article.slug,
        date,
        stage: "paragraph_verification_1"
      });
      costEntries.push(entry);
      writeJson(PATHS.costs, ledger);
      accepted = local.errors.length === 0 && verification.pass;
    } else {
      accepted = false;
      verification = { ...verification, pass: false, verdict: "fix", summary: "Rewrite could not be freshly verified within the configured per-article budget." };
    }
  }

  const spend = topicSpend(costEntries);
  const maxPerArticle = Number(config?.cost_control?.maximum_cost_per_article_usd || 0);
  if (maxPerArticle > 0 && spend > maxPerArticle) accepted = false;

  console.log(`Words: ${local.words}`);
  console.log(`Local grounding errors: ${local.errors.length}`);
  console.log(`Verifier: ${verification.verdict} / ${verification.confidence}`);
  console.log(`Verification units: ${verification.checks.length}`);
  console.log(`Unsupported units: ${verification.unsupported.length}`);
  console.log("Fresh verification matches final article: yes");
  console.log(`Topic pipeline cost: $${spend.toFixed(6)}`);

  if (!accepted) {
    const reasons = [
      ...local.errors,
      ...verification.structural_errors,
      ...verification.unsupported.map((item) => `${item.unit_id}: ${item.problem}`),
      verification.summary
    ].filter(Boolean);

    const related = chooseRelatedArticles(manifest, article, 3);
    const privateJson = path.join(PATHS.privateDrafts, `${article.slug}.json`);
    const privateHtml = path.join(PATHS.privateDrafts, `${article.slug}.html`);
    writeJson(privateJson, {
      generated_at: date,
      status: "rejected_verification",
      topic: queueItem.topic,
      model,
      pipeline_cost_usd: spend,
      quality: local,
      evidence_pack: evidence,
      verification,
      research: {
        mode: external ? "direct_official_sources" : "apxn_knowledge_only",
        xai_web_search_enabled: false,
        sources: evidence?.sources || []
      },
      article
    });
    writeText(privateHtml, renderArticleHtml({ article, config, date, quality: local, related, evidence, indexable: false }));
    markRejected(manifest, topicBank, queueItem, reasons);
    console.warn("Topic rejected safely. No public article was written.");
    return { success: false, reason: "verification_failed" };
  }

  article.requires_manual_review = false;
  article.review_reasons = [];
  const related = chooseRelatedArticles(manifest, article, 3);
  const published = publishRequested;
  const publicHtml = path.join(PATHS.published, `${article.slug}.html`);
  const publicJson = path.join(PATHS.generated, `${article.slug}.json`);
  const privateHtml = path.join(PATHS.privateDrafts, `${article.slug}.html`);
  const privateJson = path.join(PATHS.privateDrafts, `${article.slug}.json`);
  const structuredPath = published ? publicJson : privateJson;

  const record = {
    generated_at: date,
    language: "en",
    topic: queueItem.topic,
    category: article.category,
    model,
    provider: "xai",
    pipeline_cost_usd: spend,
    cost_entries: costEntries,
    evidence_pack: evidence,
    research: {
      mode: external ? "direct_official_sources" : "apxn_knowledge_only",
      xai_web_search_enabled: false,
      source_count: evidence?.sources?.length || 0,
      sources: evidence?.sources || []
    },
    verification,
    status: published ? "published" : "draft",
    requires_manual_review: false,
    quality: {
      word_count: local.words,
      reading_minutes: local.reading_minutes,
      warnings: local.warnings
    },
    article
  };

  const html = renderArticleHtml({ article, config, date, quality: local, related, evidence, indexable: published });
  if (published) {
    writeJson(publicJson, record);
    writeText(publicHtml, html);
  } else {
    writeJson(privateJson, record);
    writeText(privateHtml, html);
  }

  const manifestRecord = addManifestRecord({
    manifest, queueItem, article, config, quality: local, verification, evidence, model, published, structuredPath
  });
  updateTopicBank(topicBank, queueItem, published ? "published" : "drafted", manifestRecord.id, article.slug);
  console.log(`Article ${manifestRecord.id} passed the final evidence pipeline.`);
  console.log(`Status: ${manifestRecord.status}`);
  return { success: true, published };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const config = readJson(PATHS.config);
  const knowledge = readJson(PATHS.knowledge);
  const manifest = readJson(PATHS.articles);
  const topicBank = readJsonIfExists(PATHS.topicBank);
  validateConfig(config);
  validateManifest(manifest);

  // Optional zero-cost source test. This fetches and ranks official pages, then exits
  // BEFORE requiring XAI_API_KEY or making any xAI API request.
  if (isTruthyEnv("BLOG_SOURCE_TEST")) {
    const queueItem = chooseNextTopic(manifest);
    if (isApXnSpecificTopic(queueItem)) {
      console.log("Source test: APXN topic uses the reviewed internal knowledge file; no external fetch is required.");
      return;
    }
    const profile = profileForTopic(queueItem);
    if (!profile) fail("Source test failed: no curated official source profile for the next topic.");
    console.log(`Source test topic: ${queueItem.topic}`);
    console.log(`Source profile: ${profile.name}`);
    const bundle = await buildDirectSourceBundle(queueItem, profile);
    console.log(`Official pages fetched: ${bundle.sources.length}`);
    console.log(`Relevant excerpts selected: ${bundle.excerpts.length}`);
    console.log(`Excerpt characters: ${bundle.excerpts.reduce((sum, item) => sum + item.excerpt.length, 0)}`);
    console.log("Source test: PASS (no xAI API call was made).");
    return;
  }

  const keyVariable = String(config?.security?.xai_key_variable || "XAI_API_KEY").trim() || "XAI_API_KEY";
  const apiKey = String(process.env[keyVariable] || "").trim();
  if (!apiKey) fail(`${keyVariable} is missing. Add it as a GitHub Actions secret.`);

  const modelVariable = String(config?.security?.xai_model_variable || "XAI_MODEL").trim() || "XAI_MODEL";
  const model = String(process.env[modelVariable] || config?.ai?.default_model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const ledger = readCostLedger();
  const publishRequested =
    config?.automation?.auto_generate_enabled === true &&
    config?.automation?.auto_publish_enabled === true &&
    isTruthyEnv("BLOG_PUBLISH");
  const maxAttempts = publishRequested ? MAX_PRODUCTION_TOPIC_ATTEMPTS : MAX_TEST_TOPIC_ATTEMPTS;

  console.log("APXN Blog Writer — Direct Official Sources Pipeline");
  console.log("---------------------------------------------------");
  console.log("Language: English only");
  console.log(`Model: ${model}`);
  console.log("xAI Web Search: disabled");
  console.log(`Publish requested: ${publishRequested}`);
  console.log(`Maximum topic attempts: ${maxAttempts}`);

  let produced = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    ensureMonthlyBudget(config, ledger);
    let queueItem;
    try {
      queueItem = chooseNextTopic(manifest);
    } catch (error) {
      console.warn(error.message);
      break;
    }

    console.log(`\n=== Topic ${attempt}/${maxAttempts} ===`);
    const result = await processTopic({
      config, knowledge, manifest, topicBank, queueItem, apiKey, model, ledger, publishRequested
    });

    writeJson(PATHS.articles, manifest);
    if (topicBank) writeJson(PATHS.topicBank, topicBank);
    writeJson(PATHS.costs, ledger);

    if (result.success) {
      produced = true;
      break;
    }
    if (!publishRequested) break;
  }

  console.log(`\nMonthly tracked spend: $${monthlySpend(ledger).toFixed(6)}`);
  if (!produced) {
    console.log("No article passed the final evidence pipeline in this run.");
    return;
  }
  console.log(publishRequested
    ? "Verified article published and ready for blog-sync."
    : "Verified article saved as a private workflow artifact; public publishing remains disabled in writer_test mode.");
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});

