import {
    randomBytes
} from 'node:crypto';

import {
    isBlogAdminAuthenticated
} from './blog-admin-auth.js';


const REPOSITORY =
    process.env.BLOG_GITHUB_REPO ||
    'moh124moh124cry/apxn-landing';

const BRANCH =
    process.env.BLOG_GITHUB_BRANCH ||
    'main';

const GITHUB_API =
    'https://api.github.com';

const BASE_URL =
    'https://apxn.network';

const MAX_IMAGE_BYTES =
    3 * 1024 * 1024;


/* =====================================================
   SECURITY
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


function sameOriginRequest(req) {

    const origin =
        req.headers.origin;

    if (!origin) {
        return true;
    }


    try {

        const url =
            new URL(origin);

        const host =
            String(
                req.headers.host ||
                ''
            )
                .toLowerCase();


        return (
            url.host.toLowerCase() ===
            host
        );

    } catch {

        return false;
    }
}


/* =====================================================
   HELPERS
===================================================== */

function cleanText(
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


function escapeHtml(
    value
) {

    return String(
        value ?? ''
    )
        .replaceAll(
            '&',
            '&amp;'
        )
        .replaceAll(
            '<',
            '&lt;'
        )
        .replaceAll(
            '>',
            '&gt;'
        )
        .replaceAll(
            '"',
            '&quot;'
        )
        .replaceAll(
            "'",
            '&#039;'
        );
}


function safeJson(
    value
) {

    return JSON.stringify(
        value,
        null,
        2
    )
        .replaceAll(
            '<',
            '\\u003c'
        )
        .replaceAll(
            '>',
            '\\u003e'
        )
        .replaceAll(
            '&',
            '\\u0026'
        );
}


function today() {

    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone:
                'Africa/Algiers',

            year:
                'numeric',

            month:
                '2-digit',

            day:
                '2-digit'
        }
    )
        .format(
            new Date()
        );
}


function displayDate(
    value
) {

    try {

        return new Intl.DateTimeFormat(
            'en-US',
            {
                year:
                    'numeric',

                month:
                    'long',

                day:
                    'numeric',

                timeZone:
                    'UTC'
            }
        )
            .format(
                new Date(
                    `${value}T00:00:00Z`
                )
            );

    } catch {

        return value;
    }
}


/* =====================================================
   GITHUB
===================================================== */

function getGithubToken() {

    const token =
        process.env.BLOG_GITHUB_TOKEN;


    if (
        typeof token !== 'string' ||
        token.trim().length < 20
    ) {
        return null;
    }


    return token.trim();
}


