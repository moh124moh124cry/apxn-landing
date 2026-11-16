/**
 * APXN Blog Administration — create, update, replace/remove image and delete.
 * Destination: api/blog-admin-manage.js
 * Branch: cloudflare-migration
 *
 * Authenticated internal endpoint. Never called by public article pages.
 * The matching Cloudflare route is installed in the NEXT STEP.
 */
import { randomBytes } from 'node:crypto';
import { isBlogAdminAuthenticated } from './blog-admin-auth.js';

const REPOSITORY = 'moh124moh124cry/apxn-landing';
const BRANCH = 'cloudflare-migration';
const SITE = 'https://apxn.network';
const GITHUB_API = 'https://api.github.com';
const MANIFEST_PATH = 'data/blog-articles.json';
const DEFAULT_IMAGE = `${SITE}/logo2%20(1).png`;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};
const CATEGORIES = new Set([
  'APXN News', 'APXN Guides', 'Blockchain', 'Web3',
  'Security', 'Education', 'Development', 'BSC'
]);

function fail(code, status = 400) {
  const e = new Error(code);
  e.status = status;
  throw e;
}

function respond(res, status, body) {
  return res.status(status).json({ success: status >= 200 && status < 300, ...body });
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sameOrigin(req) {
  const host = String(req.headers?.host || '').toLowerCase();
  const origin = String(req.headers?.origin || '');
  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (!host || !['apxn.network', 'apxn-landing.apxn-network.workers.dev'].includes(host)) return false;
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === host; }
  catch { return false; }
}

function verifyEnvironment() {
  if (String(process.env.BLOG_GITHUB_REPO || '').trim() !== REPOSITORY ||
      String(process.env.BLOG_GITHUB_BRANCH || '').trim() !== BRANCH) {
    fail('BLOG_MANAGE_BRANCH_MISMATCH', 503);
  }
  const token = String(process.env.BLOG_GITHUB_TOKEN || '').trim();
  if (token.length < 20) fail('BLOG_GITHUB_TOKEN_NOT_CONFIGURED', 503);
  return token;
}

function today() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = name => parts.find(x => x.type === name)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function asText(value, max = 50000) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\0/g, '').trim();
  if (clean.length > max) fail('FIELD_TOO_LONG');
  return clean;
}

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function pathEncode(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function github(endpoint, options = {}) {
  const token = verifyEnvironment();
  const method = options.method || 'GET';
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'APXN-Blog-Admin'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let result = null;
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 409 || response.status === 422) fail('GITHUB_CONFLICT_RETRY', 409);
    if (response.status === 404) fail('GITHUB_FILE_NOT_FOUND', 404);
    if (response.status === 401 || response.status === 403) fail('GITHUB_PERMISSION_DENIED', 503);
    fail(`GITHUB_REQUEST_FAILED_${response.status}`, 502);
  }
  return result;
}

async function readFile(path) {
  const result = await github(`/repos/${REPOSITORY}/contents/${pathEncode(path)}?ref=${BRANCH}`);
  if (result?.encoding !== 'base64' || typeof result.content !== 'string') fail('INVALID_GITHUB_FILE', 502);
  return Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

async function readManifest() {
  let value;
  try { value = JSON.parse(await readFile(MANIFEST_PATH)); }
  catch { fail('INVALID_ARTICLE_MANIFEST', 502); }
  if (!Array.isArray(value.articles)) fail('INVALID_ARTICLE_MANIFEST', 502);
  return value;
}

function makeSlug(title, manifest) {
  const normalized = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 85);
  const seed = normalized || `apxn-article-${today()}`;
  const existing = new Set(manifest.articles.map(a => a.slug));
  if (!existing.has(seed)) return seed;
  for (let i = 2; i < 1000; i++) {
    const slug = `${seed.slice(0, 81)}-${i}`;
    if (!existing.has(slug)) return slug;
  }
  fail('SLUG_UNAVAILABLE', 409);
}

function para(text) { return { text, evidence_ids: [] }; }

function validateArticleInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_ARTICLE');
  const title = asText(raw.title, 180);
  const description = asText(raw.description, 350);
  const category = asText(raw.category, 40) || 'APXN News';
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.slice(0, 15).map(x => asText(x, 70)).filter(Boolean)
    : [];
  const content = raw.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) fail('ARTICLE_CONTENT_MISSING');
  const intro = asText(content.intro?.text, 80000);
  const conclusion = asText(content.conclusion?.text, 80000);
  if (title.length < 4 || description.length < 8 || !intro || !conclusion) fail('ARTICLE_METADATA_INVALID');
  if (!CATEGORIES.has(category)) fail('INVALID_CATEGORY');
  if (!Array.isArray(content.sections) || !content.sections.length || content.sections.length > 40)
    fail('ARTICLE_SECTIONS_INVALID');
  const sections = content.sections.map(section => {
    const heading = asText(section?.heading, 250);
    if (!Array.isArray(section?.paragraphs) || !section.paragraphs.length || section.paragraphs.length > 30)
      fail('ARTICLE_SECTION_EMPTY');
    const paragraphs = section.paragraphs.map(p => para(asText(p?.text, 80000))).filter(p => p.text);
    if (!heading || !paragraphs.length) fail('ARTICLE_SECTION_EMPTY');
    return { heading, paragraphs };
  });
  if (!Array.isArray(content.faq || []) || (content.faq || []).length > 30) fail('ARTICLE_FAQ_INVALID');
  const faq = (content.faq || []).map(item => {
    const question = asText(item?.question, 350);
    const answer = asText(item?.answer, 12000);
    if (!question || !answer) fail('ARTICLE_FAQ_INVALID');
    return { question, answer, evidence_ids: [] };
  });
  const document = { title, description, keywords, intro: para(intro), sections,
    faq, conclusion: para(conclusion) };
  const completeText = [intro, conclusion, ...sections.flatMap(s => s.paragraphs.map(p => p.text)),
    ...faq.flatMap(q => [q.question, q.answer])].join(' ');
  if (completeText.length > 300000) fail('ARTICLE_TOO_LONG');
  const wordCount = (completeText.match(/\S+/g) || []).length;
  return { title, description, excerpt: description, category, keywords, content: document,
    word_count: wordCount, reading_minutes: Math.max(1, Math.ceil(wordCount / 220)) };
}

function parseImage(payload, action) {
  if (action !== 'replace') return null;
  if (!payload || typeof payload !== 'object') fail('IMAGE_REQUIRED');
  const type = asText(payload.type, 40).toLowerCase();
  const extension = IMAGE_EXTENSIONS[type];
  const raw = payload.base64;
  if (!extension || typeof raw !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) ||
      raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) fail('INVALID_IMAGE');
  const data = Buffer.from(raw, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) fail('IMAGE_TOO_LARGE');
  const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  const gif = ['GIF87a','GIF89a'].includes(data.toString('ascii', 0, 6));
  const webp = data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP';
  const valid = (type === 'image/png' && png) || (type === 'image/jpeg' && jpeg) ||
    (type === 'image/gif' && gif) || (type === 'image/webp' && webp);
  if (!valid) fail('INVALID_IMAGE_SIGNATURE');
  return { data, extension };
}

function articleUrl(slug) { return `${SITE}/blog/articles/${slug}.html`; }
function imageFile(slug, extension) {
  const suffix = randomBytes(6).toString('hex');
  return `blog/images/${slug.slice(0, 90)}-${suffix}.${extension}`;
}
function refreshStats(manifest) {
  const a = manifest.articles;
  manifest.stats = { total_articles: a.length, published: a.filter(x=>x.status==='published').length,
    ready: a.filter(x=>x.status==='ready').length, drafts: a.filter(x=>x.status==='draft').length,
    featured: a.filter(x=>x.featured === true).length };
}

function replaceRequired(source, expression, replacement, label) {
  if (!expression.test(source)) fail(`TEMPLATE_INCOMPATIBLE_${label}`, 409);
  return source.replace(expression, replacement);
}

function replaceMeta(source, attribute, name, value) {
  const pattern = new RegExp(`<meta\\s+${attribute}=["']${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']\\s+content=["'][^"']*["']\\s*\\/?>`, 'i');
  if (!pattern.test(source)) fail(`TEMPLATE_META_MISSING_${name}`,409);
  return source.replace(pattern, `<meta ${attribute}="${name}" content="${esc(value)}">`);
}

