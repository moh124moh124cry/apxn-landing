/**
 * APXN Blog Researcher — Free Official-Source Research Compiler
 * Path: scripts/blog-researcher.mjs
 *
 * Purpose:
 * - Perform the research stage without any paid AI/API model.
 * - Read only allowlisted official sources from data/blog-source-profiles.json.
 * - Read APXN project facts only from explicitly selected knowledge_sections.
 * - Build a deterministic Research Packet for the paid writer.
 * - Refuse topics whose evidence cannot support a substantial 1200+ word article.
 *
 * This module has no external npm dependencies and uses Node.js built-ins only.
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
  topicBank: path.join(ROOT, "data", "blog-topic-bank.json"),
  sourceProfiles: path.join(ROOT, "data", "blog-source-profiles.json"),
  outputDir: path.join(ROOT, ".workflow-output", "research")
};

const SOURCE_FETCH_TIMEOUT_MS = 22_000;
const MAX_SOURCE_BYTES = 900_000;
const MAX_SOURCE_TEXT_CHARS = 140_000;
const MIN_PASSAGE_WORDS = 55;
const TARGET_PASSAGE_WORDS = 130;
const MAX_PASSAGE_WORDS = 210;
const MAX_PASSAGES_PER_SOURCE = 6;
const MAX_EXTERNAL_EVIDENCE_ITEMS = 18;
const MAX_APXN_EVIDENCE_ITEMS = 24;

const CONTENT_MODES = new Set(["apxn", "external", "hybrid", "manual"]);

const MIN_RESEARCH = {
  external: {
    total_words: 900,
    external_words: 900,
    apxn_words: 0,
    evidence_items: 8
  },
  hybrid: {
    total_words: 950,
    external_words: 700,
    apxn_words: 80,
    evidence_items: 9
  },
  apxn: {
    total_words: 450,
    external_words: 0,
    apxn_words: 450,
    evidence_items: 6
  }
};

const ARTICLE_WORD_PLAN = {
  minimum: 1200,
  target: 1500,
  maximum: 1900,
  intro: { min: 120, target: 145, max: 170 },
  section: { min: 165, target: 190, max: 220 },
  faq_each: { min: 70, target: 90, max: 110 },
  conclusion: { min: 90, target: 110, max: 135 }
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can",
  "for", "from", "how", "in", "into", "is", "it", "its", "of", "on", "or",
  "that", "the", "their", "them", "these", "this", "to", "was", "were", "what",
  "when", "where", "which", "who", "why", "will", "with", "your", "you", "users",
  "user", "guide", "understanding", "explained", "beginner", "beginners", "important"
]);

const GLOBAL_FORBIDDEN_CLAIMS = [
  "Do not invent facts from model memory or open-web knowledge.",
  "Do not invent integrations, partnerships, listings, prices, yields, profits or investment outcomes.",
  "Do not present planned or UI-only APXN features as live or persisted.",
  "Do not infer wallet custody, private-key storage, transaction signing or on-chain settlement unless the packet explicitly contains that fact.",
  "Do not convert two separate facts into a causal relationship unless an evidence item explicitly states that relationship.",
  "Do not invent future possibilities such as could later, may eventually, will enable or can help unless an evidence item explicitly supports that future relationship.",
  "Do not add current volatile metrics such as prices, TVL, APY, gas price, validator count, TPS or market figures unless explicitly approved by the source profile.",
  "Do not pad the article with repetition, generic motivational language or unsupported examples merely to reach a word count."
];

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

function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, value, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function writeJson(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
  const clean = normalizeSpace(value);
  return clean ? clean.split(/\s+/).filter(Boolean).length : 0;
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

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function hostnameOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAllowedHostname(hostname, allowedDomains) {
  const clean = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return (allowedDomains || []).some((domain) => {
    const allowed = String(domain || "").toLowerCase().replace(/^www\./, "");
    return clean === allowed || clean.endsWith(`.${allowed}`);
  });
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => {
      const valueNumber = Number(code);
      return Number.isFinite(valueNumber) ? String.fromCodePoint(valueNumber) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const valueNumber = Number.parseInt(code, 16);
      return Number.isFinite(valueNumber) ? String.fromCodePoint(valueNumber) : " ";
    });
}

function htmlToTextWithBlocks(html) {
  let text = String(html || "");

  text = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|li|h1|h2|h3|h4|h5|h6|table|tr|pre|blockquote)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeHtmlEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.slice(0, MAX_SOURCE_TEXT_CHARS);
}

function plainTextSourceToBlocks(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SOURCE_TEXT_CHARS);
}

function sourceBodyToText(body, contentType, url) {
  const type = String(contentType || "").toLowerCase();
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (
    type.includes("text/html") ||
    /\.(?:html?|xhtml)$/.test(pathname) ||
    (!type && /<html|<body|<article|<main/i.test(body))
  ) {
    return htmlToTextWithBlocks(body);
  }

  return plainTextSourceToBlocks(body);
}

function tokenize(value) {
  return normalizeTopic(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function topicTerms(topic, category = "") {
  return uniqueStrings([...tokenize(topic), ...tokenize(category)], 30);
}

function passageScore(passage, terms, sourceTitle = "") {
  const lower = String(passage || "").toLowerCase();
  const passageTokens = new Set(tokenize(passage));
  const titleTokens = new Set(tokenize(sourceTitle));
  let score = 0;

  for (const term of terms) {
    if (passageTokens.has(term)) score += 5;
    if (lower.includes(term)) score += 2;
    if (titleTokens.has(term)) score += 1;
  }

  const words = wordCount(passage);
  if (words >= 85 && words <= 175) score += 4;
  else if (words >= MIN_PASSAGE_WORDS && words <= MAX_PASSAGE_WORDS) score += 2;

  if (/\b(?:privacy policy|terms of service|cookie|copyright|all rights reserved|subscribe|newsletter|sign in|log in)\b/i.test(passage)) {
    score -= 20;
  }

  if (/\b(?:example|for example|means|defined|works|security|verify|validation|transaction|wallet|network|token|authentication|account|contract|gas|block)\b/i.test(passage)) {
    score += 2;
  }

  return score;
}

function splitLongBlockIntoPassages(block) {
  const words = normalizeSpace(block).split(/\s+/).filter(Boolean);
  if (words.length <= MAX_PASSAGE_WORDS) return [normalizeSpace(block)];

  const passages = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(words.length, start + TARGET_PASSAGE_WORDS);
    let slice = words.slice(start, end).join(" ");

    if (end < words.length) {
      const nextExtra = words.slice(end, Math.min(words.length, end + 35)).join(" ");
      const combined = `${slice} ${nextExtra}`;
      const sentenceBoundary = Math.max(
        combined.lastIndexOf(". "),
        combined.lastIndexOf("? "),
        combined.lastIndexOf("! ")
      );

      if (sentenceBoundary > slice.length * 0.7) {
        slice = combined.slice(0, sentenceBoundary + 1);
      }
    }

    const consumed = Math.max(1, wordCount(slice));
    passages.push(normalizeSpace(slice));
    start += consumed;
  }

  return passages;
}

function extractCandidatePassages(text) {
  const rawBlocks = String(text || "")
    .split(/\n{2,}/)
    .map(normalizeSpace)
    .filter(Boolean);

  const candidates = [];
  let carry = "";

  for (const block of rawBlocks) {
    if (wordCount(block) < 18) {
      carry = normalizeSpace(`${carry} ${block}`);
      continue;
    }

    const merged = normalizeSpace(`${carry} ${block}`);
    carry = "";

    for (const passage of splitLongBlockIntoPassages(merged)) {
      const words = wordCount(passage);
      if (words >= MIN_PASSAGE_WORDS && words <= MAX_PASSAGE_WORDS + 30) {
        candidates.push(passage);
      }
    }
  }

  if (carry && wordCount(carry) >= MIN_PASSAGE_WORDS) {
    candidates.push(carry);
  }

  return candidates;
}

function tokenJaccard(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function isNearDuplicate(candidate, selected) {
  return selected.some((existing) => {
    if (candidate.toLowerCase() === existing.toLowerCase()) return true;
    return tokenJaccard(candidate, existing) >= 0.82;
  });
}

function selectPassages(text, { topic, category, sourceTitle }) {
  const terms = topicTerms(topic, category);
  const candidates = extractCandidatePassages(text)
    .map((passage, index) => ({
      passage,
      index,
      score: passageScore(passage, terms, sourceTitle)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = [];

  for (const candidate of candidates) {
    if (candidate.score < 1 && selected.length >= 3) continue;
    if (isNearDuplicate(candidate.passage, selected)) continue;
    selected.push(candidate.passage);
    if (selected.length >= MAX_PASSAGES_PER_SOURCE) break;
  }

  return selected;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow"
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBodyLimited(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SOURCE_BYTES) {
    fail(`Source response is too large (${declaredLength} bytes).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_SOURCE_BYTES) {
    fail(`Source response exceeded ${MAX_SOURCE_BYTES} bytes.`);
  }

  return buffer.toString("utf8");
}

async function fetchOfficialSource(source, profile) {
  const originalUrl = String(source?.url || "").trim();
  if (!originalUrl) fail("Approved source is missing its URL.");

  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch {
    fail(`Invalid approved source URL: ${originalUrl}`);
  }

  if (parsed.protocol !== "https:") {
    fail(`Approved source must use HTTPS: ${originalUrl}`);
  }

  if (!isAllowedHostname(parsed.hostname, profile.allowed_domains)) {
    fail(`Approved source host is not allowlisted: ${parsed.hostname}`);
  }

  const response = await fetchWithTimeout(originalUrl, {
    headers: {
      "user-agent": "APXNBlogResearcher/1.0 (+https://apxn.network)",
      accept: "text/html,text/plain,text/markdown,application/xhtml+xml;q=0.9,*/*;q=0.2"
    }
  });

  if (!response.ok) {
    fail(`HTTP ${response.status} for ${originalUrl}`);
  }

  const finalUrl = response.url || originalUrl;
  const finalParsed = new URL(finalUrl);

  if (finalParsed.protocol !== "https:") {
    fail(`Redirect left HTTPS: ${finalUrl}`);
  }

  if (!isAllowedHostname(finalParsed.hostname, profile.allowed_domains)) {
    fail(`Redirect left allowlisted domains: ${finalParsed.hostname}`);
  }

  const body = await readResponseBodyLimited(response);
  const text = sourceBodyToText(body, response.headers.get("content-type"), finalUrl);

  if (wordCount(text) < 120) {
    fail(`Official source returned too little readable content (${wordCount(text)} words): ${finalUrl}`);
  }

  return {
    title: normalizeSpace(source.title || finalParsed.hostname),
    requested_url: originalUrl,
    final_url: finalUrl,
    hostname: finalParsed.hostname.toLowerCase().replace(/^www\./, ""),
    content_type: response.headers.get("content-type") || null,
    text
  };
}

