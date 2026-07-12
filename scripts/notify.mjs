// 每日学习摘要推送：飞书群机器人 webhook / PushPlus（微信）。
// 内容以英文为主（学习导向）：精选文章 + 每日词汇卡 + 站点链接。
// 未配置任何推送渠道时安静跳过；DRY_RUN=1 只打印不发送。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'site', 'data');
const SITE_URL = process.env.SITE_URL || 'https://kingwonn.github.io/langtools/';
const PICKS = 3;

async function loadJSON(name, fallback) {
  return readFile(path.join(DATA, name), 'utf8').then(JSON.parse).catch(() => fallback);
}

function buildDigest(articles, analysis, sources) {
  const srcName = Object.fromEntries(sources.sources.map((s) => [s.id, s.name]));
  const analyses = analysis?.analyses || {};

  // 优先选已分析的最新文章（有导读价值），不足则用未分析的补齐
  const analyzed = articles.articles.filter((a) => analyses[a.id]);
  const rest = articles.articles.filter((a) => !analyses[a.id]);
  const picks = [...analyzed, ...rest].slice(0, PICKS).map((a) => ({
    title: a.title,
    link: a.link,
    source: srcName[a.source] || a.source,
    an: analyses[a.id] || null,
  }));

  // 每日词汇：从今天可见的分析里凑 3 个词
  const vocab = [];
  for (const a of analyzed) {
    for (const v of analyses[a.id].vocabulary || []) {
      if (vocab.length < 3 && !vocab.some((x) => x.word === v.word)) vocab.push(v);
    }
    if (vocab.length >= 3) break;
  }

  return { picks, vocab };
}

function digestLinesText({ picks, vocab }) {
  const lines = [];
  lines.push(`📖 ReadSphere Daily · ${new Date().toISOString().slice(5, 10)}`);
  lines.push('');
  picks.forEach((p, i) => {
    const diff = p.an ? ` [${p.an.difficulty}]` : '';
    lines.push(`${i + 1}. ${p.title}${diff} — ${p.source}`);
    if (p.an?.summary_en) lines.push(`   ${p.an.summary_en}`);
    if (p.an?.summary_zh) lines.push(`   💡 ${p.an.summary_zh}`);
    lines.push(`   ${p.link}`);
  });
  if (vocab.length) {
    lines.push('');
    lines.push('🔤 Words of the day:');
    for (const v of vocab) {
      lines.push(`· ${v.word} (${v.pos}) — ${v.meaning_zh}`);
      if (v.example) lines.push(`  "${v.example}"`);
    }
  }
  lines.push('');
  lines.push(`Read more → ${SITE_URL}`);
  return lines;
}

async function sendFeishu(webhook, digest) {
  const content = digestLinesText(digest).map((line) => {
    const urlMatch = line.trim().match(/^(https?:\/\/\S+)$/);
    if (urlMatch) return [{ tag: 'a', text: '阅读原文 ↗', href: urlMatch[1] }];
    return [{ tag: 'text', text: line }];
  });
  const payload = {
    msg_type: 'post',
    content: { post: { zh_cn: { title: '📖 ReadSphere 每日英文精读', content } } },
  };
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.code && body.code !== 0)) {
    throw new Error(`Feishu ${res.status}: ${JSON.stringify(body).slice(0, 150)}`);
  }
}

async function sendPushPlus(token, digest) {
  const html = digestLinesText(digest)
    .map((l) => {
      const urlMatch = l.trim().match(/^(https?:\/\/\S+)$/);
      if (urlMatch) return `<div><a href="${urlMatch[1]}">阅读原文 ↗</a></div>`;
      return `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`;
    })
    .join('');
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      title: '📖 ReadSphere 每日英文精读',
      content: html,
      template: 'html',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.code && body.code !== 200)) {
    throw new Error(`PushPlus ${res.status}: ${JSON.stringify(body).slice(0, 150)}`);
  }
}

async function main() {
  const feishu = process.env.FEISHU_WEBHOOK_URL;
  const pushplus = process.env.PUSHPLUS_TOKEN;
  if (!feishu && !pushplus && !process.env.DRY_RUN) {
    console.log('ℹ 未配置 FEISHU_WEBHOOK_URL / PUSHPLUS_TOKEN，跳过每日推送。');
    return;
  }

  const [articles, analysis, sources] = await Promise.all([
    loadJSON('articles.json', null),
    loadJSON('analysis.json', null),
    loadJSON('sources.json', null),
  ]);
  if (!articles?.articles?.length || !sources) {
    console.log('ℹ 无文章数据，跳过推送。');
    return;
  }

  const digest = buildDigest(articles, analysis, sources);

  if (process.env.DRY_RUN) {
    console.log(digestLinesText(digest).join('\n'));
    return;
  }

  const results = [];
  if (feishu) {
    try {
      await sendFeishu(feishu, digest);
      results.push('飞书 ✔');
    } catch (err) {
      results.push(`飞书 ✖ ${String(err.message || err).slice(0, 100)}`);
    }
  }
  if (pushplus) {
    try {
      await sendPushPlus(pushplus, digest);
      results.push('PushPlus ✔');
    } catch (err) {
      results.push(`PushPlus ✖ ${String(err.message || err).slice(0, 100)}`);
    }
  }
  console.log(`✔ 每日推送：${results.join('，')}`);
}

main().catch((err) => {
  // 推送失败不应让整条流水线失败
  console.warn('推送出错（不影响站点更新）:', String(err.message || err).slice(0, 150));
});
