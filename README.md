# 📖 ReadSphere — 读原文 · 学英语 · 懂 AI 与投资

一个自动更新的静态网站：把 **AI、Physical AI（具身智能）、投资** 三个领域最值得读的英文博客聚合到一起，用 Claude 做每日文章分析和知识沉淀，让「读英文一手信息」变成一套可持续的英语学习工作流。

## 功能

| 板块 | 说明 |
|---|---|
| **最新文章** | 42 个精选源的 RSS 聚合，支持按领域/难度(CEFR)筛选。已分析的文章可展开：中英摘要、要点、核心词汇(带原文例句)、关联概念 |
| **信息源** | 人工精选的源目录：每个源有中文导读、难度分级、「为什么读」 |
| **知识库 (LLM Wiki)** | 双语概念词典。Claude 从每日文章中提取概念、自动撰写词条(定义/为什么重要/要点/常见误解/术语表/相关词条)，并随新文章持续生长、互相链接 |
| **学习方法** | 三层阅读法、难度阶梯、配套工具建议 |
| **双击查词** | 任何英文段落双击单词即弹出释义(dictionaryapi.dev)，附有道/朗文跳转 |

## 架构

```
site/                  纯静态站点（无框架，可部署到任何静态托管）
  index.html / app.js / styles.css
  data/
    sources.json       人工精选信息源（手动维护）
    articles.json      ← scripts/fetch-feeds.mjs  抓取 RSS 生成
    analysis.json      ← scripts/analyze.mjs      Claude 分析文章生成
    wiki.json          ← scripts/build-wiki.mjs   Claude 撰写词条（含人工种子词条）
scripts/               后台流水线（Node ≥ 20）
.github/workflows/update.yml   每日定时：fetch → analyze → wiki → commit → 部署 Pages
```

流水线特性：

- **增量**：只分析新文章、只为新概念建词条，已有内容不重复调用
- **限额**：每次运行最多分析 20 篇、新建 8 个词条（可用环境变量调整），成本可控
- **优雅降级**：没有 `ANTHROPIC_API_KEY` 时跳过 LLM 步骤，站点仍正常展示文章与种子词条
- **RSS 自愈**：配置的 feed 失效时自动尝试常见路径并解析主页 `<link rel="alternate">`

## 部署（一次性设置）

1. **启用 GitHub Pages**：仓库 Settings → Pages → Source 选 **GitHub Actions**
2. **添加 API Key**：Settings → Secrets and variables → Actions → New repository secret
   - Name: `ANTHROPIC_API_KEY`，Value: 你的 Anthropic API Key（[获取](https://platform.claude.com/)）
3. （可选）Settings → Secrets and variables → Actions → Variables 添加 `ANALYZE_MODEL` 换用其他模型，默认 `claude-opus-4-8`（约 $5/$25 每百万输入/输出 token）。日更 20 篇的典型成本在每天几十美分量级；想更省可设为 `claude-sonnet-5` 或 `claude-haiku-4-5`
4. 合并到 `main` 后，工作流会在每次 push、每天北京时间 06:30、以及手动触发（Actions → Update content & deploy → Run workflow）时运行

## 本地运行

```bash
npm install
npm run fetch        # 抓取 RSS → site/data/articles.json
export ANTHROPIC_API_KEY=sk-ant-...   # 可选
npm run analyze      # LLM 文章分析 → site/data/analysis.json
npm run wiki         # LLM 词条生成 → site/data/wiki.json
npm run dev          # http://localhost:8788
```

> 注意：`data/*.json` 通过 fetch 加载，直接双击打开 index.html 不行，需要本地服务器。

## 维护信息源

编辑 `site/data/sources.json`。每个源的字段：

```jsonc
{
  "id": "unique-id",
  "name": "显示名",  "author": "作者",
  "category": "ai | physical-ai | investing | writing",
  "url": "官网",     "feed": "RSS 地址（留空则只展示不聚合）",
  "type": "blog | newsletter | memo | essay | media",
  "difficulty": 1,   // 1 入门友好 / 2 中级 / 3 进阶
  "cadence_zh": "更新频率",
  "description_zh": "一句话介绍",
  "why_zh": "为什么值得读（含对学英语的价值）",
  "tags": ["标签"]
}
```

## 已知限制

- Feed 地址未逐一在线验证（开发环境无公网出口）；首次 Actions 运行的日志和 `articles.json` 的 `errors` 字段会标出失效源，多数可被自动发现机制修复
- 免费查词接口 (dictionaryapi.dev) 偶尔限流，此时用弹窗里的有道/朗文链接
- Wiki 词条由 LLM 生成，可能有错漏——词条页有标注，学习时保持批判性