async function githubRequest(
    endpoint,
    {
        method = 'GET',
        body = null
    } = {}
) {

    const token =
        getGithubToken();


    if (!token) {

        throw new Error(
            'BLOG_GITHUB_TOKEN_NOT_CONFIGURED'
        );
    }


    const response =
        await fetch(
            `${GITHUB_API}${endpoint}`,
            {
                method,

                headers: {
                    Authorization:
                        `Bearer ${token}`,

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
                    body
                        ? JSON.stringify(
                            body
                        )
                        : undefined
            }
        );


    const raw =
        await response.text();


    let data = null;


    try {

        data =
            raw
                ? JSON.parse(
                    raw
                )
                : null;

    } catch {

        data = null;
    }


    if (
        !response.ok
    ) {

        const message =
            data?.message ||
            raw ||
            `GitHub HTTP ${response.status}`;


        const error =
            new Error(
                message
            );


        error.status =
            response.status;


        throw error;
    }


    return data;
}


/* =====================================================
   READ GITHUB JSON FILE
===================================================== */

async function readGithubJson(
    filePath
) {

    const encodedPath =
        filePath
            .split('/')
            .map(
                encodeURIComponent
            )
            .join('/');


    const result =
        await githubRequest(
            `/repos/${REPOSITORY}/contents/${encodedPath}?ref=${encodeURIComponent(
                BRANCH
            )}`
        );


    if (
        typeof result?.content !==
        'string'
    ) {

        throw new Error(
            `INVALID_GITHUB_FILE:${filePath}`
        );
    }


    const raw =
        Buffer
            .from(
                result.content
                    .replace(
                        /\n/g,
                        ''
                    ),
                'base64'
            )
            .toString(
                'utf8'
            );


    return JSON.parse(
        raw
    );
}


/* =====================================================
   IMAGE
===================================================== */

const IMAGE_TYPES = {

    'image/jpeg': {
        extension:
            'jpg'
    },

    'image/png': {
        extension:
            'png'
    },

    'image/webp': {
        extension:
            'webp'
    },

    'image/gif': {
        extension:
            'gif'
    }
};


function validateImageSignature(
    buffer,
    mime
) {

    if (
        mime === 'image/jpeg'
    ) {

        return (
            buffer.length >= 3 &&
            buffer[0] === 0xff &&
            buffer[1] === 0xd8 &&
            buffer[2] === 0xff
        );
    }


    if (
        mime === 'image/png'
    ) {

        return (
            buffer.length >= 8 &&
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47
        );
    }


    if (
        mime === 'image/webp'
    ) {

        return (
            buffer.length >= 12 &&
            buffer
                .subarray(
                    0,
                    4
                )
                .toString(
                    'ascii'
                ) === 'RIFF' &&
            buffer
                .subarray(
                    8,
                    12
                )
                .toString(
                    'ascii'
                ) === 'WEBP'
        );
    }


    if (
        mime === 'image/gif'
    ) {

        const signature =
            buffer
                .subarray(
                    0,
                    6
                )
                .toString(
                    'ascii'
                );


        return (
            signature ===
                'GIF87a' ||
            signature ===
                'GIF89a'
        );
    }


    return false;
}


function safeImageBaseName(
    originalName
) {

    const withoutExtension =
        String(
            originalName ||
            'image'
        )
            .replace(
                /\.[^.]+$/,
                ''
            );


    const safe =
        withoutExtension
            .normalize(
                'NFKD'
            )
            .replace(
                /[\u0300-\u036f]/g,
                ''
            )
            .toLowerCase()
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
                60
            );


    return (
        safe ||
        'image'
    );
}


function buildImageFilename(
    article,
    originalName,
    mime,
    existingPaths
) {

    const imageType =
        IMAGE_TYPES[mime];


    if (!imageType) {

        throw new Error(
            'UNSUPPORTED_IMAGE_TYPE'
        );
    }


    const baseName =
        safeImageBaseName(
            originalName
        );


    const slug =
        cleanText(
            article.slug,
            'article'
        );


    let filename =
        `${slug}-${baseName}.${imageType.extension}`;


    let target =
        `blog/images/${filename}`;


    if (
        existingPaths.has(
            target
        )
    ) {

        const suffix =
            randomBytes(4)
                .toString(
                    'hex'
                );


        filename =
            `${slug}-${baseName}-${suffix}.${imageType.extension}`;


        target =
            `blog/images/${filename}`;
    }


    return {
        filename,
        target
    };
}


/* =====================================================
   ARTICLE VALIDATION
===================================================== */

function validateArticle(
    article
) {

    if (
        !article ||
        typeof article !==
            'object'
    ) {

        throw new Error(
            'ARTICLE_NOT_FOUND'
        );
    }


    if (
        article.status !==
        'ready'
    ) {

        throw new Error(
            'ARTICLE_NOT_READY'
        );
    }


    if (
        !article.content ||
        typeof article.content !==
            'object'
    ) {

        throw new Error(
            'ARTICLE_CONTENT_MISSING'
        );
    }


    if (
        !cleanText(
            article.title
        ) ||
        !cleanText(
            article.slug
        )
    ) {

        throw new Error(
            'ARTICLE_METADATA_INVALID'
        );
    }


    if (
        !cleanText(
            article.content?.intro?.text
        )
    ) {

        throw new Error(
            'ARTICLE_INTRO_MISSING'
        );
    }


    if (
        !Array.isArray(
            article.content?.sections
        ) ||
        article.content.sections.length ===
            0
    ) {

        throw new Error(
            'ARTICLE_SECTIONS_MISSING'
        );
    }


    if (
        !cleanText(
            article.content
                ?.conclusion
                ?.text
        )
    ) {

        throw new Error(
            'ARTICLE_CONCLUSION_MISSING'
        );
    }
}


