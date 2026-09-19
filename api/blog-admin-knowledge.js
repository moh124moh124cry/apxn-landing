import { createHash } from 'node:crypto';
import { isBlogAdminAuthenticated } from './blog-admin-auth.js';

const REPOSITORY =
    process.env.BLOG_GITHUB_REPO ||
    'moh124moh124cry/apxn-landing';

const BRANCH =
    process.env.BLOG_GITHUB_BRANCH ||
    'main';

const GITHUB_API = 'https://api.github.com';

const KNOWLEDGE_PATH =
    'data/apxn-blog-knowledge.json';

const TOPICS_PATH =
    'data/blog-topic-bank.json';

const ARTICLES_PATH =
    'data/blog-articles.json';

const MAX_TEXT_LENGTH = 50000;
const MIN_TEXT_LENGTH = 30;
const MIN_ARTICLE_SOURCE_WORDS = 480;
const MAX_SOURCES_PER_ARTICLE = 20;

const ALLOWED_TYPES = new Set([
    'conversation',
    'app',
    'website',
    'roadmap',
    'other'
]);

function reply(res, status, result) {
    res.setHeader(
        'Cache-Control',
        'no-store, max-age=0'
    );

    res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
    );

    return res.status(status).json(result);
}

function sameOrigin(req) {
    const origin = req.headers.origin;

    if (!origin) {
        return true;
    }

    try {
        return (
            new URL(origin).host.toLowerCase() ===
            String(req.headers.host || '').toLowerCase()
        );
    } catch {
        return false;
    }
}

function normalize(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function countWords(value) {
    const clean = normalize(value);

    return clean
        ? clean.split(' ').filter(Boolean).length
        : 0;
}

function dateInAlgiers() {
    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Africa/Algiers',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }
    ).format(new Date());
}