function buildRelatedReading(article, manifest) {
  const others = manifest.articles.filter(a => a.status === 'published' && a.slug !== article.slug)
    .slice(-3).reverse();
  if (!others.length) return '';
  return `<section>\n<h2>Related reading</h2>\n<ul>\n${others.map(a =>
    `<li><a href="./${esc(a.slug)}.html">${esc(a.title)}</a></li>`).join('\n')}\n</ul>\n</section>`;
}

function renderArticleCore(article) {
  const c = article.content;
  const sections = c.sections.map(s => `<section>\n<h2>${esc(s.heading)}</h2>\n${s.paragraphs.map(p =>
    `<p>${esc(p.text)}</p>`).join('\n')}\n</section>`).join('\n');
  const faq = c.faq.length ? `<section>\n<h2>Frequently asked questions</h2>\n${c.faq.map(f =>
    `<div class="info-box"><h3>${esc(f.question)}</h3><p>${esc(f.answer)}</p></div>`).join('\n')}\n</section>` : '';
  return `\n<p class="text-lg">${esc(c.intro.text)}</p>\n${sections}\n${faq}\n`+
    `<section>\n<h2>Conclusion</h2>\n<p>${esc(c.conclusion.text)}</p>\n</section>\n`;
}

function rewriteStructuredData(html, article, imageUrl, canonical, date) {
  let foundArticle = false;
  const output = html.replace(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/gi,
    (whole, raw) => {
      let obj;
      try { obj = JSON.parse(raw); } catch { return whole; }
      if (obj['@type'] === 'Article' || obj['@type'] === 'NewsArticle') {
        foundArticle = true;
        obj.headline = article.title;
        obj.description = article.description;
        obj.image = imageUrl;
        obj.mainEntityOfPage = canonical;
        obj.datePublished = article.published_at || date;
        obj.dateModified = date;
      } else if (obj['@type'] === 'FAQPage') {
        obj.mainEntity = article.content.faq.map(f => ({ '@type': 'Question', name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer } }));
        if (!obj.mainEntity.length) return '';
      } else return whole;
      return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2).replace(/</g,'\\u003c')}\n</script>`;
    });
  if (!foundArticle) fail('TEMPLATE_ARTICLE_SCHEMA_MISSING', 409);
  const hasFaq = [...output.matchAll(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/gi)]
    .some(match => { try { return JSON.parse(match[1])['@type'] === 'FAQPage'; }
      catch { return false; } });
  if (article.content.faq.length && !hasFaq) {
    const faq = { '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: article.content.faq.map(f=>({ '@type':'Question', name:f.question,
        acceptedAnswer: { '@type':'Answer', text:f.answer } })) };
    return output.replace('</head>', `<script type="application/ld+json">\n${JSON.stringify(faq,null,2).replace(/</g,'\\u003c')}\n</script>\n</head>`);
  }
  return output;
}

/**
 * Preserve the existing design, layout, footer and Related Reading links.
 * Replace only the editor-controlled title, metadata, image, body and FAQ schema.
 * A new published article is based on the same official page template.
 */
function renderFromTemplate(template, article, manifest, keepOriginalRelated) {
  const canonical = articleUrl(article.slug);
  const image = article.image || DEFAULT_IMAGE;
  let html = template;
  html = replaceRequired(html, /<title>[\s\S]*?<\/title>/i,
    `<title>${esc(article.title)}</title>`, 'TITLE');
  html = replaceMeta(html, 'name', 'description', article.description);
  html = replaceMeta(html, 'name', 'keywords', article.keywords.join(', '));
  html = replaceMeta(html, 'property', 'og:title', article.title);
  html = replaceMeta(html, 'property', 'og:description', article.description);
  html = replaceMeta(html, 'property', 'og:url', canonical);
  html = replaceMeta(html, 'property', 'og:image', image);
  html = replaceMeta(html, 'name', 'twitter:title', article.title);
  html = replaceMeta(html, 'name', 'twitter:description', article.description);
  html = replaceMeta(html, 'name', 'twitter:image', image);
  html = replaceRequired(html, /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?\s*>/i,
    `<link rel="canonical" href="${esc(canonical)}">`, 'CANONICAL');

  html = replaceRequired(html,
    /(<h1\b[^>]*>)[\s\S]*?(<\/h1>\s*<p\b[^>]*>)[\s\S]*?(<\/p>)/i,
    (_, h1, h1ToP, pEnd) => `${h1}${esc(article.title)}${h1ToP}${esc(article.description)}${pEnd}`,
    'HERO');

  html = replaceRequired(html, /(<figure\b[^>]*>[\s\S]*?<img\b[^>]*\bsrc=")[^"]*("[^>]*>)/i,
    (_, before, after) => `${before}${esc(image)}${after.replace(/\balt="[^"]*"/, `alt="${esc(article.title)}"`)}`,
    'HERO_IMAGE');

  // Update breadcrumb and category badge while preserving their CSS/classes.
  html = html.replace(/(<span\b[^>]*class="text-yellow-400"[^>]*>)[\s\S]*?(<\/span>)/i,
    (_, open, close) => `${open}${esc(article.category)}${close}`);
  html = html.replace(/(<span\b[^>]*class="[^"]*inline-flex border border-yellow-500\/30[^"]*"[^>]*>)[\s\S]*?(<\/span>)/i,
    (_, open, close) => `${open}${esc(article.category)}${close}`);
  html = html.replace(/(<span>\s*)\d+\s+min read(\s*<\/span>)/i,
    (_, open, close) => `${open}${article.reading_minutes} min read${close}`);

  const bodyStart = /<div\s+class="article-body"\s*>/i.exec(html);
  if (!bodyStart) fail('TEMPLATE_ARTICLE_BODY_MISSING', 409);
  const start = bodyStart.index + bodyStart[0].length;
  const rest = html.slice(start);
  const editorialMatch = /<div\s+class="info-box"\s*>\s*<strong>\s*Editorial note:/i.exec(rest);
  if (!editorialMatch) fail('TEMPLATE_EDITORIAL_NOTE_MISSING', 409);
  const end = start + editorialMatch.index;
  const bodyOld = html.slice(start, end);
  const originalRelated = /<section>\s*<h2>\s*Related reading\s*<\/h2>[\s\S]*?<\/section>/i.exec(bodyOld)?.[0];
  const related = (keepOriginalRelated && originalRelated) ? originalRelated : buildRelatedReading(article, manifest);
  const newCore = renderArticleCore(article);
  html = html.slice(0, start) + newCore + '\n' + related + '\n\n' + html.slice(end);

  const footerNote = ['APXN News', 'APXN Guides'].includes(article.category)
    ? 'APXN Points are participation points within the Apex Network ecosystem. Future token distributions and claim stages follow official project announcements.'
    : 'This article is educational content and should not be treated as financial, investment, legal or tax advice.';
  html = html.replace(/(<strong>\s*Editorial note:\s*<\/strong>\s*<p>)[\s\S]*?(<\/p>)/i,
    (_, before, after) => `${before}${esc(footerNote)}${after}`);

  // The original share controls must point at the unchanged canonical URL.
  const shareScript = `const APXN_ARTICLE_SHARE = { title: ${safeJson(article.title)}, url: ${safeJson(canonical)} };`;
  html = replaceRequired(html,
    /const\s+APXN_ARTICLE_SHARE\s*=\s*\{[\s\S]*?\};/,
    shareScript, 'SHARE');

  html = rewriteStructuredData(html, article, image, canonical, today());
  if (newCore.includes('<a ')) fail('UNEXPECTED_ARTICLE_BODY_LINK');
  if (!html.includes('Related reading') && related) fail('RELATED_READING_MISSING', 409);
  return html;
}