/* =====================================================
   HTML
===================================================== */

function renderParagraphs(
    paragraphs
) {

    return (
        Array.isArray(
            paragraphs
        )
            ? paragraphs
            : []
    )
        .map(
            paragraph => {

                const value =
                    typeof paragraph ===
                    'string'
                        ? paragraph
                        : paragraph?.text;


                if (
                    !cleanText(
                        value
                    )
                ) {
                    return '';
                }


                return (
                    `<p>${escapeHtml(
                        value
                    )}</p>`
                );
            }
        )
        .filter(Boolean)
        .join('\n');
}


function renderArticleHtml({
    article,
    manifest,
    imageUrl,
    publishedDate
}) {

    const content =
        article.content;


    const title =
        cleanText(
            article.title
        );


    const description =
        cleanText(
            article.meta_description ||
            article.description ||
            content.description
        );


    const category =
        cleanText(
            article.category,
            'APXN'
        );


    const author =
        cleanText(
            article.author,
            'Apex Network Editorial'
        );


    const canonical =
        `${BASE_URL}/blog/articles/${article.slug}.html`;


    const keywords =
        Array.isArray(
            article.keywords
        )
            ? article.keywords
                .filter(
                    value =>
                        typeof value ===
                        'string'
                )
                .map(
                    value =>
                        value.trim()
                )
                .filter(Boolean)
            : [];


    const sectionsHtml =
        (
            Array.isArray(
                content.sections
            )
                ? content.sections
                : []
        )
            .map(
                section => {

                    const heading =
                        cleanText(
                            section?.heading
                        );


                    const paragraphs =
                        renderParagraphs(
                            section?.paragraphs
                        );


                    if (
                        !heading ||
                        !paragraphs
                    ) {
                        return '';
                    }


                    return `
                        <section>
                            <h2>${escapeHtml(
                                heading
                            )}</h2>

                            ${paragraphs}
                        </section>
                    `;
                }
            )
            .filter(Boolean)
            .join('\n');


    const faqItems =
        Array.isArray(
            content.faq
        )
            ? content.faq
            : [];


    const faqHtml =
        faqItems
            .map(
                item => {

                    const question =
                        cleanText(
                            item?.question
                        );


                    const answer =
                        cleanText(
                            item?.answer
                        );


                    if (
                        !question ||
                        !answer
                    ) {
                        return '';
                    }


                    return `
                        <div class="info-box">
                            <h3>${escapeHtml(
                                question
                            )}</h3>

                            <p>${escapeHtml(
                                answer
                            )}</p>
                        </div>
                    `;
                }
            )
            .filter(Boolean)
            .join('\n');


    const publishedArticles =
        (
            Array.isArray(
                manifest.articles
            )
                ? manifest.articles
                : []
        )
            .filter(
                item =>
                    item?.status ===
                        'published' &&
                    item?.slug !==
                        article.slug
            )
            .slice(
                -3
            )
            .reverse();


    const relatedHtml =
        publishedArticles.length
            ? `
                <section>

                    <h2>
                        Related reading
                    </h2>

                    <ul>
                        ${
                            publishedArticles
                                .map(
                                    item => `
                                        <li>
                                            <a href="./${escapeHtml(
                                                item.slug
                                            )}.html">
                                                ${escapeHtml(
                                                    item.title
                                                )}
                                            </a>
                                        </li>
                                    `
                                )
                                .join('')
                        }
                    </ul>

                </section>
            `
            : '';


    const disclaimer =
        [
            'apxn',
            'hybrid'
        ].includes(
            article.content_mode
        )
            ? 'APXN Points are participation points used inside the current Apex Network ecosystem. Future token distribution, conversion, listing, withdrawal and blockchain milestones remain subject to official project updates.'
            : 'This article is educational project content and should not be treated as financial, investment, legal or tax advice.';


    const articleSchema = {

        '@context':
            'https://schema.org',

        '@type':
            'Article',

        headline:
            title,

        description,

        image:
            imageUrl,

        mainEntityOfPage:
            canonical,

        datePublished:
            publishedDate,

        dateModified:
            publishedDate,

        author: {

            '@type':
                'Organization',

            name:
                author
        },

        publisher: {

            '@type':
                'Organization',

            name:
                'Apex Network',

            url:
                BASE_URL,

            logo: {

                '@type':
                    'ImageObject',

                url:
                    `${BASE_URL}/logo2%20(1).png`
            }
        }
    };


    const faqSchema =
        faqItems.length
            ? {

                '@context':
                    'https://schema.org',

                '@type':
                    'FAQPage',

                mainEntity:
                    faqItems
                        .filter(
                            item =>
                                cleanText(
                                    item?.question
                                ) &&
                                cleanText(
                                    item?.answer
                                )
                        )
                        .map(
                            item => ({

                                '@type':
                                    'Question',

                                name:
                                    item.question,

                                acceptedAnswer: {

                                    '@type':
                                        'Answer',

                                    text:
                                        item.answer
                                }
                            })
                        )
            }
            : null;


    return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>${escapeHtml(title)}</title>

    <meta
        name="description"
        content="${escapeHtml(description)}"
    >

    <meta
        name="keywords"
        content="${escapeHtml(
            keywords.join(', ')
        )}"
    >

    <meta
        name="robots"
        content="index, follow"
    >

    <meta
        name="author"
        content="${escapeHtml(author)}"
    >


    <link
        rel="canonical"
        href="${escapeHtml(canonical)}"
    >

    <link
        rel="icon"
        href="../../logo2%20(1).png"
        type="image/png"
    >


    <meta
        property="og:type"
        content="article"
    >

    <meta
        property="og:title"
        content="${escapeHtml(title)}"
    >

    <meta
        property="og:description"
        content="${escapeHtml(description)}"
    >

    <meta
        property="og:url"
        content="${escapeHtml(canonical)}"
    >

    <meta
        property="og:image"
        content="${escapeHtml(imageUrl)}"
    >

    <meta
        property="og:site_name"
        content="Apex Network"
    >


    <meta
        name="twitter:card"
        content="summary_large_image"
    >

    <meta
        name="twitter:title"
        content="${escapeHtml(title)}"
    >

    <meta
        name="twitter:description"
        content="${escapeHtml(description)}"
    >

    <meta
        name="twitter:image"
        content="${escapeHtml(imageUrl)}"
    >


    <script>
        window.va =
            window.va ||
            function () {
                (
                    window.vaq =
                    window.vaq ||
                    []
                ).push(
                    arguments
                );
            };
    </script>

    <script
        defer
        src="/_vercel/insights/script.js"
    ></script>


    <script
        src="https://cdn.tailwindcss.com"
    ></script>


    <style>

        html {
            background: #020617;
        }

        .gold-text {
            background:
                linear-gradient(
                    90deg,
                    #fde047,
                    #f59e0b,
                    #fb923c
                );

            -webkit-background-clip:
                text;

            background-clip:
                text;

            color:
                transparent;
        }

        .article-body p {
            color:
                #cbd5e1;

            line-height:
                1.9;

            margin:
                1rem 0 1.5rem;
        }

        .article-body h2 {
            color:
                #fff;

            font-size:
                1.75rem;

            font-weight:
                900;

            margin-top:
                2.7rem;

            margin-bottom:
                1rem;

            line-height:
                1.25;
        }

        .article-body h3 {
            color:
                #facc15;

            font-size:
                1.2rem;

            font-weight:
                900;

            margin-top:
                1rem;

            margin-bottom:
                .75rem;
        }

        .article-body ul {
            color:
                #cbd5e1;

            margin:
                1rem 0 1.5rem 1.5rem;

            line-height:
                1.9;

            list-style:
                disc;
        }

        .article-body a {
            color:
                #facc15;

            font-weight:
                800;
        }

        .info-box {
            background:
                rgba(
                    15,
                    23,
                    42,
                    .8
                );

            border:
                1px solid
                rgba(
                    234,
                    179,
                    8,
                    .25
                );

            border-radius:
                1rem;

            padding:
                1.25rem;

            margin:
                1.5rem 0;
        }

    </style>


    <script type="application/ld+json">
