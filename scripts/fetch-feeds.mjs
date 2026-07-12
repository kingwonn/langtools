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

// 完整的浏览器 UA：Substack 原生域名（*.substack.com）会对明显的 bot UA 返回 403
const parser = new Parser({
  timeout: 25000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
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
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
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

// 硬性墙钟超时：rss-parser 的空闲超时对「缓慢滴流」的响应（如 WAF 挑战页）不生效，
// 必须用 Promise.race 兜底，否则单个源能吊死整个抓取步骤
const SOURCE_BUDGET_MS = 90000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超过 ${ms / 1000}s 硬超时`)), ms).unref?.(),
  )]);
}

async function fetchSourceInner(source) {
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
  return feed;
}

async function fetchSource(source) {
  if (!source.feed) return { source, articles: [], skipped: true };
  try {
    const feed = await withTimeout(fetchSourceInner(source), SOURCE_BUDGET_MS, source.id);
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

  const ts = (d) => {
    const t = new Date(d || 0).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  const articles = results
    .flatMap((r) => r.articles)
    .sort((a, b) => ts(b.date) - ts(a.date));

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

  // 被硬超时放弃的请求可能仍挂在事件循环上，显式退出防止进程吊死
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