async function createBlob(content, encoding) {
  return github(`/repos/${REPOSITORY}/git/blobs`, {
    method:'POST', body: { content, encoding }
  });
}

/** Commit all changed paths in ONE non-force GitHub commit. */
async function commitChanges(changes, message) {
  const ref = await github(`/repos/${REPOSITORY}/git/ref/heads/${BRANCH}`);
  const head = ref?.object?.sha;
  if (!head) fail('GITHUB_BRANCH_NOT_FOUND', 503);
  const commit = await github(`/repos/${REPOSITORY}/git/commits/${head}`);
  const parentTree = commit?.tree?.sha;
  if (!parentTree) fail('GITHUB_TREE_NOT_FOUND', 503);
  const tree = [];
  for (const change of changes) {
    if (!/^((data\/blog-articles\.json)|(blog\/(articles|images)\/[a-z0-9][a-z0-9._-]*))$/.test(change.path))
      fail('UNSAFE_FILE_PATH');
    if (change.content === null) {
      tree.push({ path:change.path, mode:'100644', type:'blob', sha:null });
    } else {
      const blob = await createBlob(change.content, change.encoding || 'utf-8');
      tree.push({ path:change.path, mode:'100644', type:'blob', sha:blob.sha });
    }
  }
  const updatedTree = await github(`/repos/${REPOSITORY}/git/trees`, {
    method:'POST', body:{ base_tree:parentTree, tree }
  });
  const newCommit = await github(`/repos/${REPOSITORY}/git/commits`, {
    method:'POST', body:{ message, tree:updatedTree.sha, parents:[head] }
  });
  await github(`/repos/${REPOSITORY}/git/refs/heads/${BRANCH}`, {
    method:'PATCH', body:{ sha:newCommit.sha, force:false }
  });
  return newCommit.sha;
}