function extractNumericTokens(value) {
  const matches = String(value || "").match(/\b\d+(?:[.,]\d+)*(?:%|x|k|m|b)?\b/gi) || [];
  return uniqueStrings(matches.map((item) => item.toLowerCase()), 80);
}

function makeExternalEvidenceItem({ id, passage, page, score = null }) {
  return {
    id,
    kind: "external",
    source_title: page.title,
    source_url: page.final_url,
    source_hostname: page.hostname,
    source_path: null,
    text: normalizeSpace(passage),
    word_count: wordCount(passage),
    numeric_tokens: extractNumericTokens(passage),
    relevance_score: score
  };
}

async function collectExternalEvidence(metadata, profile) {
  const pages = [];
  const errors = [];
  const evidence = [];

  for (const source of profile.sources || []) {
    try {
      const page = await fetchOfficialSource(source, profile);
      const selected = selectPassages(page.text, {
        topic: metadata.topic,
        category: metadata.category,
        sourceTitle: page.title
      });

      pages.push({
        title: page.title,
        requested_url: page.requested_url,
        final_url: page.final_url,
        hostname: page.hostname,
        passage_count: selected.length,
        readable_words: wordCount(page.text)
      });

      for (const passage of selected) {
        const score = passageScore(
          passage,
          topicTerms(metadata.topic, metadata.category),
          page.title
        );
        evidence.push({ passage, page, score });
      }
    } catch (error) {
      errors.push({
        title: normalizeSpace(source?.title || "Unknown source"),
        url: String(source?.url || ""),
        error: error.message
      });
    }
  }

  evidence.sort((a, b) => b.score - a.score);

  const deduped = [];
  const selectedTexts = [];

  for (const candidate of evidence) {
    if (isNearDuplicate(candidate.passage, selectedTexts)) continue;
    selectedTexts.push(candidate.passage);
    deduped.push(candidate);
    if (deduped.length >= MAX_EXTERNAL_EVIDENCE_ITEMS) break;
  }

  return {
    pages,
    errors,
    evidence: deduped.map((item, index) =>
      makeExternalEvidenceItem({
        id: `EXT-${String(index + 1).padStart(2, "0")}`,
        passage: item.passage,
        page: item.page,
        score: item.score
      })
    )
  };
}

