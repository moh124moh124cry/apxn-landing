/**
 * APXN Blog Ready Writer
 *
 * Purpose:
 * - Use the existing professional blog-writer.mjs.
 * - Keep all research, SEO and quality checks.
 * - NEVER auto-publish an article.
 * - Save a successful generated article inside:
 *     data/blog-articles.json
 *   with:
 *     status: "ready"
 *
 * The article will then appear inside:
 *     /blog-admin/
 *
 * Publishing remains manual.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
    spawnSync
} from 'node:child_process';
import {
    fileURLToPath
} from 'node:url';


/* =====================================================
   PATHS
===================================================== */

const __filename =
    fileURLToPath(
        import.meta.url
    );

const __dirname =
    path.dirname(
        __filename
    );

const ROOT =
    path.resolve(
        __dirname,
        '..'
    );


const PATHS = {

    writer:
        path.join(
            ROOT,
            'scripts',
            'blog-writer.mjs'
        ),

    articles:
        path.join(
            ROOT,
            'data',
            'blog-articles.json'
        ),

    topicBank:
        path.join(
            ROOT,
            'data',
            'blog-topic-bank.json'
        ),

    drafts:
        path.join(
            ROOT,
            '.workflow-output',
            'drafts'
        )
};


/* =====================================================
   BASIC HELPERS
===================================================== */

function fail(
    message
) {

    throw new Error(
        message
    );
}


function readJson(
    filePath
) {

    if (
        !fs.existsSync(
            filePath
        )
    ) {

        fail(
            `Required file not found: ${
                path.relative(
                    ROOT,
                    filePath
                )
            }`
        );
    }


    try {

        return JSON.parse(
            fs.readFileSync(
                filePath,
                'utf8'
            )
        );

    } catch (error) {

        fail(
            `Invalid JSON in ${
                path.relative(
                    ROOT,
                    filePath
                )
            }: ${error.message}`
        );
    }
}


function writeJsonAtomic(
    filePath,
    value
) {

    const directory =
        path.dirname(
            filePath
        );


    fs.mkdirSync(
        directory,
        {
            recursive: true
        }
    );


    const temporary =
        `${filePath}.tmp-${process.pid}-${Date.now()}`;


    fs.writeFileSync(
        temporary,
        `${JSON.stringify(
            value,
            null,
            2
        )}\n`,
        'utf8'
    );


    fs.renameSync(
        temporary,
        filePath
    );
}


function cleanText(
    value
) {

    return String(
        value ?? ''
    )
        .replace(
            /\s+/g,
            ' '
        )
        .trim();
}


function normalizeTopic(
    value
) {

    return cleanText(
        value
    )
        .toLowerCase()
        .replace(
            /[’‘]/g,
            "'"
        )
        .replace(
            /[“”]/g,
            '"'
        )
        .replace(
            /[^a-z0-9]+/g,
            ' '
        )
        .replace(
            /\s+/g,
            ' '
        )
        .trim();
}


function slugify(
    value
) {

    return String(
        value || ''
    )
        .toLowerCase()
        .normalize(
            'NFKD'
        )
        .replace(
            /[^\x00-\x7F]/g,
            ''
        )
        .replace(
            /&/g,
            ' and '
        )
        .replace(
            /[^a-z0-9]+/g,
            '-'
        )
        .replace(
            /^-+|-+$/g,
            ''
        )
        .replace(
            /-{2,}/g,
            '-'
        )
        .slice(
            0,
            90
        );
}


function uniqueStrings(
    values,
    max = 100
) {

    const result = [];

    const seen =
        new Set();


    for (
        const value of
        Array.isArray(values)
            ? values
            : []
    ) {

        const clean =
            cleanText(
                value
            );


        const key =
            clean.toLowerCase();


        if (
            !clean ||
            seen.has(
                key
            )
        ) {
            continue;
        }


        seen.add(
            key
        );


        result.push(
            clean
        );


        if (
            result.length >=
            max
        ) {
            break;
        }
    }


    return result;
}


/* =====================================================
   ARTICLE WORD COUNT
===================================================== */

