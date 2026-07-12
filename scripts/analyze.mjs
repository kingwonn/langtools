// LLM 分析：对 articles.json 中尚未分析的文章调用 Claude，产出
// 中英摘要 / 难度分级 / 核心词汇 / 关联概念，写入 site/data/analysis.json。
// - 增量：已分析的文章不重复调用
// - 有上限：每次运行最多 MAX_PER_RUN 篇，成本可控
// - 无 ANTHROPIC_API_KEY 时安静跳过，站点自动降级
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'site', 'data');

const MODEL = process.env.ANALYZE_MODEL || 'claude-opus-4-8';
const MAX_PER_RUN = Number(process.env.ANALYZE_MAX_PER_RUN || 20);
const CONCURRENCY = 3;

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary_en',
    'summary_zh',
    'key_points_zh',
    'difficulty',
    'read_minutes',
    'vocabulary',
    'concepts',
  ],
  properties: {
    summary_en: { type: 'string', description: '2-3 sentence English summary, plain language' },
    summary_zh: { type: 'string', description: '2-4 句中文摘要，说清文章讲了什么、结论是什么' },
    key_points_zh: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 条中文要点，每条一句话',
    },
    difficulty: {
      type: 'string',
      enum: ['B1', 'B2', 'C1', 'C2'],
      description: 'CEFR reading difficulty of the English text',
    },
    read_minutes: { type: 'integer', description: 'estimated reading time in minutes' },
    vocabulary: {
      type: 'array',
      description: '5-8 个对中级英语学习者最有价值的词/短语，选真实出现在文中的',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['word', 'pos', 'meaning_zh', 'example'],
        properties: {
          word: { type: 'string' },
          pos: { type: 'string', description: 'part of speech, e.g. n. / v. / adj. / phrase' },
          meaning_zh: { type: 'string', description: '在本文语境下的中文释义' },
          example: { type: 'string', description: 'the sentence (or clause) from the article containing it' },
        },
      },
    },
    concepts: {
      type: 'array',
      items: { type: 'string' },
      description:
        '1-4 个文章涉及的核心概念 slug（kebab-case 英文，如 world-models, dcf-valuation）。优先复用已有 slug 列表中的条目；只有确实是新概念时才创建新 slug。',
    },
  },
};

// 与 build-wiki.mjs 保持一致的 slug 归一化——存储时即归一化，保证前端查询命中
function normalizeSlug(slug) {
  return String(slug)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const SYSTEM = `你是一个双语阅读助手，服务对象是一位以中文为母语、正在通过阅读英文博客提升英语的学习者，关注 AI、Physical AI（具身智能/机器人）和投资。
对给定的英文文章做结构化分析。要求：
- 摘要忠于原文，不脑补；文章信息不足时保守概括
- 词汇选取"值得学"的：高频学术词、地道搭配、行业术语，跳过过于基础或过于生僻的词
- concepts 是知识库词条的索引：只选文章实质讨论的概念，不要泛泛的大词（如 "ai"、"technology"）`;

async function analyzeOne(client, article, sourceName, existingSlugs) {
  const userPrompt = `已有概念 slug 列表（优先复用）：${existingSlugs.join(', ') || '(暂无)'}

来源：${sourceName}
标题：${article.title}
正文（可能被截断）：
${article.snippet || '(RSS 未提供正文，仅根据标题保守分析)'}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('model refused');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('empty response');
  const result = JSON.parse(text);
  result.concepts = [...new Set(
    (result.concepts || []).map(normalizeSlug).filter((s) => s.length >= 2),
  )];
  return result;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ℹ ANTHROPIC_API_KEY 未设置，跳过 LLM 分析（站点将不显示文章分析）。');
    return;
  }

  const articlesFile = await readFile(path.join(DATA, 'articles.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (!articlesFile) {
    console.log('ℹ 找不到 site/data/articles.json，请先运行 npm run fetch。');
    return;
  }
  const sourcesFile = JSON.parse(await readFile(path.join(DATA, 'sources.json'), 'utf8'));
  const analysisFile = await readFile(path.join(DATA, 'analysis.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ analyses: {} }));
  const wikiFile = await readFile(path.join(DATA, 'wiki.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ entries: {} }));

  const sourceNames = Object.fromEntries(sourcesFile.sources.map((s) => [s.id, s.name]));
  const existingSlugs = Object.keys(wikiFile.entries);
  const analyses = analysisFile.analyses || {};

  // 清理很久不再出现的文章的分析，防止文件无限增长。
  // 只删「不在当前窗口且分析已超过 45 天」的条目——单次抓取失败导致文章
  // 暂时消失时，分析结果得以保留，feed 恢复后不必重复花钱分析。
  const liveIds = new Set(articlesFile.articles.map((a) => a.id));
  const cutoff = Date.now() - 45 * 86400000;
  for (const [id, a] of Object.entries(analyses)) {
    if (!liveIds.has(id) && new Date(a.analyzed_at || 0).getTime() < cutoff) {
      delete analyses[id];
    }
  }

  const pending = articlesFile.articles
    .filter((a) => !analyses[a.id])
    .slice(0, MAX_PER_RUN);

  if (pending.length === 0) {
    console.log('✔ 没有新文章需要分析。');
    await writeFile(
      path.join(DATA, 'analysis.json'),
      JSON.stringify({ updated: new Date().toISOString(), analyses }, null, 1),
    );
    return;
  }

  console.log(`→ 分析 ${pending.length} 篇新文章（模型：${MODEL}）...`);
  const client = new Anthropic();

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (article) => {
        try {
          const result = await analyzeOne(
            client,
            article,
            sourceNames[article.source] || article.source,
            existingSlugs,
          );
          analyses[article.id] = { ...result, analyzed_at: new Date().toISOString() };
          ok++;
          console.log(`  ✔ ${article.title.slice(0, 60)}`);
        } catch (err) {
          // 认证/额度类错误影响所有请求，立刻让 CI 失败以便发现，而不是安静地全军覆没
          if (err?.status === 401 || err?.status === 403) {
            throw new Error(`API 认证失败（HTTP ${err.status}）：请检查 ANTHROPIC_API_KEY`);
          }
          failed++;
          console.warn(`  ✖ ${article.title.slice(0, 60)}: ${String(err.message || err).slice(0, 120)}`);
        }
      }),
    );
  }

  await writeFile(
    path.join(DATA, 'analysis.json'),
    JSON.stringify({ updated: new Date().toISOString(), analyses }, null, 1),
  );
  console.log(`✔ 分析完成：${ok} 成功，${failed} 失败 → site/data/analysis.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