function humanizeKey(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function scalarToText(pathParts, value) {
  const label = humanizeKey(pathParts.at(-1));

  if (typeof value === "boolean") {
    return `${label}: ${value ? "Yes" : "No"}.`;
  }

  if (typeof value === "number") {
    return `${label}: ${value}.`;
  }

  const clean = normalizeSpace(value);
  if (!clean) return "";

  if (/^[A-Z][\s\S]*[.!?]$/.test(clean) || clean.split(/\s+/).length >= 10) {
    return clean;
  }

  return `${label}: ${clean}.`;
}

function flattenKnowledgeValue(value, pathParts = [], result = []) {
  if (result.length >= MAX_APXN_EVIDENCE_ITEMS * 2) return result;

  if (value === null || value === undefined) return result;

  if (["string", "number", "boolean"].includes(typeof value)) {
    const text = scalarToText(pathParts, value);
    if (text) {
      result.push({
        source_path: pathParts.join("."),
        text
      });
    }
    return result;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];

      if (["string", "number", "boolean"].includes(typeof item)) {
        const text = scalarToText([...pathParts, String(index + 1)], item);
        if (text) {
          result.push({
            source_path: pathParts.join("."),
            text
          });
        }
      } else {
        flattenKnowledgeValue(item, [...pathParts, String(index + 1)], result);
      }
    }
    return result;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "source_paths" || key === "source_path") continue;
      flattenKnowledgeValue(child, [...pathParts, key], result);
    }
  }

  return result;
}