function articleBodyText(
    article
) {

    return [

        article?.intro?.text,

        ...(
            article?.sections ||
            []
        ).flatMap(
            section =>
                (
                    section?.paragraphs ||
                    []
                ).map(
                    paragraph =>
                        paragraph?.text
                )
        ),

        ...(
            article?.faq ||
            []
        ).map(
            item =>
                item?.answer
        ),

        article?.conclusion?.text

    ]
        .filter(Boolean)
        .join('\n');
}


function wordCount(
    value
) {

    const text =
        cleanText(
            value
        );


    if (!text) {
        return 0;
    }


    return text
        .split(
            /\s+/
        )
        .filter(Boolean)
        .length;
}


function readingMinutes(
    words
) {

    return Math.max(
        1,
        Math.ceil(
            Number(
                words || 0
            ) / 220
        )
    );
}


/* =====================================================
   ARTICLE ID
===================================================== */

function nextArticleId(
    articles
) {

    let maximum = 0;


    for (
        const article of
        Array.isArray(
            articles
        )
            ? articles
            : []
    ) {

        const match =
            String(
                article?.id ||
                ''
            )
                .match(
                    /^apxn-(\d+)$/i
                );


        if (!match) {
            continue;
        }


        maximum =
            Math.max(
                maximum,
                Number(
                    match[1]
                )
            );
    }


    return (
        `apxn-${
            String(
                maximum + 1
            )
                .padStart(
                    3,
                    '0'
                )
        }`
    );
}


/* =====================================================
   DRAFT SNAPSHOT
===================================================== */

function draftSnapshot() {

    const result =
        new Map();


    if (
        !fs.existsSync(
            PATHS.drafts
        )
    ) {

        return result;
    }


    const files =
        fs.readdirSync(
            PATHS.drafts
        );


    for (
        const filename of files
    ) {

        if (
            !filename.endsWith(
                '.raw-generation.json'
            )
        ) {
            continue;
        }


        const fullPath =
            path.join(
                PATHS.drafts,
                filename
            );


        try {

            const stat =
                fs.statSync(
                    fullPath
                );


            result.set(
                filename,
                {
                    mtime:
                        stat.mtimeMs,

                    size:
                        stat.size
                }
            );

        } catch {
            // Ignore unreadable old artifact.
        }
    }


    return result;
}


/* =====================================================
   FIND NEW GENERATED ARTICLE
===================================================== */

function findGeneratedDraft(
    before
) {

    if (
        !fs.existsSync(
            PATHS.drafts
        )
    ) {

        fail(
            'The writer did not create the drafts directory.'
        );
    }


    const changed = [];


    for (
        const filename of
        fs.readdirSync(
            PATHS.drafts
        )
    ) {

        if (
            !filename.endsWith(
                '.raw-generation.json'
            )
        ) {
            continue;
        }


        const fullPath =
            path.join(
                PATHS.drafts,
                filename
            );


        let stat;


        try {

            stat =
                fs.statSync(
                    fullPath
                );

        } catch {

            continue;
        }


        const previous =
            before.get(
                filename
            );


        const changedFile =
            !previous ||
            previous.mtime !==
                stat.mtimeMs ||
            previous.size !==
                stat.size;


        if (
            changedFile
        ) {

            changed.push({
                filename,
                fullPath,
                mtime:
                    stat.mtimeMs
            });
        }
    }


    changed.sort(
        (a, b) =>
            b.mtime -
            a.mtime
    );


    const newest =
        changed[0];


    if (!newest) {

        fail(
            'The blog writer finished but no new generated article was found.'
        );
    }


    return readJson(
        newest.fullPath
    );
}


/* =====================================================
   DUPLICATE CHECK
===================================================== */

function assertNotAlreadyReady(
    article,
    manifest
) {

    const generatedTitle =
        normalizeTopic(
            article.title
        );


    const generatedSlug =
        slugify(
            article.title
        );


    for (
        const existing of
        Array.isArray(
            manifest.articles
        )
            ? manifest.articles
            : []
    ) {

        if (
            normalizeTopic(
                existing?.title
            ) ===
            generatedTitle
        ) {

            fail(
                `Article already exists: ${article.title}`
            );
        }


        if (
            slugify(
                existing?.slug ||
                existing?.title
            ) ===
            generatedSlug
        ) {

            fail(
                `Article slug already exists: ${generatedSlug}`
            );
        }
    }
}


/* =====================================================
   BUILD READY ARTICLE RECORD
===================================================== */

