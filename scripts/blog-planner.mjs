/**
 * APXN Blog Topic Planner
 * Path: scripts/blog-planner.mjs
 *
 * Purpose:
 * - Keeps the APXN Blog generation queue supplied with safe English topics.
 * - Reads data/blog-articles.json and data/blog-topic-bank.json.
 * - Never calls xAI or any external API.
 * - Never publishes articles.
 * - Avoids duplicate topics already published, drafted, queued, or previously used.
 * - Moves selected topic-bank entries from "available" to "queued".
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
  manifest: path.join(ROOT, "data", "blog-articles.json"),
  topicBank: path.join(ROOT, "data", "blog-topic-bank.json")
};

const SETTINGS = {
  minimumWaitingTopics: 6,
  targetWaitingTopics: 12,
  maximumQueueSize: 50,
  language: "en"
};

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

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function nextPriority(queue) {
  let max = 0;

  for (const item of queue) {
    const priority = Number(item?.priority);
    if (Number.isFinite(priority)) {
      max = Math.max(max, priority);
    }
  }

  return max + 1;
}

function countWaiting(queue) {
  return queue.filter((item) => item?.status === "waiting").length;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    fail("data/blog-articles.json must contain a JSON object.");
  }

  if (!Array.isArray(manifest.articles)) {
    fail("data/blog-articles.json must contain an articles array.");
  }

  if (!Array.isArray(manifest.generation_queue)) {
    fail("data/blog-articles.json must contain a generation_queue array.");
  }

  const defaultLanguage = String(manifest.default_language || "en").toLowerCase();

  if (defaultLanguage !== SETTINGS.language) {
    fail(
      `The planner is English-only, but blog-articles.json default_language is "${defaultLanguage}".`
    );
  }
}

function validateTopicBank(bank) {
  if (!bank || typeof bank !== "object") {
    fail("data/blog-topic-bank.json must contain a JSON object.");
  }

  if (!Array.isArray(bank.topics)) {
    fail("data/blog-topic-bank.json must contain a topics array.");
  }

  const language = String(bank.language || "").toLowerCase();

  if (language !== SETTINGS.language) {
    fail(
      `The topic bank must use language "${SETTINGS.language}", found "${language || "missing"}".`
    );
  }

  if (bank?.rules?.english_only !== true) {
    fail("data/blog-topic-bank.json must keep rules.english_only=true.");
  }
}

/* -------------------------------------------------------------------------- */
/* Duplicate protection                                                       */
/* -------------------------------------------------------------------------- */

function collectExistingKeys(manifest) {
  const topicKeys = new Set();
  const slugKeys = new Set();

  for (const article of manifest.articles) {
    const title = normalizeTopic(article?.title);
    const slug = slugify(article?.slug || article?.title || "");

    if (title) topicKeys.add(title);
    if (slug) slugKeys.add(slug);
  }

  for (const item of manifest.generation_queue) {
    const topic = normalizeTopic(item?.topic);
    const slug = slugify(item?.slug || item?.slug_hint || item?.topic || "");

    if (topic) topicKeys.add(topic);
    if (slug) slugKeys.add(slug);
  }

  return { topicKeys, slugKeys };
}

function isDuplicateBankItem(item, keys) {
  const topicKey = normalizeTopic(item?.topic);
  const slugKey = slugify(item?.slug_hint || item?.topic || "");

  if (!topicKey || !slugKey) {
    return true;
  }

  return keys.topicKeys.has(topicKey) || keys.slugKeys.has(slugKey);
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

function eligibleBankTopics(bank, manifest) {
  const keys = collectExistingKeys(manifest);

  return bank.topics.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.status !== "available") return false;
    if (String(item.risk || "").toLowerCase() !== "safe") return false;
    if (!normalizeSpace(item.topic)) return false;
    if (!normalizeSpace(item.category)) return false;
    if (isDuplicateBankItem(item, keys)) return false;

    return true;
  });
}

