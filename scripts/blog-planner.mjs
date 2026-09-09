/**
 * APXN Blog Topic Planner
 * Path: scripts/blog-planner.mjs
 *
 * Purpose:
 * - Keeps the APXN Blog queue supplied with safe English topics.
 * - Reads data/blog-articles.json and data/blog-topic-bank.json.
 * - Never calls xAI or any external API.
 * - Never publishes articles.
 * - Preserves topic metadata required by the writer:
 *   content_mode, source_profile, knowledge_sections,
 *   auto_publish_allowed and editorial_guard.
 * - Never auto-queues manual-review topics.
 * - Balances queued topics across the blog's editorial categories.
 * - Avoids duplicate topics already published, drafted, queued or used.
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
  language: "en",
  supportedContentModes: new Set(["apxn", "external", "hybrid", "manual"]),
  categoryOrder: [
    "APXN Guides",
    "Blockchain",
    "Web3",
    "BSC",
    "Security",
    "Education",
    "Development"
  ]
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

function cloneArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item))
    : [];
}

function categoryRank(category) {
  const index = SETTINGS.categoryOrder.indexOf(category);

  return index === -1
    ? Number.MAX_SAFE_INTEGER
    : index;
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

  const defaultLanguage = String(
    manifest.default_language || "en"
  ).toLowerCase();

  if (defaultLanguage !== SETTINGS.language) {
    fail(
      `The planner is English-only, but blog-articles.json default_language is "${defaultLanguage}".`
    );
  }

  if (
    manifest.generation_queue.length >
    SETTINGS.maximumQueueSize
  ) {
    fail(
      `Generation queue contains ${manifest.generation_queue.length} items, above the safety limit of ${SETTINGS.maximumQueueSize}.`
    );
  }
}

function validateTopicBank(bank) {
  if (!bank || typeof bank !== "object") {
    fail("data/blog-topic-bank.json must contain a JSON object.");
  }

  if (Number(bank.schema_version || 0) < 2) {
    fail(
      "data/blog-topic-bank.json must use schema_version 2 or newer."
    );
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
    fail(
      "data/blog-topic-bank.json must keep rules.english_only=true."
    );
  }

  if (
    bank?.rules?.open_web_research_allowed !== false
  ) {
    fail(
      "data/blog-topic-bank.json must keep rules.open_web_research_allowed=false."
    );
  }

  if (
    bank?.rules?.approved_official_sources_only !== true
  ) {
    fail(
      "data/blog-topic-bank.json must keep rules.approved_official_sources_only=true."
    );
  }

  if (
    bank?.rules?.manual_topics_must_not_auto_publish !== true
  ) {
    fail(
      "data/blog-topic-bank.json must keep rules.manual_topics_must_not_auto_publish=true."
    );
  }

  if (
    !bank.category_policy ||
    typeof bank.category_policy !== "object"
  ) {
    fail(
      "data/blog-topic-bank.json must contain category_policy."
    );
  }

  const seenIds = new Set();

  for (const item of bank.topics) {
    validateBankTopic(item, bank, seenIds);
  }
}

function validateBankTopic(item, bank, seenIds) {
  if (!item || typeof item !== "object") {
    fail(
      "Every topic-bank entry must be an object."
    );
  }

  const id = normalizeSpace(item.id);
  const topic = normalizeSpace(item.topic);
  const category = normalizeSpace(item.category);
  const mode = normalizeSpace(
    item.content_mode
  ).toLowerCase();

  if (!id) {
    fail("A topic-bank entry is missing id.");
  }

  if (seenIds.has(id)) {
    fail(`Duplicate topic-bank id: ${id}.`);
  }

  seenIds.add(id);

  if (!topic) {
    fail(`${id} is missing topic.`);
  }

  if (!category) {
    fail(`${id} is missing category.`);
  }

  if (!bank.category_policy[category]) {
    fail(
      `${id} uses unknown category "${category}".`
    );
  }

  if (
    !SETTINGS.supportedContentModes.has(mode)
  ) {
    fail(
      `${id} has unsupported content_mode "${mode || "missing"}".`
    );
  }

  if (!Array.isArray(item.knowledge_sections)) {
    fail(
      `${id} must contain knowledge_sections as an array.`
    );
  }

  if (
    mode === "apxn" &&
    item.knowledge_sections.length === 0
  ) {
    fail(
      `${id} is APXN-only but has no knowledge_sections.`
    );
  }

  if (
    mode === "external" &&
    !normalizeSpace(item.source_profile)
  ) {
    fail(
      `${id} is external but has no source_profile.`
    );
  }

  if (mode === "hybrid") {
    if (!normalizeSpace(item.source_profile)) {
      fail(
        `${id} is hybrid but has no source_profile.`
      );
    }

    if (item.knowledge_sections.length === 0) {
      fail(
        `${id} is hybrid but has no APXN knowledge_sections.`
      );
    }
  }

  if (
    mode === "manual" &&
    item.auto_publish_allowed !== false
  ) {
    fail(
      `${id} is manual but auto_publish_allowed is not false.`
    );
  }

  if (
    String(item.risk || "").toLowerCase() !== "safe" &&
    item.auto_publish_allowed === true
  ) {
    fail(
      `${id} has non-safe risk but auto_publish_allowed=true.`
    );
  }

  const categoryAutomation = String(
    bank.category_policy?.[category]?.automation || ""
  ).toLowerCase();

  if (
    categoryAutomation === "manual_source_required" &&
    item.auto_publish_allowed === true
  ) {
    fail(
      `${id} is in ${category}, which requires a manual source, but auto publishing is enabled.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Duplicate protection                                                       */