function containsPossibleSecret(value) {
    const text = String(value || '');

    const patterns = [
        /gh[pousr]_[A-Za-z0-9]{20,}/i,

        /github_pat_[A-Za-z0-9_]{20,}/i,

        /sk-[A-Za-z0-9_-]{16,}/i,

        /xai-[A-Za-z0-9_-]{16,}/i,

        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,

        /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/,

        /(?:BOT_TOKEN|XAI_API_KEY|BLOG_GITHUB_TOKEN|SUPABASE_SERVICE_ROLE_KEY|TELEGRAM_BOT_TOKEN)\s*[:=]\s*["']?[^\s"',]{10,}/i,

        /(?:Authorization|Bearer)\s*[:= ]\s*["']?[A-Za-z0-9._-]{25,}/i,

        /(?:seed phrase|recovery phrase|mnemonic)\s*[:=]\s*\S{12,}/i
    ];

    return patterns.some(
        (pattern) => pattern.test(text)
    );
}

function splitEvidence(value) {
    const words = normalize(value)
        .split(' ')
        .filter(Boolean);

    const evidence = [];

    for (
        let index = 0;
        index < words.length;
        index += 72
    ) {
        evidence.push(
            words
                .slice(index, index + 72)
                .join(' ')
        );
    }

    return evidence;
}

function makeHeadline(title, text) {
    if (title) {
        return normalize(title).slice(0, 110);
    }

    const firstLine = String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

    return normalize(
        firstLine || 'APXN project update'
    )
        .replace(
            /^(?:user|assistant|المستخدم|المساعد)\s*[:：]\s*/i,
            ''
        )
        .slice(0, 110);
}

function getGithubToken() {
    const token = String(
        process.env.BLOG_GITHUB_TOKEN || ''
    ).trim();

    return token.length >= 20
        ? token
        : null;
}

async function githubRequest(
    endpoint,
    token,
    method = 'GET',
    body = undefined
) {
    const response = await fetch(
        `${GITHUB_API}${endpoint}`,
        {
            method,

            headers: {
                Authorization: `Bearer ${token}`,

                Accept:
                    'application/vnd.github+json',

                'X-GitHub-Api-Version':
                    '2022-11-28',

                'Content-Type':
                    'application/json',

                'User-Agent':
                    'APXN-Blog-Admin'
            },

            body:
                body === undefined
                    ? undefined
                    : JSON.stringify(body)
        }
    );

    const data = await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
        const error = new Error(
            'GITHUB_REQUEST_FAILED'
        );

        error.status = response.status;

        throw error;
    }

    return data;
}

async function readJsonFromTree(
    tree,
    path,
    token
) {
    const entry = tree.tree.find(
        (item) =>
            item.path === path &&
            item.type === 'blob'
    );

    if (!entry) {
        throw new Error(
            `MISSING_FILE:${path}`
        );
    }

    const blob = await githubRequest(
        `/repos/${REPOSITORY}/git/blobs/${entry.sha}`,
        token
    );

    if (
        blob.encoding !== 'base64' ||
        typeof blob.content !== 'string'
    ) {
        throw new Error(
            `INVALID_FILE:${path}`
        );
    }

    const content = Buffer
        .from(
            blob.content.replace(/\n/g, ''),
            'base64'
        )
        .toString('utf8');

    return JSON.parse(content);
}

function nextPriority(queue) {
    const waiting = queue
        .filter(
            (item) =>
                item.status === 'waiting'
        )
        .map(
            (item) =>
                Number(item.priority)
        )
        .filter(Number.isFinite);

    return waiting.length
        ? Math.min(...waiting) - 1
        : 1;
}

function pendingSources(knowledge) {
    return Object.entries(
        knowledge.editorial_submissions || {}
    )
        .filter(
            ([, item]) =>
                !item.queued_for_article_id
        )
        .slice(
            0,
            MAX_SOURCES_PER_ARTICLE
        );
}

function sourceWordCount(source) {
    return (
        source.evidence || []
    ).reduce(
        (total, passage) =>
            total + countWords(passage),
        0
    );
}

function prepareNewsTopic(
    knowledge,
    bank,
    manifest,
    date
) {
    const selected = pendingSources(
        knowledge
    );

    const totalWords = selected.reduce(
        (total, [, source]) =>
            total + sourceWordCount(source),
        0
    );

    // Short notes stay in the knowledge bank.
    // They do not block the existing article queue.
    if (
        totalWords <
        MIN_ARTICLE_SOURCE_WORDS
    ) {
        return {
            queued: false,
            source_words: totalWords
        };
    }

    const sourceIds = selected.map(
        ([id]) => id
    );

    const hash = createHash('sha256')
        .update(sourceIds.join('|'))
        .digest('hex')
        .slice(0, 12);

    const topicId =
        `bank-admin-${hash}`;

    const firstTitle =
        selected[0][1].title;

    const topicTitle =
        selected.length === 1
            ? `APXN Project News: ${firstTitle} (${hash})`
            : `APXN Project News: Latest Project Development Updates (${hash})`;

    const knowledgeSections =
        sourceIds.map(
            (id) =>
                `editorial_submissions.${id}.evidence`
        );

    const editorialGuard =
        'Use only the administrator-submitted APXN information. ' +
        'Do not invent implementation details. ' +
        'Do not present a discussion, proposal or roadmap decision ' +
        'as an already implemented feature unless the submitted ' +
        'material explicitly confirms implementation. ' +
        'Do not promise token value, profit, listing or withdrawal.';

    // Only an authenticated administrator can create
    // the approved APXN News sources handled here.
    bank.category_policy['APXN News'] = {
        automation: 'approved_admin_source',

        rule:
            'Use only information explicitly submitted ' +
            'through the authenticated APXN Blog Admin. ' +
            'Never invent project news.'
    };

    bank.topics.push({
        id: topicId,

        topic: topicTitle,

        category: 'APXN News',

        risk: 'safe',

        status: 'queued',

        source:
            'admin_editorial_submission',

        content_mode: 'apxn',

        source_profile: null,

        knowledge_sections:
            knowledgeSections,

        auto_publish_allowed: true,

        editorial_guard:
            editorialGuard,

        queued_at: date
    });

    manifest.generation_queue.push({
        priority:
            nextPriority(
                manifest.generation_queue
            ),

        topic: topicTitle,

        category: 'APXN News',

        status: 'waiting',

        source:
            'admin_editorial_submission',

        topic_bank_id:
            topicId,

        language: 'en',

        queued_at: date,

        content_mode: 'apxn',

        source_profile: null,

        knowledge_sections:
            knowledgeSections,

        auto_publish_allowed: true,

        editorial_guard:
            editorialGuard
    });

    for (const id of sourceIds) {
        knowledge
            .editorial_submissions[id]
            .queued_for_article_id =
            topicId;
    }

    bank.last_updated = date;

    manifest.last_updated = date;

    return {
        queued: true,

        topic_id: topicId,

        source_words: totalWords,

        included_sources:
            sourceIds.length
    };
}

async function commitJsonFiles(
    currentRef,
    currentCommit,
    changes,
    token
) {
    const entries = [];

    for (const [path, value] of changes) {
        const blob = await githubRequest(
            `/repos/${REPOSITORY}/git/blobs`,
            token,
            'POST',
            {
                content:
                    JSON.stringify(
                        value,
                        null,
                        2
                    ) + '\n',

                encoding: 'utf-8'
            }
        );

        entries.push({
            path,

            mode: '100644',

            type: 'blob',

            sha: blob.sha
        });
    }

    const tree = await githubRequest(
        `/repos/${REPOSITORY}/git/trees`,
        token,
        'POST',
        {
            base_tree:
                currentCommit.tree.sha,

            tree: entries
        }
    );

    const commit = await githubRequest(
        `/repos/${REPOSITORY}/git/commits`,
        token,
        'POST',
        {
            message:
                'feat(blog): save admin editorial knowledge',

            tree: tree.sha,

            parents: [
                currentRef.object.sha
            ]
        }
    );

    await githubRequest(
        `/repos/${REPOSITORY}/git/refs/heads/${encodeURIComponent(BRANCH)}`,
        token,
        'PATCH',
        {
            sha: commit.sha,

            force: false
        }
    );

    return commit.sha;
}

export default async function handler(
    req,
    res
) {
    if (req.method !== 'POST') {
        res.setHeader(
            'Allow',
            'POST'
        );

        return reply(
            res,
            405,
            {
                success: false,
                error:
                    'METHOD_NOT_ALLOWED'
            }
        );
    }

    if (!sameOrigin(req)) {
        return reply(
            res,
            403,
            {
                success: false,
                error:
                    'INVALID_ORIGIN'
            }
        );
    }

    if (
        !isBlogAdminAuthenticated(req)
    ) {
        return reply(
            res,
            401,
            {
                success: false,
                error:
                    'UNAUTHORIZED'
            }
        );
    }

    const token =
        getGithubToken();

    if (!token) {
        return reply(
            res,
            503,
            {
                success: false,
                error:
                    'BLOG_GITHUB_TOKEN_NOT_CONFIGURED'
            }
        );
    }

    const body =
        req.body || {};

    const text =
        typeof body.text === 'string'
            ? body.text.trim()
            : '';

    const title =
        typeof body.title === 'string'
            ? body.title.trim()
            : '';

    const type =
        ALLOWED_TYPES.has(body.type)
            ? body.type
            : 'other';

    if (
        text.length <
            MIN_TEXT_LENGTH ||
        text.length >
            MAX_TEXT_LENGTH ||
        title.length > 150
    ) {
        return reply(
            res,
            400,
            {
                success: false,
                error:
                    'INVALID_TEXT_LENGTH'
            }
        );
    }

    // The repository is public.
    // Never save an input without the
    // administrator's explicit confirmation.
    if (
        body.public_content_confirmed !==
        true
    ) {
        return reply(
            res,
            400,
            {
                success: false,
                error:
                    'PUBLIC_CONFIRMATION_REQUIRED'
            }
        );
    }

    if (
        containsPossibleSecret(
            text + '\n' + title
        )
    ) {
        return reply(
            res,
            400,
            {
                success: false,
                error:
                    'SENSITIVE_CONTENT_DETECTED'
            }
        );
    }

    const normalizedText =
        normalize(text);

    const fingerprint =
        createHash('sha256')
            .update(normalizedText)
            .digest('hex');

    const sourceId =
        `submission_${fingerprint.slice(0, 16)}`;

    try {
        const ref =
            await githubRequest(
                `/repos/${REPOSITORY}/git/ref/heads/${encodeURIComponent(BRANCH)}`,
                token
            );

        const currentCommit =
            await githubRequest(
                `/repos/${REPOSITORY}/git/commits/${ref.object.sha}`,
                token
            );

        const currentTree =
            await githubRequest(
                `/repos/${REPOSITORY}/git/trees/${currentCommit.tree.sha}?recursive=1`,
                token
            );

        const knowledge =
            await readJsonFromTree(
                currentTree,
                KNOWLEDGE_PATH,
                token
            );

        const bank =
            await readJsonFromTree(
                currentTree,
                TOPICS_PATH,
                token
            );

        const manifest =
            await readJsonFromTree(
                currentTree,
                ARTICLES_PATH,
                token
            );

        if (
            !Array.isArray(bank.topics) ||
            !bank.category_policy ||
            !Array.isArray(
                manifest.generation_queue
            )
        ) {
            throw new Error(
                'INVALID_BLOG_DATA'
            );
        }

        if (
            !knowledge.editorial_submissions
        ) {
            knowledge.editorial_submissions =
                {};
        }

        if (
            knowledge
                .editorial_submissions[
                    sourceId
                ]
        ) {
            return reply(
                res,
                409,
                {
                    success: false,
                    error:
                        'DUPLICATE_SUBMISSION'
                }
            );
        }

        const date =
            dateInAlgiers();

        knowledge
            .editorial_submissions[
                sourceId
            ] = {

                title:
                    makeHeadline(
                        title,
                        text
                    ),

                type,

                submitted_at: date,

                source_status:
                    'administrator_supplied',

                verification_note:
                    'Founder-provided information. ' +
                    'A discussion or proposal is not ' +
                    'automatically an implemented feature.',

                evidence:
                    splitEvidence(
                        text
                    ),

                queued_for_article_id:
                    null
            };

        const news =
            prepareNewsTopic(
                knowledge,
                bank,
                manifest,
                date
            );

        const changes = [
            [
                KNOWLEDGE_PATH,
                knowledge
            ]
        ];

        if (news.queued) {
            changes.push(
                [
                    TOPICS_PATH,
                    bank
                ],
                [
                    ARTICLES_PATH,
                    manifest
                ]
            );
        }

        const commitSha =
            await commitJsonFiles(
                ref,
                currentCommit,
                changes,
                token
            );

        return reply(
            res,
            200,
            {
                success: true,

                source_id:
                    sourceId,

                saved_to_knowledge:
                    true,

                news_topic_queued:
                    news.queued,

                commit_sha:
                    commitSha
            }
        );

    } catch (error) {
        if (
            error.status === 409 ||
            error.status === 422
        ) {
            return reply(
                res,
                409,
                {
                    success: false,
                    error:
                        'GITHUB_CONFLICT_RETRY'
                }
            );
        }

        console.error(
            'APXN knowledge save:',
            error.message
        );

        return reply(
            res,
            500,
            {
                success: false,
                error:
                    'KNOWLEDGE_SAVE_FAILED'
            }
        );
    }
}