function sourcePathsFromKnowledgeNode(node) {
  if (!node || typeof node !== "object") return [];
  const values = [];

  if (Array.isArray(node.source_paths)) values.push(...node.source_paths);
  if (typeof node.source_path === "string") values.push(node.source_path);

  return uniqueStrings(values, 20);
}

function collectApxnEvidence(metadata, knowledge) {
  const evidence = [];

  for (const knowledgePath of metadata.knowledge_sections || []) {
    const node = getAtPath(knowledge, knowledgePath);
    if (node === undefined) {
      fail(`Unknown APXN knowledge section: ${knowledgePath}`);
    }

    const sourcePaths = sourcePathsFromKnowledgeNode(node);
    const flattened = flattenKnowledgeValue(node, knowledgePath.split("."), []);

    for (const item of flattened) {
      const clean = normalizeSpace(item.text);
      if (!clean || wordCount(clean) < 2) continue;

      evidence.push({
        id: "",
        kind: "apxn",
        source_title: `APXN verified knowledge: ${knowledgePath}`,
        source_url: null,
        source_hostname: null,
        source_path: item.source_path || knowledgePath,
        project_source_paths: sourcePaths,
        text: clean,
        word_count: wordCount(clean),
        numeric_tokens: extractNumericTokens(clean),
        relevance_score: passageScore(clean, topicTerms(metadata.topic, metadata.category), knowledgePath)
      });
    }
  }

  evidence.sort((a, b) => b.relevance_score - a.relevance_score);

  const selected = [];
  const selectedTexts = [];

  for (const item of evidence) {
    if (isNearDuplicate(item.text, selectedTexts)) continue;
    selectedTexts.push(item.text);
    selected.push(item);
    if (selected.length >= MAX_APXN_EVIDENCE_ITEMS) break;
  }

  return selected.map((item, index) => ({
    ...item,
    id: `APXN-${String(index + 1).padStart(2, "0")}`
  }));
}