function createReadyRecord({
    article,
    raw,
    articleId
}) {

    const slug =
        slugify(
            article.title
        );


    if (!slug) {

        fail(
            'Generated article title could not create a valid slug.'
        );
    }


    const bodyWords =
        wordCount(
            articleBodyText(
                article
            )
        );


    const date =
        cleanText(
            raw.generated_at
        ) ||
        new Date()
            .toISOString()
            .slice(
                0,
                10
            );


    const canonical =
        `https://apxn.network/blog/articles/${slug}.html`;


    const record = {

        id:
            articleId,

        slug,

        title:
            cleanText(
                article.title
            ),

        description:
            cleanText(
                article.description
            ),

        excerpt:
            cleanText(
                article.description
            ),

        category:
            cleanText(
                raw.category
            ) ||
            'Education',

        language:
            'en',

        author:
            'Apex Network Editorial',

        status:
            'ready',

        featured:
            false,

        indexable:
            false,

        created_at:
            date,

        generated_at:
            date,

        updated_at:
            date,

        published_at:
            null,

        reading_minutes:
            readingMinutes(
                bodyWords
            ),

        word_count:
            bodyWords,

        path:
            '',

        url:
            '',

        image:
            '',

        image_filename:
            '',

        keywords:
            uniqueStrings(
                article.keywords,
                10
            ),

        source:
            'automated_research_packet_pipeline',

        content_mode:
            cleanText(
                raw.content_mode
            ),

        source_profile:
            cleanText(
                raw.source_profile
            ) ||
            null,

        seo_ready:
            true,

        facts_verified:
            true,

        duplicate_check:
            true,

        quality_check:
            true,

        seo: {

            title:
                cleanText(
                    article.title
                ),

            description:
                cleanText(
                    article.description
                ),

            canonical,

            robots:
                'noindex, nofollow',

            article_schema:
                true,

            faq_schema:
                true
        },

        /*
         * Complete generated article.
         *
         * It stays here until the administrator
         * chooses an image and presses Publish.
         */
        content:
            article
    };


    if (
        [
            'apxn',
            'hybrid'
        ].includes(
            record.content_mode
        )
    ) {

        record.verified_against_knowledge =
            true;
    }


    return record;
}


/* =====================================================
   UPDATE QUEUE
===================================================== */

function markQueueReady(
    manifest,
    raw,
    readyArticle
) {

    const topic =
        normalizeTopic(
            raw.topic
        );


    const queue =
        Array.isArray(
            manifest.generation_queue
        )
            ? manifest.generation_queue
            : [];


    const item =
        queue.find(
            candidate =>
                candidate?.status ===
                    'waiting' &&
                normalizeTopic(
                    candidate?.topic
                ) ===
                    topic
        );


    if (!item) {

        return;
    }


    item.status =
        'ready';

    item.article_id =
        readyArticle.id;

    item.generated_at =
        readyArticle.generated_at;

    item.content_mode =
        readyArticle.content_mode;

    item.source_profile =
        readyArticle.source_profile;
}


/* =====================================================
   UPDATE TOPIC BANK
===================================================== */

function markTopicBankReady(
    bank,
    raw,
    readyArticle
) {

    if (
        !bank ||
        !Array.isArray(
            bank.topics
        )
    ) {

        return;
    }


    const topic =
        normalizeTopic(
            raw.topic
        );


    const item =
        bank.topics.find(
            candidate =>
                normalizeTopic(
                    candidate?.topic
                ) ===
                topic
        );


    if (!item) {
        return;
    }


    item.status =
        'ready';

    item.article_id =
        readyArticle.id;

    item.article_slug =
        readyArticle.slug;

    item.generated_at =
        readyArticle.generated_at;
}


/* =====================================================
   MANIFEST STATS
===================================================== */

function refreshStats(
    manifest
) {

    const articles =
        Array.isArray(
            manifest.articles
        )
            ? manifest.articles
            : [];


    manifest.stats = {

        total_articles:
            articles.length,

        published:
            articles.filter(
                article =>
                    article.status ===
                    'published'
            ).length,

        ready:
            articles.filter(
                article =>
                    article.status ===
                    'ready'
            ).length,

        drafts:
            articles.filter(
                article =>
                    article.status ===
                    'draft'
            ).length,

        featured:
            articles.filter(
                article =>
                    article.featured ===
                    true
            ).length
    };


    manifest.automation_state =
        manifest.automation_state ||
        {};


    const nextWaiting =
        (
            manifest.generation_queue ||
            []
        )
            .filter(
                item =>
                    item?.status ===
                    'waiting'
            )
            .sort(
                (a, b) =>
                    Number(
                        a?.priority ||
                        999999
                    ) -
                    Number(
                        b?.priority ||
                        999999
                    )
            )[0];


    manifest
        .automation_state
        .next_queue_priority =
            nextWaiting?.priority ??
            null;
}


