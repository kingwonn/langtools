// LLM Wiki：把 analyze.mjs 提取出的概念沉淀为互相链接的知识词条。
// - 新概念 → 调 Claude 生成完整词条（定义/为什么重要/要点/误解/相关概念/术语表）
// - 已有概念 → 只增量追加引用文章，不重复生成
// - 每次运行最多新建 MAX_NEW_ENTRIES 个词条
// - 无 ANTHROPIC_API_KEY 时只更新文章引用，不新建词条
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'site', 'data');

const MODEL = process.env.ANALYZE_MODEL || 'claude-opus-4-8';
const MAX_NEW_ENTRIES = Number(process.env.WIKI_MAX_NEW_ENTRIES || 8);
const MAX_ARTICLE_REFS = 15; // 每个词条最多保留的引用文章数

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title_en',
    'title_zh',
    'category',
    'one_liner_zh',
    'definition_en',
    'definition_zh',
    'why_matters_zh',
    'key_points',
    'misconceptions_zh',
    'related',
    'terms',
  ],
  properties: {
    title_en: { type: 'string' },
    title_zh: { type: 'string' },
    category: { type: 'string', enum: ['ai', 'physical-ai', 'investing', 'writing', 'general'] },
    one_liner_zh: { type: 'string', description: '一句话中文概括，用于列表页' },
    definition_en: {
      type: 'string',
      description: '2-3 sentence English definition, written in clear B2-level English (this doubles as reading material)',
    },
    definition_zh: { type: 'string', description: '对应的中文定义，可比英文稍详细' },
    why_matters_zh: { type: 'string', description: '为什么这个概念重要 / 和 AI、机器人或投资的关系，中文 2-4 句' },
    key_points: {
      type: 'array',
      description: '3-5 个核心要点，中英对照',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['en', 'zh'],
        properties: { en: { type: 'string' }, zh: { type: 'string' } },
      },
    },
    misconceptions_zh: {
      type: 'array',
      items: { type: 'string' },
      description: '1-3 条常见误解及澄清（中文），没有就返回空数组',
    },
    related: {
      type: 'array',
      items: { type: 'string' },
      description: '相关概念 slug（kebab-case），优先复用已有 slug 列表',
    },
    terms: {
      type: 'array',
      description: '3-6 个该领域讨论此概念时的高频英文术语，中英对照',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['en', 'zh'],
        properties: { en: { type: 'string' }, zh: { type: 'string' } },
      },
    },
  },
};

const SYSTEM = `你是一个双语知识库编辑，为一位通过阅读英文博客学习 AI、Physical AI（具身智能）和投资的中文母语学习者维护概念词典。
为给定概念撰写词条。要求：
- 准确、克制，不夸大；有争议的地方指出争议
- definition_en 用清晰的 B2 水平英文书写——它本身也是学习者的阅读材料
- 中文部分自然流畅，术语首次出现附英文原词
- related 只列真正强相关的概念`;

function normalizeSlug(slug) {
  return String(slug)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function generateEntry(client, slug, refs, existingSlugs) {
  const refLines = refs
    .slice(0, 6)
    .map((r) => `- ${r.title}${r.summary ? `：${r.summary.slice(0, 200)}` : ''}`)
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: ENTRY_SCHEMA },
    },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `概念 slug：${slug}

提到该概念的近期文章（供参考语境，词条应超越单篇文章、写成通用知识）：
${refLines || '（暂无文章上下文，凭领域知识撰写）'}

已有词条 slug 列表（related 字段优先复用这些）：${existingSlugs.join(', ') || '(暂无)'}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('model refused');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('empty response');
  return JSON.parse(text);
}

async function main() {
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

  const entries = wikiFile.entries || {};
  const analyses = analysisFile.analyses || {};
  const articleById = Object.fromEntries(articlesFile.articles.map((a) => [a.id, a]));
  const sourceNames = Object.fromEntries(sourcesFile.sources.map((s) => [s.id, s.name]));

  // 汇总：concept slug -> 引用文章
  const conceptRefs = new Map();
  for (const [articleId, analysis] of Object.entries(analyses)) {
    const article = articleById[articleId];
    if (!article) continue;
    for (const raw of analysis.concepts || []) {
      const slug = normalizeSlug(raw);
      if (!slug || slug.length < 2) continue;
      if (!conceptRefs.has(slug)) conceptRefs.set(slug, []);
      conceptRefs.get(slug).push({
        id: article.id,
        title: article.title,
        link: article.link,
        date: article.date,
        source: sourceNames[article.source] || article.source,
        summary: analysis.summary_zh,
      });
    }
  }

  // 1) 为已有词条增量追加文章引用
  let refUpdates = 0;
  for (const [slug, refs] of conceptRefs) {
    const entry = entries[slug];
    if (!entry) continue;
    const known = new Set((entry.articles || []).map((a) => a.id));
    const fresh = refs.filter((r) => !known.has(r.id));
    if (fresh.length === 0) continue;
    entry.articles = [...fresh.map(({ summary, ...rest }) => rest), ...(entry.articles || [])]
      .slice(0, MAX_ARTICLE_REFS);
    entry.updated_at = new Date().toISOString();
    refUpdates += fresh.length;
  }

  // 2) 新概念 → 生成词条
  const newSlugs = [...conceptRefs.keys()]
    .filter((slug) => !entries[slug])
    // 被多篇文章提到的概念优先
    .sort((a, b) => conceptRefs.get(b).length - conceptRefs.get(a).length)
    .slice(0, MAX_NEW_ENTRIES);

  let created = 0;
  if (newSlugs.length > 0 && !process.env.ANTHROPIC_API_KEY) {
    console.log(`ℹ 有 ${newSlugs.length} 个新概念待生成，但 ANTHROPIC_API_KEY 未设置，跳过。`);
  } else if (newSlugs.length > 0) {
    const client = new Anthropic();
    console.log(`→ 生成 ${newSlugs.length} 个新词条（模型：${MODEL}）...`);
    for (const slug of newSlugs) {
      try {
        const existingSlugs = Object.keys(entries);
        const refs = conceptRefs.get(slug);
        const generated = await generateEntry(client, slug, refs, existingSlugs);
        entries[slug] = {
          slug,
          ...generated,
          related: (generated.related || []).map(normalizeSlug).filter((s) => s && s !== slug),
          articles: refs.map(({ summary, ...rest }) => rest).slice(0, MAX_ARTICLE_REFS),
          origin: 'llm',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        created++;
        console.log(`  ✔ ${slug} — ${generated.title_zh}`);
      } catch (err) {
        console.warn(`  ✖ ${slug}: ${String(err.message || err).slice(0, 120)}`);
      }
    }
  }

  await writeFile(
    path.join(DATA, 'wiki.json'),
    JSON.stringify({ updated: new Date().toISOString(), entries }, null, 1),
  );
  console.log(
    `✔ Wiki：新建 ${created} 个词条，追加 ${refUpdates} 条文章引用，共 ${Object.keys(entries).length} 个词条 → site/data/wiki.json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