function addTopicsToQueue({ manifest, bank, quantity, date }) {
  if (quantity <= 0) {
    return [];
  }

  const selected = eligibleBankTopics(bank, manifest).slice(0, quantity);

  if (selected.length === 0) {
    return [];
  }

  let priority = nextPriority(manifest.generation_queue);
  const added = [];

  for (const bankItem of selected) {
    const queueItem = {
      priority,
      topic: normalizeSpace(bankItem.topic),
      category: normalizeSpace(bankItem.category),
      status: "waiting",
      source: "topic_bank",
      topic_bank_id: bankItem.id,
      language: SETTINGS.language,
      queued_at: date
    };

    manifest.generation_queue.push(queueItem);

    Object.assign(bankItem, {
      status: "queued",
      queued_at: date,
      queue_priority: priority
    });

    added.push(queueItem);
    priority += 1;
  }

  return added;
}

function updatePlannerState(manifest, bank, date, added) {
  manifest.automation_state = manifest.automation_state || {};

  const waiting = manifest.generation_queue
    .filter((item) => item?.status === "waiting")
    .sort((a, b) => Number(a.priority || 999999) - Number(b.priority || 999999));

  manifest.automation_state.next_queue_priority =
    waiting.length > 0 ? waiting[0].priority : null;

  manifest.automation_state.topic_planner = {
    last_run: date,
    added_topics: added.length,
    waiting_topics_after_run: waiting.length,
    minimum_waiting_topics: SETTINGS.minimumWaitingTopics,
    target_waiting_topics: SETTINGS.targetWaitingTopics
  };

  manifest.last_updated = date;

  bank.last_updated = date;
  bank.planner_state = {
    last_run: date,
    available_topics: bank.topics.filter((item) => item?.status === "available").length,
    queued_topics: bank.topics.filter((item) => item?.status === "queued").length,
    used_topics: bank.topics.filter((item) =>
      ["used", "published", "drafted"].includes(item?.status)
    ).length
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function main() {
  const manifest = readJson(PATHS.manifest);
  const bank = readJson(PATHS.topicBank);

  validateManifest(manifest);
  validateTopicBank(bank);

  if (manifest.generation_queue.length > SETTINGS.maximumQueueSize) {
    fail(
      `Generation queue contains ${manifest.generation_queue.length} items, above the safety limit of ${SETTINGS.maximumQueueSize}.`
    );
  }

  const date = todayISO();
  const waitingBefore = countWaiting(manifest.generation_queue);

  console.log("APXN Blog Topic Planner");
  console.log("-----------------------");
  console.log(`Language: ${SETTINGS.language}`);
  console.log(`Waiting topics before run: ${waitingBefore}`);
  console.log(`Minimum waiting threshold: ${SETTINGS.minimumWaitingTopics}`);
  console.log(`Target waiting count: ${SETTINGS.targetWaitingTopics}`);

  let added = [];

  if (waitingBefore < SETTINGS.minimumWaitingTopics) {
    const needed = Math.max(
      0,
      SETTINGS.targetWaitingTopics - waitingBefore
    );

    const remainingCapacity = Math.max(
      0,
      SETTINGS.maximumQueueSize - manifest.generation_queue.length
    );

    const quantity = Math.min(needed, remainingCapacity);

    added = addTopicsToQueue({
      manifest,
      bank,
      quantity,
      date
    });
  }

  updatePlannerState(manifest, bank, date, added);

  writeJson(PATHS.manifest, manifest);
  writeJson(PATHS.topicBank, bank);

  const waitingAfter = countWaiting(manifest.generation_queue);

  if (added.length === 0) {
    if (waitingBefore >= SETTINGS.minimumWaitingTopics) {
      console.log(
        `No replenishment needed. The queue already has ${waitingBefore} waiting topics.`
      );
    } else {
      console.log(
        "No eligible safe topic-bank entries were available for replenishment."
      );
    }
  } else {
    console.log(`Added ${added.length} topic(s):`);

    for (const item of added) {
      console.log(`- [${item.priority}] ${item.topic}`);
    }
  }

  console.log(`Waiting topics after run: ${waitingAfter}`);
  console.log(`Updated: ${path.relative(ROOT, PATHS.manifest)}`);
  console.log(`Updated: ${path.relative(ROOT, PATHS.topicBank)}`);
}

try {
  main();
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
}