/* -------------------------------------------------------------------------- */

function collectExistingKeys(manifest) {
  const topicKeys = new Set();
  const slugKeys = new Set();

  for (const article of manifest.articles) {
    const title = normalizeTopic(
      article?.title
    );

    const slug = slugify(
      article?.slug ||
      article?.title ||
      ""
    );

    if (title) {
      topicKeys.add(title);
    }

    if (slug) {
      slugKeys.add(slug);
    }
  }

  for (const item of manifest.generation_queue) {
    const topic = normalizeTopic(
      item?.topic
    );

    const slug = slugify(
      item?.slug ||
      item?.slug_hint ||
      item?.topic ||
      ""
    );

    if (topic) {
      topicKeys.add(topic);
    }

    if (slug) {
      slugKeys.add(slug);
    }
  }

  return {
    topicKeys,
    slugKeys
  };
}

function isDuplicateBankItem(item, keys) {
  const topicKey = normalizeTopic(
    item?.topic
  );

  const slugKey = slugify(
    item?.slug_hint ||
    item?.topic ||
    ""
  );

  if (!topicKey || !slugKey) {
    return true;
  }

  return (
    keys.topicKeys.has(topicKey) ||
    keys.slugKeys.has(slugKey)
  );
}

/* -------------------------------------------------------------------------- */
/* Eligibility and category balancing                                         */
/* -------------------------------------------------------------------------- */

function isAutomationEligibleBankItem(
  item,
  bank,
  keys
) {
  if (!item || typeof item !== "object") {
    return false;
  }

  if (item.status !== "available") {
    return false;
  }

  if (
    String(item.risk || "").toLowerCase() !== "safe"
  ) {
    return false;
  }

  if (item.auto_publish_allowed !== true) {
    return false;
  }

  const mode = String(
    item.content_mode || ""
  ).toLowerCase();

  if (
    ![
      "apxn",
      "external",
      "hybrid"
    ].includes(mode)
  ) {
    return false;
  }

  const category = normalizeSpace(
    item.category
  );

  const categoryAutomation = String(
    bank.category_policy?.[category]?.automation || ""
  ).toLowerCase();

  if (
    !categoryAutomation ||
    categoryAutomation === "manual_source_required"
  ) {
    return false;
  }

  if (isDuplicateBankItem(item, keys)) {
    return false;
  }

  return true;
}

function categoryLoad(manifest) {
  const counts = new Map();

  for (
    const category of
    SETTINGS.categoryOrder
  ) {
    counts.set(category, 0);
  }

  /*
   * Published and draft records represent content
   * that already exists.
   */
  for (const article of manifest.articles) {
    if (
      ![
        "published",
        "draft"
      ].includes(
        String(article?.status || "")
      )
    ) {
      continue;
    }

    const category = normalizeSpace(
      article?.category
    );

    if (!counts.has(category)) {
      counts.set(category, 0);
    }

    counts.set(
      category,
      (counts.get(category) || 0) + 1
    );
  }

  /*
   * Only waiting queue items are counted here.
   * Drafted/published queue items are already
   * represented by manifest.articles.
   */
  for (
    const item of
    manifest.generation_queue
  ) {
    if (item?.status !== "waiting") {
      continue;
    }

    const category = normalizeSpace(
      item?.category
    );

    if (!counts.has(category)) {
      counts.set(category, 0);
    }

    counts.set(
      category,
      (counts.get(category) || 0) + 1
    );
  }

  return counts;
}

