// 抓取 sources.json 中所有 RSS/Atom 源，生成 site/data/articles.json
// 单个源失败不影响整体；无网络依赖之外的副作用。
import Parser from 'rss-parser';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'site', 'data');

const PER_SOURCE_LIMIT = 12;
const SNIPPET_CHARS = 6000; // 保留较长正文供 LLM 分析使用
const CONCURRENCY = 6;

const parser = new Parser({
  timeout: 25000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ReadSphereBot/1.0; +https://github.com)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  },
});

function stripHtml(html = '') {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function articleId(link) {
  return createHash('sha1').update(link).digest('hex').slice(0, 12);
}

// 配置的 feed 失效时的自愈：尝试常见路径 + 解析主页 <link rel="alternate">
const COMMON_FEED_PATHS = [
  '/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/atom.xml',
  '/feed.xml', '/index.xml', '/blog/feed/', '/feeds/posts/default?alt=rss',
];

async function discoverFeed(siteUrl) {
  const base = new URL(siteUrl);
  const candidates = [];
  try {
    const res = await fetch(base.origin + base.pathname, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReadSphereBot/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const html = await res.text();
      const linkTags = html.match(/<link[^>]+rel=["']alternate["'][^>]*>/gi) || [];
      for (const tag of linkTags) {
        if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
        const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
        if (href) candidates.push(new URL(href, base).href);
      }
    }
  } catch { /* 主页拿不到就只试常见路径 */ }
  candidates.push(...COMMON_FEED_PATHS.map((p) => base.origin + p));

  for (const url of candidates) {
    try {
      const feed = await parser.parseURL(url);
      if (feed.items?.length) return { url, feed };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

async function fetchSource(source) {
  if (!source.feed) return { source, articles: [], skipped: true };
  try {
    let feed;
    try {
      feed = await parser.parseURL(source.feed);
      if (!feed.items?.length) throw new Error('feed empty');
    } catch (primaryErr) {
      const discovered = await discoverFeed(source.url);
      if (!discovered) throw primaryErr;
      feed = discovered.feed;
      console.warn(`  ↻ ${source.id}: 配置的 feed 失效，自动发现 → ${discovered.url}`);
    }
    const articles = (feed.items || [])
      .filter((it) => it.link && it.title && /^https?:\/\//i.test(it.link))
      .slice(0, PER_SOURCE_LIMIT)
      .map((it) => {
        const body = it['content:encoded'] || it.content || it.summary || it.contentSnippet || '';
        return {
          id: articleId(it.link),
          source: source.id,
          title: stripHtml(it.title),
          link: it.link,
          date: it.isoDate || it.pubDate || null,
          snippet: stripHtml(body).slice(0, SNIPPET_CHARS),
        };
      });
    return { source, articles };
  } catch (err) {
    return { source, articles: [], error: String(err.message || err).slice(0, 200) };
  }
}

async function main() {
  const sourcesFile = JSON.parse(await readFile(path.join(DATA, 'sources.json'), 'utf8'));
  const sources = sourcesFile.sources;

  const results = [];
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(fetchSource))));
  }

  const articles = results
    .flatMap((r) => r.articles)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const errors = results
    .filter((r) => r.error)
    .map((r) => ({ source: r.source.id, error: r.error }));

  const output = {
    updated: new Date().toISOString(),
    count: articles.length,
    errors,
    articles,
  };
  await writeFile(path.join(DATA, 'articles.json'), JSON.stringify(output, null, 1));

  const ok = results.filter((r) => !r.error && !r.skipped).length;
  console.log(`✔ feeds: ${ok} ok, ${errors.length} failed, ${results.filter((r) => r.skipped).length} skipped (no feed)`);
  console.log(`✔ ${articles.length} articles → site/data/articles.json`);
  for (const e of errors) console.warn(`  ✖ ${e.source}: ${e.error}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