${safeJson(articleSchema)}
    </script>

    ${
        faqSchema
            ? `
    <script type="application/ld+json">
${safeJson(faqSchema)}
    </script>
            `
            : ''
    }

</head>


<body
    class="bg-slate-950 text-white font-sans overflow-x-hidden selection:bg-yellow-500 selection:text-slate-950"
>


<header
    class="sticky top-0 z-50 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800"
>

    <div
        class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-5"
    >

        <a
            href="../index.html"
            class="flex items-center gap-3 min-w-0"
        >

            <div
                class="w-11 h-11 shrink-0 rounded-full overflow-hidden border border-yellow-500/50"
            >

                <img
                    src="../../logo2%20(1).png"
                    alt="Apex Network Logo"
                    class="w-full h-full object-cover"
                    width="44"
                    height="44"
                >

            </div>


            <div>

                <div
                    class="font-black tracking-wider gold-text text-base sm:text-lg"
                >
                    APEX NETWORK
                </div>

                <div
                    class="text-[10px] sm:text-xs text-gray-500 font-bold uppercase tracking-[0.2em]"
                >
                    APXN Blog
                </div>

            </div>

        </a>


        <div
            class="flex items-center gap-3"
        >

            <a
                href="../index.html"
                class="hidden sm:inline-flex text-sm font-bold text-gray-400 hover:text-yellow-400"
            >
                Blog Home
            </a>

            <a
                href="https://t.me/ApxMinerBot"
                target="_blank"
                rel="noopener noreferrer"
                class="bg-gradient-to-r from-yellow-500 to-orange-500 text-slate-950 font-black text-xs sm:text-sm px-4 sm:px-5 py-3 rounded-xl"
            >
                Open APXN App
            </a>

        </div>

    </div>

