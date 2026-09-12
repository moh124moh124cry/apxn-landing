import fs from 'node:fs/promises';
import path from 'node:path';

import {
    isBlogAdminAuthenticated
} from './blog-admin-auth.js';


const ARTICLES_FILE =
    path.join(
        process.cwd(),
        'data',
        'blog-articles.json'
    );

const DRAFTS_FILE =
    path.join(
        process.cwd(),
        'data',
        'blog-drafts.json'
    );


/* =====================================================
   RESPONSE SECURITY
===================================================== */

function noStore(res) {

    res.setHeader(
        'Cache-Control',
        'no-store, max-age=0, must-revalidate'
    );

    res.setHeader(
        'Pragma',
        'no-cache'
    );

    res.setHeader(
        'Expires',
        '0'
    );

    res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
    );

    res.setHeader(
        'Referrer-Policy',
        'no-referrer'
    );

    res.setHeader(
        'X-Frame-Options',
        'DENY'
    );
}


/* =====================================================
   HELPERS
===================================================== */

function cleanString(
    value,
    fallback = ''
) {

    if (
        typeof value !== 'string'
    ) {
        return fallback;
    }

    return value.trim();
}


function safeNumber(
    value,
    fallback = 0
) {

    const number =
        Number(value);

    if (
        !Number.isFinite(number)
    ) {
        return fallback;
    }

    return number;
}


function normalizeStatus(
    value
) {

    const status =
        cleanString(value)
            .toLowerCase();


    if (
        status === 'published'
    ) {
        return 'published';
    }


    if (
        status === 'ready' ||
        status === 'ready_to_publish' ||
        status === 'ready-to-publish'
    ) {
        return 'ready';
    }


    return 'draft';
}


/* =====================================================
   JSON READER
===================================================== */

async function readJsonFile(
    filePath,
    {
        optional = false
    } = {}
) {

    try {

        const raw =
            await fs.readFile(
                filePath,
                'utf8'
            );


        return JSON.parse(
            raw
        );

    } catch (error) {

        if (
            optional &&
            error?.code === 'ENOENT'
        ) {
            return null;
        }


        if (
            error instanceof SyntaxError
        ) {

            throw new Error(
                `INVALID_JSON:${path.basename(
                    filePath
                )}`
            );
        }


        throw error;
    }
}


/* =====================================================
   SEO NORMALIZATION
===================================================== */

function normalizeSeo(
    article
) {

    const seo =
        article?.seo &&
        typeof article.seo === 'object'
            ? article.seo
            : {};


    return {

        title:
            cleanString(
                seo.title ||
                article.meta_title ||
                article.seo_title ||
                article.title
            ),

        description:
            cleanString(
                seo.description ||
                article.meta_description ||
                article.description
            ),

        canonical:
            cleanString(
                seo.canonical ||
                article.canonical ||
                article.url
            ),

        robots:
            cleanString(
                seo.robots,
                'index, follow'
            ),

        keywords:
            Array.isArray(
                article.keywords
            )
                ? article.keywords
                    .filter(
                        item =>
                            typeof item ===
                            'string'
                    )
                    .map(
                        item =>
                            item.trim()
                    )
                    .filter(Boolean)
                : [],

        article_schema:
            seo.article_schema ===
                true,

        faq_schema:
            seo.faq_schema ===
                true
    };
}


/* =====================================================
   QUALITY NORMALIZATION
===================================================== */

function normalizeQuality(
    article
) {

    const quality =
        article?.quality &&
        typeof article.quality === 'object'
            ? article.quality
            : {};


    return {

        seo_ready:
            article.seo_ready !== false &&
            quality.seo_ready !== false,

        facts_verified:
            article.facts_verified !== false &&
            article.verified_against_knowledge !== false &&
            quality.facts_verified !== false,

        duplicate_check:
            article.duplicate_check !== false &&
            quality.duplicate_check !== false
    };
}


/* =====================================================
   IMAGE NORMALIZATION
===================================================== */

