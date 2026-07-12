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
const MAX_MEMORY_ITEMS = 40; // 每个词条记忆时间线的容量（保最新）
const SYNTHESIS_THRESHOLD = 5; // 新增记忆达到该数量时触发词条巩固
const MAX_SYNTHESIS_PER_RUN = Number(process.env.WIKI_MAX_SYNTHESIS_PER_RUN || 3);

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

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['developments_zh'],
  properties: {
    developments_zh: {
      type: 'array',
      description: '3-6 条「最新动态与争论」，从记忆时间线综合提炼，按重要性排序',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point_zh', 'period'],
        properties: {
          point_zh: {
            type: 'string',
            description: '一条动态/争论的中文综述，注明关键主体；如有对立观点，并列呈现',
          },
          period: { type: 'string', description: '大致时间，如 2026-07 或 2026 上半年' },
        },
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

// 记忆巩固：把词条积累的观点记忆综合成「最新动态与争论」小节
async function synthesizeEntry(client, entry) {
  const memoryLines = (entry.memory || [])
    .slice(0, 25)
    .map((m) => `- [${m.date?.slice(0, 10) || '?'}][${m.dimension}] ${m.claim_zh}（${m.source}）`)
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: SYNTHESIS_SCHEMA },
    },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `词条：${entry.title_zh}（${entry.title_en}）
定义：${entry.definition_zh}

以下是该概念近期积累的观点记忆（来自不同信息源的论断，可能相互矛盾）：
${memoryLines}

请综合成 3-6 条「最新动态与争论」：合并同类观点、并列对立观点、忽略噪音；每条注明大致时间。这是词条的"记忆巩固"，读者会靠它快速了解该概念当下的状态。`,
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

  // 汇总：concept slug -> 引用文章 / 观点记忆
  const conceptRefs = new Map();
  const conceptMemory = new Map();
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
    for (const ins of analysis.insights || []) {
      for (const raw of ins.concepts || []) {
        const slug = normalizeSlug(raw);
        if (!slug || slug.length < 2) continue;
        if (!conceptMemory.has(slug)) conceptMemory.set(slug, []);
        conceptMemory.get(slug).push({
          claim_zh: ins.claim_zh,
          dimension: ins.dimension,
          article_id: article.id,
          title: article.title,
          link: article.link,
          date: article.date,
          source: sourceNames[article.source] || article.source,
        });
      }
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

  // 3) 记忆入账：观点沉淀到词条的 memory 时间线（去重、保最新、计数待巩固）
  const ts = (d) => {
    const t = new Date(d || 0).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  let memoryAdded = 0;
  for (const [slug, items] of conceptMemory) {
    const entry = entries[slug];
    if (!entry) continue; // 概念还没有词条时，等词条建好后下次运行入账
    entry.memory ||= [];
    const seen = new Set(entry.memory.map((m) => `${m.article_id}|${m.claim_zh}`));
    const fresh = items.filter((m) => !seen.has(`${m.article_id}|${m.claim_zh}`));
    if (fresh.length === 0) continue;
    entry.memory = [...fresh, ...entry.memory]
      .sort((a, b) => ts(b.date) - ts(a.date))
      .slice(0, MAX_MEMORY_ITEMS);
    entry.pending_synthesis = (entry.pending_synthesis || 0) + fresh.length;
    entry.updated_at = new Date().toISOString();
    memoryAdded += fresh.length;
  }

  // 4) 记忆巩固：积累足够新记忆的词条，综合出「最新动态与争论」
  let synthesized = 0;
  const dueForSynthesis = Object.values(entries)
    .filter((e) => (e.pending_synthesis || 0) >= SYNTHESIS_THRESHOLD)
    .sort((a, b) => (b.pending_synthesis || 0) - (a.pending_synthesis || 0))
    .slice(0, MAX_SYNTHESIS_PER_RUN);

  if (dueForSynthesis.length > 0 && !process.env.ANTHROPIC_API_KEY) {
    console.log(`ℹ ${dueForSynthesis.length} 个词条待巩固，但 ANTHROPIC_API_KEY 未设置，跳过。`);
  } else if (dueForSynthesis.length > 0) {
    const client = new Anthropic();
    for (const entry of dueForSynthesis) {
      try {
        const result = await synthesizeEntry(client, entry);
        entry.developments_zh = result.developments_zh;
        entry.pending_synthesis = 0;
        entry.updated_at = new Date().toISOString();
        synthesized++;
        console.log(`  🧠 巩固 ${entry.slug} → ${result.developments_zh.length} 条最新动态`);
      } catch (err) {
        console.warn(`  ✖ 巩固 ${entry.slug} 失败: ${String(err.message || err).slice(0, 120)}`);
      }
    }
  }

  await writeFile(
    path.join(DATA, 'wiki.json'),
    JSON.stringify({ updated: new Date().toISOString(), entries }, null, 1),
  );
  console.log(
    `✔ Wiki：新建 ${created} 个词条，追加 ${refUpdates} 条文章引用，入账 ${memoryAdded} 条记忆，巩固 ${synthesized} 个词条，共 ${Object.keys(entries).length} 个词条 → site/data/wiki.json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