function buildEligiblePools(
  bank,
  manifest
) {
  const keys =
    collectExistingKeys(manifest);

  const pools = new Map();

  for (
    const category of
    SETTINGS.categoryOrder
  ) {
    pools.set(category, []);
  }

  for (const item of bank.topics) {
    if (
      !isAutomationEligibleBankItem(
        item,
        bank,
        keys
      )
    ) {
      continue;
    }

    const category = normalizeSpace(
      item.category
    );

    if (!pools.has(category)) {
      pools.set(category, []);
    }

    pools
      .get(category)
      .push(item);
  }

  for (const items of pools.values()) {
    items.sort(
      (a, b) =>
        String(a.id).localeCompare(
          String(b.id)
        )
    );
  }

  return pools;
}

function selectBalancedTopics({
  bank,
  manifest,
  quantity
}) {
  if (quantity <= 0) {
    return [];
  }

  const pools =
    buildEligiblePools(
      bank,
      manifest
    );

  const load =
    categoryLoad(manifest);

  const selected = [];

  while (
    selected.length < quantity
  ) {
    const candidates = [];

    for (
      const [category, items]
      of pools.entries()
    ) {
      if (!items.length) {
        continue;
      }

      candidates.push({
        category,
        load:
          load.get(category) || 0,
        rank:
          categoryRank(category)
      });
    }

    if (!candidates.length) {
      break;
    }

    candidates.sort(
      (a, b) => {
        if (a.load !== b.load) {
          return a.load - b.load;
        }

        if (a.rank !== b.rank) {
          return a.rank - b.rank;
        }

        return a.category.localeCompare(
          b.category
        );
      }
    );

    const chosenCategory =
      candidates[0].category;

    const chosen =
      pools
        .get(chosenCategory)
        .shift();

    selected.push(chosen);

    load.set(
      chosenCategory,
      (load.get(chosenCategory) || 0) + 1
    );
  }

  return selected;
}

/* -------------------------------------------------------------------------- */
/* Queue writing                                                              */
/* -------------------------------------------------------------------------- */

function queueMetadataFromBankItem(
  bankItem,
  priority,
  date
) {
  const queueItem = {
    priority,

    topic:
      normalizeSpace(
        bankItem.topic
      ),

    category:
      normalizeSpace(
        bankItem.category
      ),

    status: "waiting",

    source: "topic_bank",

    topic_bank_id:
      normalizeSpace(
        bankItem.id
      ),

    language:
      SETTINGS.language,

    queued_at:
      date,

    content_mode:
      normalizeSpace(
        bankItem.content_mode
      ).toLowerCase(),

    source_profile:
      bankItem.source_profile
        ? normalizeSpace(
            bankItem.source_profile
          )
        : null,

    knowledge_sections:
      cloneArray(
        bankItem.knowledge_sections
      ),

    auto_publish_allowed:
      bankItem.auto_publish_allowed === true
  };

  const editorialGuard =
    normalizeSpace(
      bankItem.editorial_guard
    );

  if (editorialGuard) {
    queueItem.editorial_guard =
      editorialGuard;
  }

  return queueItem;
}

function addTopicsToQueue({
  manifest,
  bank,
  quantity,
  date
}) {
  if (quantity <= 0) {
    return [];
  }

  const selected =
    selectBalancedTopics({
      bank,
      manifest,
      quantity
    });

  if (!selected.length) {
    return [];
  }

  let priority =
    nextPriority(
      manifest.generation_queue
    );

  const added = [];

  for (
    const bankItem of
    selected
  ) {
    const queueItem =
      queueMetadataFromBankItem(
        bankItem,
        priority,
        date
      );

    manifest
      .generation_queue
      .push(queueItem);

    Object.assign(
      bankItem,
      {
        status: "queued",
        queued_at: date,
        queue_priority: priority
      }
    );

    added.push(queueItem);

    priority += 1;
  }

  return added;
}

/* -------------------------------------------------------------------------- */
/* Planner state                                                              */
/* -------------------------------------------------------------------------- */

function categorySnapshot(manifest) {
  const counts =
    categoryLoad(manifest);

  const snapshot = {};

  for (
    const category of
    SETTINGS.categoryOrder
  ) {
    snapshot[category] =
      counts.get(category) || 0;
  }

  return snapshot;
}

