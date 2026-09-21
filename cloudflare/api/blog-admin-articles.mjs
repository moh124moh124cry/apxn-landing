
import {
  isBlogAdminAuthenticated
} from "../../api/blog-admin-auth.js";

function text(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim() || fallback;
}

function number(value, fallback = 0) {
  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : fallback;
}

function normalizeStatus(value) {
  const status = text(value).toLowerCase();

  if (status === "published") {
    return "published";
  }

  if (
    status === "ready" ||
    status === "ready_to_publish" ||
    status === "ready-to-publish"
  ) {
    return "ready";
  }

  return "draft";
}

function imageFilename(article) {
  if (article.image_filename) {
    return text(article.image_filename);
  }

  const image = text(article.image);

  if (!image) {
    return "";
  }

  try {
    return decodeURIComponent(
      new URL(image).pathname.split("/").pop()
    );
  } catch {
    return image.split(/[\\/]/).pop() || "";
  }
}

function normalizeArticle(article) {
  if (
    !article ||
    typeof article !== "object" ||
    Array.isArray(article)
  ) {
    return null;
  }

  const title = text(article.title);
  const slug = text(article.slug);

  if (!title || !slug) {
    return null;
  }

  const status = normalizeStatus(article.status);

  const seo =
    article.seo &&
    typeof article.seo === "object"
      ? article.seo
      : {};

  const description = text(
    article.excerpt ||
    article.description ||
    article.meta_description ||
    seo.description
  );

  const url = text(
    article.url ||
    article.published_url
  );

  return {
    id: text(article.id, slug),
    slug,
    title,

    category: text(
      article.category,
      "APXN Guides"
    ),

    language: text(
      article.language,
      "en"
    ),

    author: text(
      article.author,
      "Apex Network Editorial"
    ),

    status,
    excerpt: description,
    description,

    meta_title: text(
      article.meta_title ||
      article.seo_title ||
      seo.title ||
      title
    ),

    meta_description: text(
      article.meta_description ||
      seo.description ||
      description
    ),

    keywords: Array.isArray(article.keywords)
      ? article.keywords
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
      : [],

    canonical: text(
      article.canonical ||
      seo.canonical ||
      url
    ),

    word_count: number(
      article.word_count ||
      article.wordCount
    ),

    reading_minutes: number(
      article.reading_minutes
    ),

    created_at: text(article.created_at),
    generated_at: text(article.generated_at),
    updated_at: text(article.updated_at),
    published_at: text(article.published_at),
    path: text(article.path),

    published_url:
      status === "published" ? url : "",

    preview_url: text(article.preview_url),
    image: text(article.image),
    image_filename: imageFilename(article),

    seo_ready: article.seo_ready !== false,

    facts_verified:
      article.facts_verified !== false &&
      article.verified_against_knowledge !== false,

    duplicate_check:
      article.duplicate_check !== false,

    quality_check:
      article.quality_check !== false,

    featured: article.featured === true,
    indexable: article.indexable !== false,

    article_schema:
      seo.article_schema === true,

    faq_schema:
      seo.faq_schema === true,

    source: text(
      article.source,
      "blog-writer"
    ),

    content:
      article.content &&
      typeof article.content === "object" &&
      !Array.isArray(article.content)
        ? article.content
        : null
  };
}

function timestamp(article) {
  const values = [
    article.published_at,
    article.updated_at,
    article.generated_at,
    article.created_at
  ];

  for (const value of values) {
    const time = Date.parse(value);

    if (Number.isFinite(time)) {
      return time;
    }
  }

  return 0;
}

function sortArticles(articles) {
  const priority = {
    ready: 3,
    draft: 2,
    published: 1
  };

  return [...articles].sort((a, b) => {
    const difference =
      (priority[b.status] || 0) -
      (priority[a.status] || 0);

    return difference ||
      timestamp(b) - timestamp(a);
  });
}

function createStats(articles) {
  const stats = {
    total: articles.length,
    ready: 0,
    drafts: 0,
    published: 0
  };

  for (const article of articles) {
    if (article.status === "ready") {
      stats.ready++;
    }

    if (article.status === "draft") {
      stats.drafts++;
    }

    if (article.status === "published") {
      stats.published++;
    }
  }

  return stats;
}

function json(data, status = 200, extra = {}) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-store, max-age=0, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...extra
      }
    }
  );
}

export async function handleBlogAdminArticles(
  request,
  env
) {
  if (request.method !== "GET") {
    return json(
      {
        success: false,
        error: "METHOD_NOT_ALLOWED"
      },
      405,
      { Allow: "GET" }
    );
  }

  const req = {
    headers: Object.fromEntries(
      request.headers.entries()
    )
  };

  if (!isBlogAdminAuthenticated(req)) {
    return json(
      {
        success: false,
        authenticated: false,
        error: "UNAUTHORIZED"
      },
      401
    );
  }

  try {
    const repository =
      env.BLOG_GITHUB_REPO ||
      "moh124moh124cry/apxn-landing";

    const branch =
      env.BLOG_GITHUB_BRANCH ||
      "main";

    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
        .test(repository)
    ) {
      throw new Error(
        "Invalid GitHub repository configuration"
      );
    }

    const apiUrl =
      `https://api.github.com/repos/${repository}` +
      "/contents/data/blog-articles.json" +
      `?ref=${encodeURIComponent(branch)}`;

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "APXN-Cloudflare"
    };

    if (env.BLOG_GITHUB_TOKEN) {
      headers.Authorization =
        `Bearer ${env.BLOG_GITHUB_TOKEN}`;
    }

    const response = await fetch(
      apiUrl,
      { headers }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub returned ${response.status}`
      );
    }

    const file = await response.json();

    if (
      file.encoding !== "base64" ||
      typeof file.content !== "string"
    ) {
      throw new Error(
        "Invalid GitHub article manifest"
      );
    }

    const raw = Buffer.from(
      file.content.replace(/\s/g, ""),
      "base64"
    ).toString("utf8");

    const manifest = JSON.parse(raw);

    const source = Array.isArray(
      manifest?.articles
    )
      ? manifest.articles
      : [];

    const articles = sortArticles(
      source
        .map(normalizeArticle)
        .filter(Boolean)
    );

    return json({
      success: true,
      authenticated: true,
      stats: createStats(articles),
      articles
    });

  } catch (error) {
    console.error(
      "Blog admin articles:",
      error?.message || "Unknown error"
    );

    return json(
      {
        success: false,
        authenticated: true,
        error: "ARTICLES_LOAD_FAILED"
      },
      500
    );
  }
}