async function buildChanges(payload) {
  const action = asText(payload?.action, 16);
  if (!['create','update','delete'].includes(action)) fail('UNKNOWN_ACTION');
  const manifest = await readManifest();
  const id = asText(payload?.article_id, 140);
  const current = action === 'create' ? null : manifest.articles.find(a=>a.id === id);
  if (action !== 'create' && !current) fail('ARTICLE_NOT_FOUND',404);
  if (action !== 'create' && payload.expected_updated_at !== undefined &&
      payload.expected_updated_at !== null &&
      payload.expected_updated_at !== current.updated_at) fail('ARTICLE_MODIFIED_RELOAD',409);

  if (action === 'delete') {
    // Only remove this article and its published page; unrelated articles remain.
    const index = manifest.articles.findIndex(a=>a.id===id);
    manifest.articles.splice(index,1);
    if (Array.isArray(manifest.generation_queue)) manifest.generation_queue =
      manifest.generation_queue.filter(item=>item.article_id !== id);
    manifest.last_updated = today();
    refreshStats(manifest);
    const changes = [{path:MANIFEST_PATH,content:JSON.stringify(manifest,null,2)+'\n'}];
    if (current.status === 'published' && current.path &&
        /^blog\/articles\/[a-z0-9][a-z0-9._-]*\.html$/.test(current.path)) {
      changes.push({path:current.path,content:null});
      // Remove links to the deleted article in other Related Reading sections.
      const published = manifest.articles.filter(a=>a.status==='published' &&
        /^blog\/articles\/[a-z0-9][a-z0-9._-]*\.html$/.test(a.path || ''));
      const target = `./${current.slug}.html`;
      for (const other of published) {
        const html = await readFile(other.path);
        const relatedSection = /<section>\s*<h2>\s*Related reading\s*<\/h2>[\s\S]*?<\/section>/i;
        const next = html.replace(relatedSection, section => section.replace(
          /<li>\s*<a\s+href="([^"]+)"[\s\S]*?<\/a>\s*<\/li>/gi,
          (li, href) => href === target ? '' : li
        ));
        if (next !== html) changes.push({path:other.path,content:next});
      }
    }
    return { changes, result:{action,article_id:id,deleted:true}, message:`fix(blog): delete ${current.slug}` };
  }

  const approved = validateArticleInput(payload.article);
  const requestedStatus = asText(payload.article?.status, 24).toLowerCase();
  if (!['published','draft','ready'].includes(requestedStatus)) fail('INVALID_ARTICLE_STATUS');
  const published = requestedStatus === 'published';
  const imageAction = asText(payload.image_action || 'keep',16).toLowerCase();
  if (!['keep','replace','remove'].includes(imageAction)) fail('INVALID_IMAGE_ACTION');
  const image = parseImage(payload.image, imageAction);
  if (published && !current && !image) fail('PUBLISHED_IMAGE_REQUIRED');
  const slug = current?.slug || makeSlug(approved.title,manifest);
  const date = today();
  const article = current ? { ...current } : {
    id:`manual-${date.replaceAll('-','')}-${randomBytes(5).toString('hex')}`,
    slug, author:'Apex Network Editorial', language:'en', featured:false,
    created_at:date, generated_at:date, published_at:'',
    source:'admin_manual', content_mode:'apxn'
  };
  const oldPublished = current?.status === 'published';
  if (oldPublished && !published) fail('PUBLISHED_ARTICLE_CANNOT_BECOME_DRAFT');
  const articlePath = current?.path || `blog/articles/${slug}.html`;
  if (published && !/^blog\/articles\/[a-z0-9][a-z0-9._-]*\.html$/.test(articlePath)) fail('UNSAFE_ARTICLE_PATH');
  Object.assign(article, approved, {
    status:requestedStatus, slug, updated_at:date,
    indexable:published, seo_ready:true, facts_verified: current?.facts_verified ?? false,
    duplicate_check: current?.duplicate_check ?? false,
    quality_check: current?.quality_check ?? false,
    path: published ? articlePath : (current?.path || ''),
    url: published ? articleUrl(slug) : (current?.url || ''),
    published_url: published ? articleUrl(slug) : (current?.published_url || '')
  });
  if (published && !article.published_at) article.published_at = date;
  if (imageAction === 'remove') {
    article.image = DEFAULT_IMAGE;
    article.image_filename = '';
  } else if (imageAction === 'replace' && image) {
    const filePath = imageFile(slug, image.extension);
    article.image = `${SITE}/${filePath}`;
    article.image_filename = filePath.split('/').pop();
    article.__image_path = filePath;
  } else {
    article.image = current?.image || DEFAULT_IMAGE;
    article.image_filename = current?.image_filename || '';
  }
  if (published && !article.image) fail('PUBLISHED_IMAGE_REQUIRED');
  article.seo = {
    ...(current?.seo || {}), title:article.title, description:article.description,
    canonical:published ? articleUrl(slug) : '', robots:published ? 'index, follow':'noindex, nofollow',
    article_schema:published, faq_schema: published && article.content.faq.length > 0
  };
  if (current) {
    const index = manifest.articles.findIndex(a=>a.id===id);
    manifest.articles[index]=article;
  } else manifest.articles.push(article);
  if (Array.isArray(manifest.generation_queue)) {
    for (const queued of manifest.generation_queue) {
      if (queued.article_id === article.id) {
        queued.status = article.status;
        if (published) queued.published_at = article.published_at;
      }
    }
  }
  manifest.last_updated=date;
  refreshStats(manifest);
  const changes=[];
  if (published) {
    let template;
    if (oldPublished) template=await readFile(articlePath);
    else {
      const candidate=manifest.articles.find(a=>a.id!==article.id && a.status==='published' &&
        /^blog\/articles\/[a-z0-9][a-z0-9._-]*\.html$/.test(a.path||''));
      if (!candidate) fail('PUBLISHED_TEMPLATE_NOT_FOUND',409);
      template=await readFile(candidate.path);
    }
    const html=renderFromTemplate(template,article,manifest,oldPublished);
    changes.push({path:articlePath,content:html});
  }
  if (article.__image_path) {
    changes.push({path:article.__image_path,content:image.data.toString('base64'),encoding:'base64'});
    delete article.__image_path;
  }
  changes.push({path:MANIFEST_PATH,content:JSON.stringify(manifest,null,2)+'\n'});
  return {changes,result:{action,article_id:article.id,slug,status:article.status,
    url:article.url,image:article.image,image_filename:article.image_filename},
    message:`${current?'fix':'feat'}(blog): ${current?'update':'create'} ${slug}`};
}

export default async function handler(req,res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return respond(res,405,{error:'METHOD_NOT_ALLOWED'});
  }
  if (!sameOrigin(req)) return respond(res,403,{error:'INVALID_ORIGIN'});
  if (!isBlogAdminAuthenticated(req)) return respond(res,401,{error:'UNAUTHORIZED',authenticated:false});
  try {
    verifyEnvironment();
    const {changes,result,message}=await buildChanges(req.body);
    const commit=await commitChanges(changes,message);
    return respond(res,200,{...result,commit});
  } catch(error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(String(error?.message||''))
      ? error.message : 'ARTICLE_MANAGE_FAILED';
    const status = Number(error?.status) || 400;
    console.error('APXN blog article management:',code);
    return respond(res,status,{error:code});
  }
}