</header>


<main>

    <article>


        <section
            class="border-b border-slate-800 bg-gradient-to-b from-yellow-500/[0.06] to-transparent"
        >

            <div
                class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-16 sm:py-20"
            >

                <nav
                    aria-label="Breadcrumb"
                    class="text-xs text-gray-500 font-bold mb-7"
                >

                    <a
                        href="../../index.html"
                        class="hover:text-yellow-400"
                    >
                        Home
                    </a>

                    <span class="mx-2">
                        /
                    </span>

                    <a
                        href="../index.html"
                        class="hover:text-yellow-400"
                    >
                        Blog
                    </a>

                    <span class="mx-2">
                        /
                    </span>

                    <span
                        class="text-yellow-400"
                    >
                        ${escapeHtml(category)}
                    </span>

                </nav>


                <span
                    class="inline-flex border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-widest mb-5"
                >
                    ${escapeHtml(category)}
                </span>


                <h1
                    class="text-4xl sm:text-5xl lg:text-6xl font-black leading-tight mb-6"
                >
                    ${escapeHtml(title)}
                </h1>


                <p
                    class="text-lg sm:text-xl text-gray-400 leading-relaxed mb-7"
                >
                    ${escapeHtml(description)}
                </p>


                <div
                    class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs sm:text-sm text-gray-500"
                >

                    <span
                        class="font-bold text-gray-300"
                    >
                        ${escapeHtml(author)}
                    </span>

                    <span>
                        •
                    </span>

                    <time
                        datetime="${escapeHtml(
                            publishedDate
                        )}"
                    >
                        ${escapeHtml(
                            displayDate(
                                publishedDate
                            )
                        )}
                    </time>

                    <span>
                        •
                    </span>

                    <span>
                        ${Number(
                            article.reading_minutes ||
                            1
                        )} min read
                    </span>

                </div>

            </div>

        </section>


        <div
            class="max-w-4xl mx-auto px-5 sm:px-6 lg:px-8 py-10 sm:py-14"
        >

            <figure
                class="mb-12"
            >

                <img
                    src="${escapeHtml(imageUrl)}"
                    alt="${escapeHtml(title)}"
                    class="w-full rounded-2xl border border-slate-800 object-cover max-h-[620px]"
                    loading="eager"
                >

            </figure>


            <div
                class="article-body"
            >

                <p
                    class="text-lg"
                >
                    ${escapeHtml(
                        content.intro.text
                    )}
                </p>


                ${sectionsHtml}


                ${
                    faqHtml
                        ? `
                <section>

                    <h2>
                        Frequently asked questions
                    </h2>

                    ${faqHtml}

                </section>
                        `
                        : ''
                }


                <section>

                    <h2>
                        Conclusion
                    </h2>

                    <p>
                        ${escapeHtml(
                            content.conclusion.text
                        )}
                    </p>

                </section>


                ${relatedHtml}


                <div
                    class="info-box"
                >

                    <strong>
                        Editorial note:
                    </strong>

                    <p>
                        ${escapeHtml(
                            disclaimer
                        )}
                    </p>

                </div>

            </div>

        </div>

    </article>