function evidenceWords(evidence, kind = null) {
  return (evidence || [])
    .filter((item) => !kind || item.kind === kind)
    .reduce((sum, item) => sum + Number(item.word_count || 0), 0);
}

function distinctExternalPageCount(evidence) {
  return new Set(
    (evidence || [])
      .filter((item) => item.kind === "external" && item.source_url)
      .map((item) => item.source_url)
  ).size;
}

function evaluateResearchSufficiency(metadata, evidence, profile = null) {
  const mode = metadata.content_mode;
  const threshold = MIN_RESEARCH[mode];

  if (!threshold) {
    return {
      ready: false,
      reasons: [`Content mode ${mode} is not eligible for automatic research.`]
    };
  }

  const totalWords = evidenceWords(evidence);
  const externalWords = evidenceWords(evidence, "external");
  const apxnWords = evidenceWords(evidence, "apxn");
  const externalPages = distinctExternalPageCount(evidence);
  const reasons = [];

  if (evidence.length < threshold.evidence_items) {
    reasons.push(
      `Only ${evidence.length} evidence items were collected; at least ${threshold.evidence_items} are required.`
    );
  }

  if (totalWords < threshold.total_words) {
    reasons.push(
      `Only ${totalWords} evidence words were collected; at least ${threshold.total_words} are required.`
    );
  }

  if (externalWords < threshold.external_words) {
    reasons.push(
      `Only ${externalWords} external evidence words were collected; at least ${threshold.external_words} are required.`
    );
  }

  if (apxnWords < threshold.apxn_words) {
    reasons.push(
      `Only ${apxnWords} APXN evidence words were collected; at least ${threshold.apxn_words} are required.`
    );
  }

  if (["external", "hybrid"].includes(mode)) {
    const requiredPages = Math.max(1, Number(profile?.min_sources || 1));
    if (externalPages < requiredPages) {
      reasons.push(
        `Only ${externalPages} distinct approved source pages contributed evidence; profile requires ${requiredPages}.`
      );
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    metrics: {
      evidence_items: evidence.length,
      total_words: totalWords,
      external_words: externalWords,
      apxn_words: apxnWords,
      distinct_external_pages: externalPages
    }
  };
}

function evidenceSourceKey(item) {
  if (item.kind === "external") return `external:${item.source_url}`;
  return `apxn:${item.source_title}`;
}

function distributeEvidenceAcrossSections(evidence) {
  const groups = new Map();

  for (const item of evidence) {
    const key = evidenceSourceKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const groupList = [...groups.values()].sort((a, b) => {
    const left = a.reduce((sum, item) => sum + item.word_count, 0);
    const right = b.reduce((sum, item) => sum + item.word_count, 0);
    return right - left;
  });

  const sections = Array.from({ length: 6 }, () => []);
  const sourceIndex = Array.from({ length: 6 }, () => new Set());

  const sortedEvidence = [...evidence].sort((a, b) => {
    return (b.relevance_score || 0) - (a.relevance_score || 0) || b.word_count - a.word_count;
  });

  for (let index = 0; index < sortedEvidence.length; index++) {
    const item = sortedEvidence[index];
    const key = evidenceSourceKey(item);

    const candidates = sections
      .map((items, sectionIndex) => ({
        sectionIndex,
        words: items.reduce((sum, current) => sum + current.word_count, 0),
        sameSource: sourceIndex[sectionIndex].has(key)
      }))
      .sort((a, b) => {
        if (a.sameSource !== b.sameSource) return a.sameSource ? -1 : 1;
        return a.words - b.words || a.sectionIndex - b.sectionIndex;
      });

    const destination = candidates[0].sectionIndex;
    if (sections[destination].length < 4) {
      sections[destination].push(item);
      sourceIndex[destination].add(key);
    }
  }

  // Guarantee every section has at least one evidence item by borrowing the
  // highest-ranked evidence. Reuse is permitted in the plan; invention is not.
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    if (sections[sectionIndex].length === 0 && sortedEvidence.length > 0) {
      sections[sectionIndex].push(sortedEvidence[sectionIndex % sortedEvidence.length]);
    }
  }

  return sections;
}

function focusTermsForEvidence(items, topic) {
  const topicTokenSet = new Set(tokenize(topic));
  const counts = new Map();

  for (const item of items) {
    for (const token of tokenize(item.text)) {
      if (topicTokenSet.has(token) || STOP_WORDS.has(token) || token.length < 4) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([token]) => token);
}

function buildWritingPlan(metadata, evidence) {
  const sectionEvidence = distributeEvidenceAcrossSections(evidence);
  const topEvidence = [...evidence].sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

  const sections = sectionEvidence.map((items, index) => ({
    section_index: index + 1,
    target_words: ARTICLE_WORD_PLAN.section.target,
    min_words: ARTICLE_WORD_PLAN.section.min,
    max_words: ARTICLE_WORD_PLAN.section.max,
    evidence_ids: uniqueStrings(items.map((item) => item.id), 4),
    focus_terms: focusTermsForEvidence(items, metadata.topic),
    instruction:
      "Explain only the facts supported by these evidence IDs. You may clarify terminology and relationships already stated inside the assigned evidence, but you may not add a new product behavior, implementation detail, benefit, risk, example or future use from outside the packet."
  }));

  const introEvidence = uniqueStrings(topEvidence.slice(0, 3).map((item) => item.id), 3);
  const conclusionEvidence = uniqueStrings(topEvidence.slice(0, 4).map((item) => item.id), 4);

  const faq = Array.from({ length: 3 }, (_, index) => ({
    faq_index: index + 1,
    target_words: ARTICLE_WORD_PLAN.faq_each.target,
    min_words: ARTICLE_WORD_PLAN.faq_each.min,
    max_words: ARTICLE_WORD_PLAN.faq_each.max,
    evidence_ids: uniqueStrings(
      [topEvidence[(index * 2) % topEvidence.length], topEvidence[(index * 2 + 1) % topEvidence.length]]
        .filter(Boolean)
        .map((item) => item.id),
      2
    ),
    instruction: "Answer a practical question using only the assigned evidence IDs."
  }));

  return {
    article_word_requirement: ARTICLE_WORD_PLAN,
    intro: {
      target_words: ARTICLE_WORD_PLAN.intro.target,
      min_words: ARTICLE_WORD_PLAN.intro.min,
      max_words: ARTICLE_WORD_PLAN.intro.max,
      evidence_ids: introEvidence,
      instruction:
        "Introduce the topic using only the assigned evidence. Do not promise benefits or integrations that the evidence does not state."
    },
    sections,
    faq,
    conclusion: {
      target_words: ARTICLE_WORD_PLAN.conclusion.target,
      min_words: ARTICLE_WORD_PLAN.conclusion.min,
      max_words: ARTICLE_WORD_PLAN.conclusion.max,
      evidence_ids: conclusionEvidence,
      instruction:
        "Summarize only the evidence-backed takeaways. Do not add a prediction, recommendation, price claim or future integration."
    }
  };
}

function packetSources(evidence) {
  const seen = new Set();
  const result = [];

  for (const item of evidence) {
    const key = item.kind === "external" ? item.source_url : item.source_title;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    result.push({
      kind: item.kind,
      title: item.source_title,
      url: item.source_url || null,
      source_path: item.source_path || null,
      project_source_paths: item.project_source_paths || []
    });
  }

  return result;
}

function buildForbiddenClaims(metadata, profile) {
  const guards = [...GLOBAL_FORBIDDEN_CLAIMS];

  if (metadata.editorial_guard) guards.push(metadata.editorial_guard);
  if (profile?.editorial_guard) guards.push(profile.editorial_guard);

  if (metadata.content_mode === "apxn") {
    guards.push("Do not introduce general blockchain facts unless they are present in the selected APXN knowledge evidence.");
  }

  if (metadata.content_mode === "hybrid") {
    guards.push(
      "Keep APXN project facts and external educational facts attributable to their own evidence. Do not imply that APXN implements an external technology merely because both appear in the packet."
    );
  }

  return uniqueStrings(guards, 30);
}

function collectAllowedNumericTokens(evidence) {
  return uniqueStrings(
    evidence.flatMap((item) => item.numeric_tokens || []),
    120
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function validateTopicMetadata(metadata, sourceFile, knowledge) {
  const mode = String(metadata?.content_mode || "").toLowerCase();

  if (!CONTENT_MODES.has(mode)) {
    fail(`Invalid content_mode for ${metadata?.id || metadata?.topic}: ${mode}`);
  }

  if (mode === "manual") {
    return { mode, profile: null };
  }

  let profile = null;

  if (["external", "hybrid"].includes(mode)) {
    const profileId = String(metadata?.source_profile || "").trim();
    if (!profileId) fail(`${metadata.topic}: missing source_profile.`);

    profile = sourceFile?.profiles?.[profileId];
    if (!profile) fail(`${metadata.topic}: unknown source_profile ${profileId}.`);
    if (profile.status !== "active") {
      fail(`${metadata.topic}: source_profile ${profileId} is not active.`);
    }
  }

  if (["apxn", "hybrid"].includes(mode)) {
    if (!Array.isArray(metadata.knowledge_sections) || metadata.knowledge_sections.length === 0) {
      fail(`${metadata.topic}: APXN/hybrid topic has no knowledge_sections.`);
    }

    for (const knowledgePath of metadata.knowledge_sections) {
      if (getAtPath(knowledge, knowledgePath) === undefined) {
        fail(`${metadata.topic}: unknown APXN knowledge section ${knowledgePath}.`);
      }
    }
  }

  return { mode, profile };
}

export function loadTopicByIdOrTitle(selector, topicBank = readJson(PATHS.topicBank)) {
  const topics = Array.isArray(topicBank?.topics) ? topicBank.topics : [];
  const cleanSelector = normalizeSpace(selector);

  if (cleanSelector) {
    const byId = topics.find((topic) => topic.id === cleanSelector);
    if (byId) return byId;

    const normalized = normalizeTopic(cleanSelector);
    const byTitle = topics.find((topic) => normalizeTopic(topic.topic) === normalized);
    if (byTitle) return byTitle;

    fail(`No topic-bank entry matches: ${cleanSelector}`);
  }

  const automatic = topics.find(
    (topic) =>
      topic.status === "available" &&
      topic.auto_publish_allowed === true &&
      ["apxn", "external", "hybrid"].includes(String(topic.content_mode || "").toLowerCase())
  );

  if (!automatic) fail("No eligible automatic topic is available in the topic bank.");
  return automatic;
}

export async function buildResearchPacketForTopic(metadata, options = {}) {
  const sourceFile = options.sourceFile || readJson(PATHS.sourceProfiles);
  const knowledge = options.knowledge || readJson(PATHS.knowledge);
  const config = options.config || readJson(PATHS.config);

  if (sourceFile?.rules?.open_web_research_allowed !== false) {
    fail("Source profile rules must keep open_web_research_allowed=false.");
  }

  if (sourceFile?.rules?.approved_sources_only !== true) {
    fail("Source profile rules must keep approved_sources_only=true.");
  }

  const { mode, profile } = validateTopicMetadata(metadata, sourceFile, knowledge);

  if (mode === "manual" || metadata.auto_publish_allowed === false) {
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      generated_date: todayISO(),
      status: "MANUAL_REVIEW_REQUIRED",
      topic: metadata,
      reason: "This topic is not eligible for automatic research/writing.",
      paid_ai_calls: 0
    };
  }

  const externalResult = ["external", "hybrid"].includes(mode)
    ? await collectExternalEvidence(metadata, profile)
    : { pages: [], errors: [], evidence: [] };

  const apxnEvidence = ["apxn", "hybrid"].includes(mode)
    ? collectApxnEvidence(metadata, knowledge)
    : [];

  const evidence = [...apxnEvidence, ...externalResult.evidence];
  const sufficiency = evaluateResearchSufficiency(metadata, evidence, profile);
  const writingPlan = sufficiency.ready ? buildWritingPlan(metadata, evidence) : null;

  const packet = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generated_date: todayISO(),
    status: sufficiency.ready ? "READY_FOR_PAID_WRITER" : "INSUFFICIENT_RESEARCH",
    paid_ai_calls: 0,
    topic: {
      id: metadata.id || null,
      topic: metadata.topic,
      slug: slugify(metadata.topic),
      category: metadata.category,
      risk: metadata.risk || "safe",
      content_mode: mode,
      source_profile: metadata.source_profile || null,
      knowledge_sections: metadata.knowledge_sections || [],
      auto_publish_allowed: metadata.auto_publish_allowed === true,
      editorial_guard: metadata.editorial_guard || null
    },
    policy: {
      open_web_research_allowed: false,
      model_memory_as_source_allowed: false,
      approved_official_sources_only: true,
      writer_may_add_facts_outside_packet: false,
      minimum_article_words: Number(config?.writer?.minimum_words || ARTICLE_WORD_PLAN.minimum),
      target_article_words: Number(config?.writer?.target_words || ARTICLE_WORD_PLAN.target),
      maximum_article_words: Number(config?.writer?.maximum_words || ARTICLE_WORD_PLAN.maximum)
    },
    sufficiency,
    source_fetch: {
      approved_profile: profile
        ? {
            id: metadata.source_profile,
            name: profile.name,
            min_sources: profile.min_sources,
            allowed_domains: profile.allowed_domains,
            volatile_fact_policy: profile.volatile_fact_policy
          }
        : null,
      pages: externalResult.pages,
      errors: externalResult.errors
    },
    sources: packetSources(evidence),
    allowed_numeric_tokens: collectAllowedNumericTokens(evidence),
    forbidden_claims: buildForbiddenClaims(metadata, profile),
    evidence,
    writing_plan: writingPlan
  };

  return packet;
}

function parseCliArguments(argv) {
  const result = {
    topicSelector: process.env.BLOG_RESEARCH_TOPIC_ID || process.env.BLOG_RESEARCH_TOPIC || "",
    output: process.env.BLOG_RESEARCH_OUTPUT || ""
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--topic-id" || arg === "--topic") {
      result.topicSelector = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--output") {
      result.output = argv[index + 1] || "";
      index += 1;
    }
  }

  return result;
}

async function runCli() {
  const args = parseCliArguments(process.argv.slice(2));
  const topicBank = readJson(PATHS.topicBank);
  const metadata = loadTopicByIdOrTitle(args.topicSelector, topicBank);

  console.log("APXN Free Research Compiler");
  console.log("---------------------------");
  console.log(`Topic: ${metadata.topic}`);
  console.log(`Mode: ${metadata.content_mode}`);
  console.log(`Source profile: ${metadata.source_profile || "APXN knowledge only"}`);
  console.log("Paid AI calls: 0");

  const packet = await buildResearchPacketForTopic(metadata);
  const outputPath = args.output
    ? path.resolve(ROOT, args.output)
    : path.join(PATHS.outputDir, `${slugify(metadata.topic)}.research-packet.json`);

  writeJson(outputPath, packet);

  console.log(`Research status: ${packet.status}`);
  console.log(`Research packet: ${path.relative(ROOT, outputPath)}`);

  if (packet.sufficiency?.metrics) {
    const metrics = packet.sufficiency.metrics;
    console.log(`Evidence items: ${metrics.evidence_items}`);
    console.log(`Evidence words: ${metrics.total_words}`);
    console.log(`External evidence words: ${metrics.external_words}`);
    console.log(`APXN evidence words: ${metrics.apxn_words}`);
    console.log(`Distinct external pages: ${metrics.distinct_external_pages}`);
  }

  if (packet.status === "INSUFFICIENT_RESEARCH") {
    for (const reason of packet.sufficiency?.reasons || []) {
      console.log(`SKIP: ${reason}`);
    }
  }
}

const isDirectRun = (() => {
  try {
    return path.resolve(process.argv[1] || "") === __filename;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runCli().catch((error) => {
    console.error(`\nERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