/* =====================================================
   RUN EXISTING WRITER
===================================================== */

function runExistingWriter() {

    const before =
        draftSnapshot();


    /*
     * Very important:
     *
     * BLOG_PUBLISH is always removed.
     * The existing writer may generate and validate,
     * but it is not allowed to publish.
     */
    const environment = {
        ...process.env
    };


    delete environment
        .BLOG_PUBLISH;


    console.log(
        'APXN READY WRITER'
    );

    console.log(
        'Automatic publishing: DISABLED'
    );

    console.log(
        'Running existing research + quality writer...'
    );


    const result =
        spawnSync(
            process.execPath,
            [
                PATHS.writer
            ],
            {
                cwd:
                    ROOT,

                env:
                    environment,

                stdio:
                    'inherit'
            }
        );


    if (
        result.error
    ) {

        fail(
            `Unable to start blog writer: ${result.error.message}`
        );
    }


    if (
        result.status !== 0
    ) {

        fail(
            `blog-writer.mjs failed with exit code ${result.status}.`
        );
    }


    return findGeneratedDraft(
        before
    );
}


/* =====================================================
   MAIN
===================================================== */

function main() {

    const manifest =
        readJson(
            PATHS.articles
        );


    const bank =
        readJson(
            PATHS.topicBank
        );


    if (
        !Array.isArray(
            manifest.articles
        )
    ) {

        manifest.articles = [];
    }


    const raw =
        runExistingWriter();


    const article =
        raw?.parsed;


    if (
        !article ||
        typeof article !==
            'object'
    ) {

        fail(
            'The writer output does not contain a valid parsed article.'
        );
    }


    if (
        !cleanText(
            article.title
        )
    ) {

        fail(
            'Generated article has no title.'
        );
    }


    if (
        !cleanText(
            article.description
        )
    ) {

        fail(
            'Generated article has no SEO description.'
        );
    }


    assertNotAlreadyReady(
        article,
        manifest
    );


    const articleId =
        nextArticleId(
            manifest.articles
        );


    const readyArticle =
        createReadyRecord({
            article,
            raw,
            articleId
        });


    manifest.articles.push(
        readyArticle
    );


    markQueueReady(
        manifest,
        raw,
        readyArticle
    );


    markTopicBankReady(
        bank,
        raw,
        readyArticle
    );


    const date =
        readyArticle.generated_at;


    manifest.last_updated =
        date;


    bank.last_updated =
        date;


    manifest.automation_state =
        manifest.automation_state ||
        {};


    manifest
        .automation_state
        .last_generated_article =
            articleId;


    /*
     * Generation is automatic.
     * Publishing is ALWAYS manual.
     */
    manifest
        .automation_state
        .automatic_generation =
            true;


    manifest
        .automation_state
        .automatic_publishing =
            false;


    refreshStats(
        manifest
    );


    writeJsonAtomic(
        PATHS.articles,
        manifest
    );


    writeJsonAtomic(
        PATHS.topicBank,
        bank
    );


    console.log('');
    console.log(
        'READY ARTICLE CREATED'
    );

    console.log(
        `Article ID: ${readyArticle.id}`
    );

    console.log(
        `Title: ${readyArticle.title}`
    );

    console.log(
        `Category: ${readyArticle.category}`
    );

    console.log(
        `Words: ${readyArticle.word_count}`
    );

    console.log(
        'Status: ready'
    );

    console.log(
        'Published: NO'
    );

    console.log(
        'Image required: YES'
    );

    console.log('');
    console.log(
        'The article is now ready for /blog-admin/.'
    );
}


/* =====================================================
   START
===================================================== */

try {

    main();

} catch (error) {

    console.error(
        `\nERROR: ${
            error instanceof Error
                ? error.message
                : error
        }`
    );


    process.exitCode = 1;
}