</main>


<footer
    class="border-t border-slate-800"
>

    <div
        class="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 py-8 text-sm text-gray-500 flex flex-wrap gap-4 justify-between"
    >

        <span>
            © ${new Date().getUTCFullYear()} Apex Network
        </span>

        <a
            href="../index.html"
            class="hover:text-yellow-400"
        >
            APXN Blog
        </a>

    </div>

</footer>


</body>
</html>
`;
}


/* =====================================================
   MANIFEST
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
                item =>
                    item.status ===
                    'published'
            ).length,

        ready:
            articles.filter(
                item =>
                    item.status ===
                    'ready'
            ).length,

        drafts:
            articles.filter(
                item =>
                    item.status ===
                    'draft'
            ).length,

        featured:
            articles.filter(
                item =>
                    item.featured ===
                    true
            ).length
    };
}


/* =====================================================
   GIT COMMIT
===================================================== */

async function createBlob(
    content,
    encoding
) {

    return githubRequest(
        `/repos/${REPOSITORY}/git/blobs`,
        {
            method:
                'POST',

            body: {
                content,
                encoding
            }
        }
    );
}


async function publishCommit({
    manifest,
    topicBank,
    article,
    imageBuffer,
    imagePath,
    html
}) {

    const ref =
        await githubRequest(
            `/repos/${REPOSITORY}/git/ref/heads/${encodeURIComponent(
                BRANCH
            )}`
        );


    const currentCommitSha =
        ref?.object?.sha;


    if (!currentCommitSha) {

        throw new Error(
            'GITHUB_BRANCH_NOT_FOUND'
        );
    }


    const currentCommit =
        await githubRequest(
            `/repos/${REPOSITORY}/git/commits/${currentCommitSha}`
        );


    const baseTreeSha =
        currentCommit?.tree?.sha;


    if (!baseTreeSha) {

        throw new Error(
            'GITHUB_TREE_NOT_FOUND'
        );
    }


    const tree =
        await githubRequest(
            `/repos/${REPOSITORY}/git/trees/${baseTreeSha}?recursive=1`
        );


    const existingPaths =
        new Set(
            (
                Array.isArray(
                    tree?.tree
                )
                    ? tree.tree
                    : []
            )
                .map(
                    item =>
                        item?.path
                )
                .filter(Boolean)
        );


    if (
        existingPaths.has(
            `blog/articles/${article.slug}.html`
        )
    ) {

        throw new Error(
            'ARTICLE_FILE_ALREADY_EXISTS'
        );
    }


    if (
        existingPaths.has(
            imagePath
        )
    ) {

        throw new Error(
            'IMAGE_FILE_ALREADY_EXISTS'
        );
    }


    const [
        imageBlob,
        htmlBlob,
        manifestBlob,
        topicBankBlob
    ] =
        await Promise.all([

            createBlob(
                imageBuffer.toString(
                    'base64'
                ),
                'base64'
            ),

            createBlob(
                html,
                'utf-8'
            ),

            createBlob(
                `${JSON.stringify(
                    manifest,
                    null,
                    2
                )}\n`,
                'utf-8'
            ),

            createBlob(
                `${JSON.stringify(
                    topicBank,
                    null,
                    2
                )}\n`,
                'utf-8'
            )

        ]);


    const newTree =
        await githubRequest(
            `/repos/${REPOSITORY}/git/trees`,
            {
                method:
                    'POST',

                body: {

                    base_tree:
                        baseTreeSha,

                    tree: [

                        {
                            path:
                                imagePath,

                            mode:
                                '100644',

                            type:
                                'blob',

                            sha:
                                imageBlob.sha
                        },

                        {
                            path:
                                `blog/articles/${article.slug}.html`,

                            mode:
                                '100644',

                            type:
                                'blob',

                            sha:
                                htmlBlob.sha
                        },

                        {
                            path:
                                'data/blog-articles.json',

                            mode:
                                '100644',

                            type:
                                'blob',

                            sha:
                                manifestBlob.sha
                        },

                        {
                            path:
                                'data/blog-topic-bank.json',

                            mode:
                                '100644',

                            type:
                                'blob',

                            sha:
                                topicBankBlob.sha
                        }

                    ]
                }
            }
        );


    const commit =
        await githubRequest(
            `/repos/${REPOSITORY}/git/commits`,
            {
                method:
                    'POST',

                body: {

                    message:
                        `feat(blog): publish ${article.slug}`,

                    tree:
                        newTree.sha,

                    parents: [
                        currentCommitSha
                    ]
                }
            }
        );


    await githubRequest(
        `/repos/${REPOSITORY}/git/refs/heads/${encodeURIComponent(
            BRANCH
        )}`,
        {
            method:
                'PATCH',

            body: {

                sha:
                    commit.sha,

                force:
                    false
            }
        }
    );


    return commit.sha;
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


    if (
        req.method !== 'POST'
    ) {

        res.setHeader(
            'Allow',
            'POST'
        );


        return res
            .status(405)
            .json({

                success: false,

                error:
                    'METHOD_NOT_ALLOWED'
            });
    }


    if (
        !sameOriginRequest(
            req
        )
    ) {

        return res
            .status(403)
            .json({

                success: false,

                error:
                    'INVALID_ORIGIN'
            });
    }


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


    if (
        !getGithubToken()
    ) {

        return res
            .status(503)
            .json({

                success: false,

                error:
                    'BLOG_GITHUB_TOKEN_NOT_CONFIGURED'
            });
    }


    try {

        const articleId =
            cleanText(
                req.body?.article_id
            );


        const imageName =
            cleanText(
                req.body?.image_name
            );


        const imageType =
            cleanText(
                req.body?.image_type
            )
                .toLowerCase();


        const imageBase64 =
            cleanText(
                req.body?.image_base64
            );


        if (
            !articleId ||
            !imageName ||
            !imageType ||
            !imageBase64
        ) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        'MISSING_PUBLISH_DATA'
                });
        }


        if (
            !IMAGE_TYPES[
                imageType
            ]
        ) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        'UNSUPPORTED_IMAGE_TYPE'
                });
        }


        const imageBuffer =
            Buffer.from(
                imageBase64,
                'base64'
            );


        if (
            imageBuffer.length ===
            0
        ) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        'INVALID_IMAGE'
                });
        }


        if (
            imageBuffer.length >
            MAX_IMAGE_BYTES
        ) {

            return res
                .status(413)
                .json({

                    success: false,

                    error:
                        'IMAGE_TOO_LARGE'
                });
        }


        if (
            !validateImageSignature(
                imageBuffer,
                imageType
            )
        ) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        'INVALID_IMAGE'
                });
        }


        const [
            manifest,
            topicBank
        ] =
            await Promise.all([

                readGithubJson(
                    'data/blog-articles.json'
                ),

                readGithubJson(
                    'data/blog-topic-bank.json'
                )

            ]);


        if (
            !Array.isArray(
                manifest?.articles
            )
        ) {

            throw new Error(
                'INVALID_ARTICLE_MANIFEST'
            );
        }


        const article =
            manifest.articles
                .find(
                    item =>
                        String(
                            item?.id ||
                            ''
                        ) ===
                        articleId
                );


        validateArticle(
            article
        );


        const ref =
            await githubRequest(
                `/repos/${REPOSITORY}/git/ref/heads/${encodeURIComponent(
                    BRANCH
                )}`
            );


        const currentCommit =
            await githubRequest(
                `/repos/${REPOSITORY}/git/commits/${ref.object.sha}`
            );


        const currentTree =
            await githubRequest(
                `/repos/${REPOSITORY}/git/trees/${currentCommit.tree.sha}?recursive=1`
            );


        const existingPaths =
            new Set(
                (
                    currentTree.tree ||
                    []
                )
                    .map(
                        item =>
                            item?.path
                    )
                    .filter(Boolean)
            );


        const image =
            buildImageFilename(
                article,
                imageName,
                imageType,
                existingPaths
            );


        const publishedDate =
            today();


        const imageUrl =
            `${BASE_URL}/${image.target}`;


        article.status =
            'published';

        article.indexable =
            true;

        article.published_at =
            publishedDate;

        article.updated_at =
            publishedDate;

        article.path =
            `blog/articles/${article.slug}.html`;

        article.url =
            `${BASE_URL}/blog/articles/${article.slug}.html`;

        article.published_url =
            article.url;

        article.image =
            imageUrl;

        article.image_filename =
            image.filename;

        article.seo_ready =
            true;

        article.facts_verified =
            article.facts_verified !==
            false;

        article.duplicate_check =
            true;


        article.seo = {

            ...(
                article.seo &&
                typeof article.seo ===
                    'object'
                    ? article.seo
                    : {}
            ),

            title:
                article.meta_title ||
                article.title,

            description:
                article.meta_description ||
                article.description,

            canonical:
                article.url,

            robots:
                'index, follow',

            article_schema:
                true,

            faq_schema:
                Array.isArray(
                    article.content?.faq
                ) &&
                article.content.faq.length >
                    0
        };


        for (
            const queueItem of
            Array.isArray(
                manifest.generation_queue
            )
                ? manifest.generation_queue
                : []
        ) {

            if (
                queueItem?.article_id ===
                article.id
            ) {

                queueItem.status =
                    'published';

                queueItem.published_at =
                    publishedDate;
            }
        }


        if (
            Array.isArray(
                topicBank?.topics
            )
        ) {

            for (
                const topic of
                topicBank.topics
            ) {

                if (
                    topic?.article_id ===
                        article.id ||
                    topic?.article_slug ===
                        article.slug
                ) {

                    topic.status =
                        'published';

                    topic.published_at =
                        publishedDate;

                    topic.article_id =
                        article.id;

                    topic.article_slug =
                        article.slug;
                }
            }


            topicBank.last_updated =
                publishedDate;
        }


        manifest.last_updated =
            publishedDate;


        manifest.automation_state =
            manifest.automation_state ||
            {};


        manifest
            .automation_state
            .last_published_article =
                article.id;


        manifest
            .automation_state
            .automatic_publishing =
                false;


        refreshStats(
            manifest
        );


        const html =
            renderArticleHtml({

                article,

                manifest,

                imageUrl,

                publishedDate
            });


        const commitSha =
            await publishCommit({

                manifest,

                topicBank,

                article,

                imageBuffer,

                imagePath:
                    image.target,

                html
            });


        return res
            .status(200)
            .json({

                success: true,

                published: true,

                article_id:
                    article.id,

                slug:
                    article.slug,

                url:
                    article.url,

                image:
                    imageUrl,

                image_filename:
                    image.filename,

                commit:
                    commitSha
            });

    } catch (error) {

        console.error(
            'Blog admin publish error:',
            error instanceof Error
                ? error.message
                : error
        );


        const knownErrors =
            new Set([

                'ARTICLE_NOT_FOUND',

                'ARTICLE_NOT_READY',

                'ARTICLE_CONTENT_MISSING',

                'ARTICLE_METADATA_INVALID',

                'ARTICLE_INTRO_MISSING',

                'ARTICLE_SECTIONS_MISSING',

                'ARTICLE_CONCLUSION_MISSING',

                'UNSUPPORTED_IMAGE_TYPE',

                'ARTICLE_FILE_ALREADY_EXISTS',

                'IMAGE_FILE_ALREADY_EXISTS'
            ]);


        const message =
            error instanceof Error
                ? error.message
                : 'UNKNOWN_ERROR';


        return res
            .status(
                knownErrors.has(
                    message
                )
                    ? 400
                    : 500
            )
            .json({

                success: false,

                error:
                    message
            });
    }
}
