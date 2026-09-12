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


/* =====================================================
   SECURITY HEADERS
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
}


/* =====================================================
   BASIC HELPERS
===================================================== */

function text(
    value,
    fallback = ''
) {

    if (
        typeof value !== 'string'
    ) {
        return fallback;
    }

    const cleaned =
        value.trim();

    return (
        cleaned ||
        fallback
    );
}


function number(
    value,
    fallback = 0
) {

    const result =
        Number(value);

    return Number.isFinite(
        result
    )
        ? result
        : fallback;
}


/* =====================================================
   ARTICLE STATUS
===================================================== */

function normalizeStatus(
    value
) {

    const status =
        text(value)
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
   IMAGE FILENAME
===================================================== */

function imageFilename(
    article
) {

    if (
        article.image_filename
    ) {

        return text(
            article.image_filename
        );
    }


    const image =
        text(
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
   NORMALIZE ARTICLE
===================================================== */

function normalizeArticle(
    article
) {

    if (
        !article ||
        typeof article !== 'object'
    ) {
        return null;
    }


    const title =
        text(
            article.title
        );


    const slug =
        text(
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
        article.seo &&
        typeof article.seo ===
            'object'
            ? article.seo
            : {};


    const description =
        text(
            article.excerpt ||
            article.description ||
            article.meta_description ||
            seo.description
        );


    const url =
        text(
            article.url ||
            article.published_url
        );


    return {

        id:
            text(
                article.id,
                slug
            ),

        slug,

        title,

        category:
            text(
                article.category,
                'APXN Guides'
            ),

        language:
            text(
                article.language,
                'en'
            ),

        author:
            text(
                article.author,
                'Apex Network Editorial'
            ),

        status,

        excerpt:
            description,

        description,

        meta_title:
            text(
                article.meta_title ||
                article.seo_title ||
                seo.title ||
                title
            ),

        meta_description:
            text(
                article.meta_description ||
                seo.description ||
                description
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

        canonical:
            text(
                article.canonical ||
                seo.canonical ||
                url
            ),

        word_count:
            number(
                article.word_count ||
                article.wordCount
            ),

        reading_minutes:
            number(
                article.reading_minutes
            ),

        created_at:
            text(
                article.created_at
            ),

        generated_at:
            text(
                article.generated_at
            ),

        updated_at:
            text(
                article.updated_at
            ),

        published_at:
            text(
                article.published_at
            ),

        path:
            text(
                article.path
            ),

        published_url:
            status === 'published'
                ? url
                : '',

        preview_url:
            text(
                article.preview_url
            ),

        image:
            text(
                article.image
            ),

        image_filename:
            imageFilename(
                article
            ),

        seo_ready:
            article.seo_ready !==
                false,

        facts_verified:
            article.facts_verified !==
                false &&
            article.verified_against_knowledge !==
                false,

        duplicate_check:
            article.duplicate_check !==
                false,

        featured:
            article.featured ===
                true,

        indexable:
            article.indexable !==
                false,

        article_schema:
            seo.article_schema ===
                true,

        faq_schema:
            seo.faq_schema ===
                true,

        source:
            text(
                article.source,
                'blog-writer'
            )
    };
}


/* =====================================================
   SORTING
===================================================== */

function timestamp(
    article
) {

    const values = [

        article.published_at,

        article.updated_at,

        article.generated_at,

        article.created_at

    ];


    for (
        const value of values
    ) {

        if (!value) {
            continue;
        }


        const time =
            Date.parse(
                value
            );


        if (
            Number.isFinite(
                time
            )
        ) {
            return time;
        }
    }


    return 0;
}


function sortArticles(
    articles
) {

    const priority = {

        ready: 3,

        draft: 2,

        published: 1
    };


    return [...articles]
        .sort(
            (a, b) => {

                const difference =
                    (
                        priority[
                            b.status
                        ] || 0
                    ) -
                    (
                        priority[
                            a.status
                        ] || 0
                    );


                if (
                    difference !== 0
                ) {
                    return difference;
                }


                return (
                    timestamp(b) -
                    timestamp(a)
                );
            }
        );
}


/* =====================================================
   STATISTICS
===================================================== */

function createStats(
    articles
) {

    const stats = {

        total: 0,

        ready: 0,

        drafts: 0,

        published: 0
    };


    for (
        const article of articles
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
   READ MANIFEST
===================================================== */

async function loadArticles() {

    const raw =
        await fs.readFile(
            ARTICLES_FILE,
            'utf8'
        );


    const manifest =
        JSON.parse(
            raw
        );


    const source =
        Array.isArray(
            manifest?.articles
        )
            ? manifest.articles
            : [];


    const articles =
        source
            .map(
                normalizeArticle
            )
            .filter(Boolean);


    return sortArticles(
        articles
    );
}


/* =====================================================
   API
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
       ADMIN LOGIN REQUIRED
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
       ARTICLES
    ---------------------------------------------- */

    try {

        const articles =
            await loadArticles();


        return res
            .status(200)
            .json({

                success: true,

                authenticated: true,

                stats:
                    createStats(
                        articles
                    ),

                articles
            });

    } catch (error) {

        console.error(
            'Blog admin articles:',
            error instanceof Error
                ? error.message
                : error
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