function getImageFilename(
    article
) {

    const explicit =
        cleanString(
            article.image_filename
        );

    if (explicit) {
        return explicit;
    }


    const image =
        cleanString(
            article.image
        );

    if (!image) {
        return '';
    }


    try {

        const url =
            new URL(image);

        return decodeURIComponent(
            path.basename(
                url.pathname
            )
        );

    } catch {

        return path.basename(
            image
        );
    }
}


/* =====================================================
   ARTICLE NORMALIZATION
===================================================== */

function normalizeArticle(
    article,
    source
) {

    if (
        !article ||
        typeof article !== 'object'
    ) {
        return null;
    }


    const title =
        cleanString(
            article.title
        );


    const slug =
        cleanString(
            article.slug
        );


    if (
        !title ||
        !slug
    ) {
        return null;
    }


    const status =
        normalizeStatus(
            article.status
        );


    const seo =
        normalizeSeo(
            article
        );


    const quality =
        normalizeQuality(
            article
        );


    const url =
        cleanString(
            article.url ||
            article.published_url
        );


    const previewUrl =
        cleanString(
            article.preview_url
        );


    const description =
        cleanString(
            article.excerpt ||
            article.description ||
            article.meta_description ||
            seo.description
        );


    return {

        id:
            cleanString(
                article.id,
                slug
            ),

        slug,

        title,

        category:
            cleanString(
                article.category,
                'APXN Guides'
            ),

        language:
            cleanString(
                article.language,
                'en'
            ),

        author:
            cleanString(
                article.author,
                'Apex Network Editorial'
            ),

        status,

        excerpt:
            description,

        description,

        meta_title:
            seo.title,

        meta_description:
            seo.description,

        canonical:
            seo.canonical,

        keywords:
            seo.keywords,

        word_count:
            safeNumber(
                article.word_count ||
                article.wordCount
            ),

        reading_minutes:
            safeNumber(
                article.reading_minutes
            ),

        created_at:
            cleanString(
                article.created_at
            ),

        generated_at:
            cleanString(
                article.generated_at
            ),

        published_at:
            cleanString(
                article.published_at
            ),

        updated_at:
            cleanString(
                article.updated_at
            ),

        path:
            cleanString(
                article.path
            ),

        published_url:
            status === 'published'
                ? url
                : '',

        preview_url:
            previewUrl,

        image:
            cleanString(
                article.image
            ),

        image_filename:
            getImageFilename(
                article
            ),

        seo_ready:
            quality.seo_ready,

        facts_verified:
            quality.facts_verified,

        duplicate_check:
            quality.duplicate_check,

        article_schema:
            seo.article_schema,

        faq_schema:
            seo.faq_schema,

        source:
            cleanString(
                article.source,
                source
            ),

        featured:
            article.featured ===
                true,

        indexable:
            article.indexable !==
                false
    };
}


/* =====================================================
   LOAD PUBLISHED ARTICLES
===================================================== */

async function loadPublishedArticles() {

    const manifest =
        await readJsonFile(
            ARTICLES_FILE
        );


    const articles =
        Array.isArray(
            manifest?.articles
        )
            ? manifest.articles
            : [];


    return articles
        .map(
            article =>
                normalizeArticle(
                    article,
                    'blog-articles'
                )
        )
        .filter(Boolean);
}


/* =====================================================
   LOAD DRAFT ARTICLES
===================================================== */

async function loadDraftArticles() {

    /*
     * blog-drafts.json does not need to exist yet.
     *
     * The future AI writer will save generated
     * articles here.
     */

    const manifest =
        await readJsonFile(
            DRAFTS_FILE,
            {
                optional: true
            }
        );


    if (!manifest) {
        return [];
    }


    const drafts =
        Array.isArray(
            manifest.articles
        )
            ? manifest.articles

            : Array.isArray(
                manifest.drafts
            )
                ? manifest.drafts

                : [];


    return drafts
        .map(
            article =>
                normalizeArticle(
                    article,
                    'blog-drafts'
                )
        )
        .filter(Boolean);
}