function updatePlannerState(
  manifest,
  bank,
  date,
  added
) {
  manifest.automation_state =
    manifest.automation_state || {};

  const waiting =
    manifest.generation_queue
      .filter(
        (item) =>
          item?.status === "waiting"
      )
      .sort(
        (a, b) =>
          Number(
            a.priority || 999999
          ) -
          Number(
            b.priority || 999999
          )
      );

  manifest
    .automation_state
    .next_queue_priority =
      waiting.length > 0
        ? waiting[0].priority
        : null;

  manifest
    .automation_state
    .topic_planner = {
      last_run:
        date,

      added_topics:
        added.length,

      added_topic_ids:
        added.map(
          (item) =>
            item.topic_bank_id
        ),

      added_categories:
        added.map(
          (item) =>
            item.category
        ),

      waiting_topics_after_run:
        waiting.length,

      minimum_waiting_topics:
        SETTINGS.minimumWaitingTopics,

      target_waiting_topics:
        SETTINGS.targetWaitingTopics,

      category_load_after_run:
        categorySnapshot(manifest)
    };

  manifest.last_updated =
    date;

  bank.last_updated =
    date;

  bank.planner_state = {
    last_run:
      date,

    available_topics:
      bank.topics.filter(
        (item) =>
          item?.status === "available"
      ).length,

    automation_eligible_available_topics:
      bank.topics.filter(
        (item) =>
          item?.status === "available" &&
          item?.auto_publish_allowed === true &&
          String(
            item?.risk || ""
          ).toLowerCase() === "safe" &&
          [
            "apxn",
            "external",
            "hybrid"
          ].includes(
            String(
              item?.content_mode || ""
            ).toLowerCase()
          )
      ).length,

    manual_or_review_topics:
      bank.topics.filter(
        (item) =>
          item?.content_mode === "manual" ||
          item?.auto_publish_allowed === false ||
          String(
            item?.risk || ""
          ).toLowerCase() !== "safe"
      ).length,

    queued_topics:
      bank.topics.filter(
        (item) =>
          item?.status === "queued"
      ).length,

    used_topics:
      bank.topics.filter(
        (item) =>
          [
            "used",
            "published",
            "drafted"
          ].includes(
            item?.status
          )
      ).length,

    category_load_after_run:
      categorySnapshot(manifest)
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function main() {
  const manifest =
    readJson(
      PATHS.manifest
    );

  const bank =
    readJson(
      PATHS.topicBank
    );

  validateManifest(manifest);
  validateTopicBank(bank);

  const date =
    todayISO();

  const waitingBefore =
    countWaiting(
      manifest.generation_queue
    );

  console.log(
    "APXN Blog Topic Planner"
  );

  console.log(
    "-----------------------"
  );

  console.log(
    `Language: ${SETTINGS.language}`
  );

  console.log(
    `Waiting topics before run: ${waitingBefore}`
  );

  console.log(
    `Minimum waiting threshold: ${SETTINGS.minimumWaitingTopics}`
  );

  console.log(
    `Target waiting count: ${SETTINGS.targetWaitingTopics}`
  );

  console.log(
    "Open-web research: disabled"
  );

  console.log(
    "Approved official sources only: enabled"
  );

  console.log(
    "Manual-review topics: excluded from automatic queue"
  );

  let added = [];

  if (
    waitingBefore <
    SETTINGS.minimumWaitingTopics
  ) {
    const needed =
      Math.max(
        0,
        SETTINGS.targetWaitingTopics -
        waitingBefore
      );

    const remainingCapacity =
      Math.max(
        0,
        SETTINGS.maximumQueueSize -
        manifest.generation_queue.length
      );

    const quantity =
      Math.min(
        needed,
        remainingCapacity
      );

    added =
      addTopicsToQueue({
        manifest,
        bank,
        quantity,
        date
      });
  }

  updatePlannerState(
    manifest,
    bank,
    date,
    added
  );

  writeJson(
    PATHS.manifest,
    manifest
  );

  writeJson(
    PATHS.topicBank,
    bank
  );

  const waitingAfter =
    countWaiting(
      manifest.generation_queue
    );

  if (added.length === 0) {
    if (
      waitingBefore >=
      SETTINGS.minimumWaitingTopics
    ) {
      console.log(
        `No replenishment needed. The queue already has ${waitingBefore} waiting topics.`
      );
    } else {
      console.log(
        "No eligible automatic topic-bank entries were available for replenishment."
      );
    }
  } else {
    console.log(
      `Added ${added.length} balanced topic(s):`
    );

    for (const item of added) {
      console.log(
        `- [${item.priority}] [${item.category}] [${item.content_mode}] ${item.topic}`
      );
    }
  }

  console.log(
    `Waiting topics after run: ${waitingAfter}`
  );

  console.log(
    "Category load:"
  );

  for (
    const [category, count]
    of Object.entries(
      categorySnapshot(manifest)
    )
  ) {
    console.log(
      `- ${category}: ${count}`
    );
  }

  console.log(
    `Updated: ${path.relative(ROOT, PATHS.manifest)}`
  );

  console.log(
    `Updated: ${path.relative(ROOT, PATHS.topicBank)}`
  );
}

try {
  main();
} catch (error) {
  console.error(
    `\nERROR: ${error.message}`
  );

  process.exitCode = 1;
}