/* =====================================================
   REMOVE DUPLICATES
===================================================== */

function mergeArticles(
    published,
    drafts
) {

    const map =
        new Map();


    /*
     * Drafts first.
     */
    for (
        const article of
        drafts
    ) {

        const key =
            article.slug
                .toLowerCase();


        map.set(
            key,
            article
        );
    }


    /*
     * Published article always wins
     * if the same slug exists in both files.
     */
    for (
        const article of
        published
    ) {

        const key =
            article.slug
                .toLowerCase();


        map.set(
            key,
            article
        );
    }


    return Array.from(
        map.values()
    );
}


/* =====================================================
   SORTING
===================================================== */

function articleTimestamp(
    article
) {

    const candidates = [

        article.published_at,

        article.updated_at,

        article.generated_at,

        article.created_at

    ];


    for (
        const value of
        candidates
    ) {

        if (!value) {
            continue;
        }


        const timestamp =
            Date.parse(
                value
            );


        if (
            Number.isFinite(
                timestamp
            )
        ) {
            return timestamp;
        }
    }


    return 0;
}


function sortArticles(
    articles
) {

    return [...articles]
        .sort(
            (a, b) => {

                const statusPriority = {
                    ready: 3,
                    draft: 2,
                    published: 1
                };


                const firstPriority =
                    statusPriority[
                        a.status
                    ] || 0;


                const secondPriority =
                    statusPriority[
                        b.status
                    ] || 0;


                if (
                    firstPriority !==
                    secondPriority
                ) {

                    return (
                        secondPriority -
                        firstPriority
                    );
                }


                return (
                    articleTimestamp(b) -
                    articleTimestamp(a)
                );
            }
        );
}


/* =====================================================
   COUNTERS
===================================================== */

function buildStats(
    articles
) {

    const stats = {
        total: 0,
        ready: 0,
        drafts: 0,
        published: 0
    };


    for (
        const article of
        articles
    ) {

        stats.total++;


        if (
            article.status ===
            'ready'
        ) {

            stats.ready++;
        }


        if (
            article.status ===
            'draft'
        ) {

            stats.drafts++;
        }


        if (
            article.status ===
            'published'
        ) {

            stats.published++;
        }
    }


    return stats;
}


/* =====================================================
   API HANDLER
===================================================== */

export default async function handler(
    req,
    res
) {

    noStore(
        res
    );


    /* ---------------------------------------------
       GET ONLY
    ---------------------------------------------- */

    if (
        req.method !== 'GET'
    ) {

        res.setHeader(
            'Allow',
            'GET'
        );


        return res
            .status(405)
            .json({

                success: false,

                error:
                    'METHOD_NOT_ALLOWED'
            });
    }


    /* ---------------------------------------------
       ADMIN AUTHENTICATION
    ---------------------------------------------- */

    if (
        !isBlogAdminAuthenticated(
            req
        )
    ) {

        return res
            .status(401)
            .json({

                success: false,

                authenticated: false,

                error:
                    'UNAUTHORIZED'
            });
    }


    /* ---------------------------------------------
       LOAD ARTICLES
    ---------------------------------------------- */

    try {

        const [
            published,
            drafts
        ] =
            await Promise.all([

                loadPublishedArticles(),

                loadDraftArticles()

            ]);


        const articles =
            sortArticles(
                mergeArticles(
                    published,
                    drafts
                )
            );


        const stats =
            buildStats(
                articles
            );


        return res
            .status(200)
            .json({

                success: true,

                authenticated: true,

                stats,

                articles
            });

    } catch (error) {

        console.error(
            'Blog admin articles error:',
            error instanceof Error
                ? error.message
                : 'UNKNOWN_ERROR'
        );


        return res
            .status(500)
            .json({

                success: false,

                authenticated: true,

                error:
                    'ARTICLES_LOAD_FAILED'
            });
    }
}
