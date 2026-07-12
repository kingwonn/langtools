/* ReadSphere —— 纯静态单页应用，无框架依赖。
 * 数据来自 ./data/*.json：
 *   sources.json  人工精选信息源（必需）
 *   articles.json RSS 抓取结果（流水线生成，可缺失）
 *   analysis.json LLM 文章分析（流水线生成，可缺失）
 *   wiki.json     LLM 知识库词条（流水线生成 + 种子词条，可缺失）
 */

const app = document.getElementById('app');

const state = {
  sources: null,
  articles: null,
  analysis: null,
  wiki: null,
  feedFilter: { category: 'all', difficulty: 'all', q: '' },
  sourceFilter: { q: '' },
  wikiFilter: { q: '' },
};

/* ---------- 工具 ---------- */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 外部链接只放行 http(s)，防止 RSS 数据里混入 javascript: 等危险协议
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? esc(u) : '#');

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const DIM_LABEL = {
  tech: '技术', industry: '行业', investing: '投资', debate: '争论',
};

const dots = (n) => {
  const lv = Math.min(3, Math.max(1, Number(n) || 1));
  return '●'.repeat(lv) + '○'.repeat(3 - lv);
};
const DIFF_LABEL = { 1: '入门友好', 2: '中级', 3: '进阶' };
const TYPE_LABEL = {
  blog: '博客', newsletter: '通讯', memo: '备忘录/信件', essay: '随笔', media: '媒体',
};

async function loadJSON(name) {
  try {
    const res = await fetch(`data/${name}?v=${Date.now() >> 16}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------- 主题 ---------- */
function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved || (prefers ? 'dark' : 'light');
  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
}

/* ---------- 路由 ---------- */
function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'feed';
  const [page, rawParam] = hash.split('/');
  let param = rawParam;
  try {
    if (rawParam) param = decodeURIComponent(rawParam);
  } catch { /* 非法编码时按原样处理 */ }
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === page);
  });
  window.scrollTo({ top: 0 });
  if (page === 'sources') return renderSources();
  if (page === 'wiki') return param ? renderWikiEntry(param) : renderWiki();
  if (page === 'guide') return renderGuide();
  return renderFeed();
}

/* ---------- 视图：最新文章 ---------- */
function renderFeed() {
  const { articles, analysis, sources } = state;
  const srcById = Object.fromEntries(sources.sources.map((s) => [s.id, s]));
  const f = state.feedFilter;

  let list = (articles?.articles || []).filter((a) => srcById[a.source]);
  if (f.category !== 'all') list = list.filter((a) => srcById[a.source].category === f.category);
  if (f.difficulty !== 'all')
    list = list.filter((a) => analysis?.analyses?.[a.id]?.difficulty === f.difficulty);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (srcById[a.source].name || '').toLowerCase().includes(q) ||
        (analysis?.analyses?.[a.id]?.summary_zh || '').includes(f.q),
    );
  }

  const catChips = [{ id: 'all', name_zh: '全部' }, ...sources.categories]
    .map(
      (c) =>
        `<button class="chip ${f.category === (c.id || 'all') ? 'active' : ''}" data-cat="${c.id || 'all'}">${c.icon || ''} ${esc(c.name_zh)}</button>`,
    )
    .join('');
  const diffChips = ['all', 'B1', 'B2', 'C1', 'C2']
    .map(
      (d) =>
        `<button class="chip ${f.difficulty === d ? 'active' : ''}" data-diff="${d}">${d === 'all' ? '全部难度' : d}</button>`,
    )
    .join('');

  const cards = list.slice(0, 120).map((a) => articleCard(a, srcById[a.source], analysis?.analyses?.[a.id])).join('');

  const updated = articles?.updated ? `内容更新于 ${fmtDate(articles.updated)}` : '';
  const analyzedCount = analysis ? Object.keys(analysis.analyses || {}).length : 0;

  app.innerHTML = `
    <div class="page-head">
      <h1>最新文章</h1>
      <p class="sub">来自 ${sources.sources.length} 个精选英文信息源的最新内容。带有难度标记的文章已由 Claude 分析——展开可看中文导读、核心词汇与关联概念。</p>
      ${updated ? `<p class="meta-line">${updated} · 已分析 ${analyzedCount} 篇</p>` : ''}
    </div>
    <div class="filter-bar">
      ${catChips}<span class="filter-sep"></span>${diffChips}
      <input class="search-box" id="feedSearch" placeholder="搜索标题 / 来源…" value="${esc(f.q)}">
    </div>
    ${
      list.length
        ? `<div class="article-list">${cards}</div>`
        : `<div class="empty">暂无文章。<div class="hint">运行 <code>npm run fetch</code>（或等 GitHub Actions 每日任务）抓取 RSS 后这里会展示最新文章。</div></div>`
    }
  `;

  app.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => { f.category = b.dataset.cat; renderFeed(); }));
  app.querySelectorAll('[data-diff]').forEach((b) =>
    b.addEventListener('click', () => { f.difficulty = b.dataset.diff; renderFeed(); }));
  bindSearch('#feedSearch', (v) => { f.q = v; renderFeed(); });
  bindArticleCards();
}

function articleCard(a, src, an) {
  const summary = an
    ? `<p class="article-summary lookup">${esc(an.summary_zh)}</p>`
    : a.snippet
      ? `<p class="article-snippet lookup">${esc(a.snippet.slice(0, 180))}…</p>`
      : '';
  const detail = an ? articleDetail(a, an) : '';
  return `
    <article class="article-card">
      <div class="article-top">
        <span class="source-pill">${esc(src.name)}</span>
        ${an ? `<span class="diff-badge diff-${an.difficulty}">${an.difficulty}</span>` : ''}
        ${an?.read_minutes ? `<span>约 ${an.read_minutes} 分钟</span>` : ''}
        <span>${fmtDate(a.date)}</span>
      </div>
      <h3 class="article-title lookup"><a href="${safeUrl(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      ${summary}
      ${an ? `<button class="article-expand" data-toggle>展开导读 ▾</button><div class="article-detail" hidden>${detail}</div>` : ''}
    </article>`;
}

function articleDetail(a, an) {
  const kp = (an.key_points_zh || [])
    .map((p) => `<li>${esc(p)}</li>`).join('');
  const vocab = (an.vocabulary || [])
    .map(
      (v) => `
      <div class="vocab-item" data-vocab>
        <b class="lookup">${esc(v.word)}</b><span class="pos">${esc(v.pos)}</span><span class="zh">${esc(v.meaning_zh)}</span>
        <div class="vocab-example lookup">“${esc(v.example)}”</div>
      </div>`,
    ).join('');
  const concepts = (an.concepts || [])
    .map((c) => {
      const entry = state.wiki?.entries?.[c];
      return entry
        ? `<a class="concept-link" href="#/wiki/${esc(c)}">🧠 ${esc(entry.title_zh)} ${esc(entry.title_en)}</a>`
        : `<span class="concept-link ghost">🌱 ${esc(c)}（词条生成中）</span>`;
    }).join('');
  return `
    ${an.summary_en ? `<div class="detail-block"><h4>English summary</h4><p class="article-summary lookup">${esc(an.summary_en)}</p></div>` : ''}
    ${kp ? `<div class="detail-block"><h4>要点</h4><ul class="key-points">${kp}</ul></div>` : ''}
    ${vocab ? `<div class="detail-block"><h4>核心词汇（点击看原文例句）</h4><div class="vocab-list">${vocab}</div></div>` : ''}
    ${concepts ? `<div class="detail-block"><h4>关联概念</h4><div class="concept-links">${concepts}</div></div>` : ''}
  `;
}

// 输入即重渲染的搜索框：重建 DOM 后恢复焦点与光标位置
function bindSearch(selector, onInput) {
  const search = app.querySelector(selector);
  if (!search) return;
  search.addEventListener('input', () => {
    state.lastSearch = selector;
    onInput(search.value);
  });
  if (state.lastSearch === selector) {
    const len = search.value.length;
    search.focus();
    search.setSelectionRange(len, len);
  }
}

function bindArticleCards() {
  app.querySelectorAll('[data-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const detail = btn.nextElementSibling;
      const open = !detail.hidden;
      detail.hidden = open;
      btn.textContent = open ? '展开导读 ▾' : '收起 ▴';
    }));
  app.querySelectorAll('[data-vocab]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (window.getSelection()?.toString()) return; // 不干扰选词查词
      el.classList.toggle('open');
    }));
}

/* ---------- 视图：信息源 ---------- */
function renderSources() {
  const { sources } = state;
  const q = state.sourceFilter.q.toLowerCase();
  const match = (s) =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    (s.author || '').toLowerCase().includes(q) ||
    (s.description_zh || '').includes(state.sourceFilter.q) ||
    (s.tags || []).some((t) => t.toLowerCase().includes(q));

  const sections = sources.categories
    .map((cat) => {
      const items = sources.sources.filter((s) => s.category === cat.id && match(s));
      if (!items.length) return '';
      return `
      <section class="category-section">
        <h2 class="category-title">${cat.icon || ''} ${esc(cat.name_zh)} <span style="font-size:14px;color:var(--ink-faint);font-family:var(--sans);font-weight:400">${esc(cat.name_en)}</span></h2>
        <p class="category-desc">${esc(cat.desc_zh || '')}</p>
        <div class="source-grid">${items.map(sourceCard).join('')}</div>
      </section>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head">
      <h1>信息源</h1>
      <p class="sub">${sources.sources.length} 个人工精选的英文博客与信息源。选择标准：作者是领域一线的实践者、写作质量本身值得学习、长期更新。</p>
    </div>
    <div class="filter-bar">
      <input class="search-box" id="srcSearch" style="margin-left:0;min-width:260px" placeholder="搜索名称 / 作者 / 标签…" value="${esc(state.sourceFilter.q)}">
    </div>
    ${sections || '<div class="empty">没有匹配的信息源。</div>'}
  `;
  bindSearch('#srcSearch', (v) => { state.sourceFilter.q = v; renderSources(); });
}

function sourceCard(s) {
  return `
  <div class="source-card">
    <div class="source-head">
      <h3 class="source-name"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a></h3>
      ${s.author ? `<span class="source-author">${esc(s.author)}</span>` : ''}
    </div>
    <div class="source-meta">
      <span class="type-badge">${TYPE_LABEL[s.type] || esc(s.type || '')}</span>
      <span class="dots" title="难度：${DIFF_LABEL[s.difficulty]}">${dots(s.difficulty)}</span>
      <span>${DIFF_LABEL[s.difficulty] || ''}</span>
      ${s.cadence_zh ? `<span>· ${esc(s.cadence_zh)}</span>` : ''}
    </div>
    <p class="source-desc lookup">${esc(s.description_zh)}</p>
    ${s.why_zh ? `<p class="source-why"><b>为什么读：</b>${esc(s.why_zh)}</p>` : ''}
    ${s.tags?.length ? `<div class="source-tags">${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="source-links">
      <a href="${esc(s.url)}" target="_blank" rel="noopener">官网 ↗</a>
      ${s.feed ? `<a href="${esc(s.feed)}" target="_blank" rel="noopener">RSS</a>` : '<span style="color:var(--ink-faint)">无 RSS</span>'}
    </div>
  </div>`;
}

/* ---------- 视图：知识库 ---------- */
function renderWiki() {
  const entries = Object.values(state.wiki?.entries || {});
  const q = state.wikiFilter.q.toLowerCase();
  const catName = Object.fromEntries(state.sources.categories.map((c) => [c.id, `${c.icon || ''} ${c.name_zh}`]));
  catName.general = '🧭 通识';

  const filtered = entries.filter(
    (e) =>
      !q ||
      e.title_en.toLowerCase().includes(q) ||
      e.title_zh.includes(state.wikiFilter.q) ||
      (e.one_liner_zh || '').includes(state.wikiFilter.q),
  );

  const byCat = {};
  for (const e of filtered) (byCat[e.category || 'general'] ||= []).push(e);

  const sections = Object.entries(byCat)
    .map(
      ([cat, items]) => `
      <section class="category-section">
        <h2 class="category-title">${catName[cat] || esc(cat)}</h2>
        <div class="wiki-grid">
          ${items
            .sort((a, b) => a.title_en.localeCompare(b.title_en))
            .map(
              (e) => `
            <a class="wiki-card" href="#/wiki/${esc(e.slug)}">
              <h3>${esc(e.title_en)}</h3>
              <span class="zh-title">${esc(e.title_zh)}</span>
              <p>${esc(e.one_liner_zh || '')}</p>
              ${e.articles?.length ? `<div class="wiki-refs">📎 ${e.articles.length} 篇相关文章</div>` : ''}
            </a>`,
            )
            .join('')}
        </div>
      </section>`,
    )
    .join('');

  app.innerHTML = `
    <div class="page-head">
      <h1>知识库 <span style="font-size:16px;color:var(--ink-faint);font-family:var(--sans);font-weight:400">LLM Wiki</span></h1>
      <p class="sub">由 Claude 从每日文章中自动沉淀的双语概念词典：每个词条包含英文定义（本身就是阅读材料）、中文详解、常见误解与相关术语，并随新文章持续生长。</p>
      ${state.wiki?.updated ? `<p class="meta-line">共 ${entries.length} 个词条 · 更新于 ${fmtDate(state.wiki.updated)}</p>` : ''}
    </div>
    <div class="filter-bar">
      <input class="search-box" id="wikiSearch" style="margin-left:0;min-width:260px" placeholder="搜索概念…" value="${esc(state.wikiFilter.q)}">
    </div>
    ${
      filtered.length
        ? sections
        : `<div class="empty">词条还在生长中。<div class="hint">配置 <code>ANTHROPIC_API_KEY</code> 后，流水线会从每天的新文章中提取概念并自动撰写词条。</div></div>`
    }
  `;
  bindSearch('#wikiSearch', (v) => { state.wikiFilter.q = v; renderWiki(); });
}

function renderWikiEntry(slug) {
  const e = state.wiki?.entries?.[slug];
  if (!e) {
    app.innerHTML = `<a class="back-link" href="#/wiki">← 返回知识库</a><div class="empty">词条 “${esc(slug)}” 不存在或还没生成。</div>`;
    return;
  }
  const kp = (e.key_points || [])
    .map((p) => `<tr><td class="en lookup">${esc(p.en)}</td><td class="zh">${esc(p.zh)}</td></tr>`)
    .join('');
  const terms = (e.terms || [])
    .map((t) => `<div class="vocab-item"><b class="lookup">${esc(t.en)}</b> <span class="zh">${esc(t.zh)}</span></div>`)
    .join('');
  const related = (e.related || [])
    .filter((r) => state.wiki.entries[r])
    .map((r) => `<a class="concept-link" href="#/wiki/${esc(r)}">${esc(state.wiki.entries[r].title_zh)} ${esc(state.wiki.entries[r].title_en)}</a>`)
    .join('');
  const refs = (e.articles || [])
    .map(
      (a) => `<li><a href="${safeUrl(a.link)}" target="_blank" rel="noopener" class="lookup">${esc(a.title)}</a><span class="src">${esc(a.source || '')} · ${fmtDate(a.date)}</span></li>`,
    )
    .join('');
  const misc = (e.misconceptions_zh || []).map((m) => `<p class="misconception">⚠️ ${esc(m)}</p>`).join('');
  const devs = (e.developments_zh || [])
    .map(
      (d) => `<li class="dev-item"><span class="dev-period">${esc(d.period)}</span>${esc(d.point_zh)}</li>`,
    )
    .join('');
  const memory = (e.memory || [])
    .map(
      (m) => `
      <li class="memory-item">
        <span class="dim-badge dim-${esc(m.dimension)}">${DIM_LABEL[m.dimension] || esc(m.dimension)}</span>
        <div class="memory-body">
          <div class="memory-claim">${esc(m.claim_zh)}</div>
          <div class="memory-src"><a href="${safeUrl(m.link)}" target="_blank" rel="noopener">${esc(m.title)}</a> · ${esc(m.source || '')} · ${fmtDate(m.date)}</div>
        </div>
      </li>`,
    )
    .join('');

  app.innerHTML = `
    <div class="wiki-entry">
      <a class="back-link" href="#/wiki">← 返回知识库</a>
      <h1 class="lookup">${esc(e.title_en)}</h1>
      <div class="zh-heading">${esc(e.title_zh)}</div>
      <p class="wiki-oneliner">${esc(e.one_liner_zh || '')}</p>

      <div class="wiki-section">
        <h2>Definition · 定义</h2>
        <p class="def-en lookup">${esc(e.definition_en)}</p>
        <p class="def-zh">${esc(e.definition_zh)}</p>
      </div>

      ${e.why_matters_zh ? `<div class="wiki-section"><h2>Why it matters · 为什么重要</h2><p class="def-zh">${esc(e.why_matters_zh)}</p></div>` : ''}
      ${kp ? `<div class="wiki-section"><h2>Key points · 核心要点</h2><table class="kp-table">${kp}</table></div>` : ''}
      ${devs ? `<div class="wiki-section"><h2>Developments · 最新动态与争论 <span class="synth-note">🧠 由记忆巩固生成</span></h2><ul class="dev-list">${devs}</ul></div>` : ''}
      ${misc ? `<div class="wiki-section"><h2>Common misconceptions · 常见误解</h2>${misc}</div>` : ''}
      ${terms ? `<div class="wiki-section"><h2>Terms · 高频术语</h2><div class="term-list">${terms}</div></div>` : ''}
      ${memory ? `<div class="wiki-section"><h2>Memory · 观点记忆</h2><p class="memory-intro">从每日文章中提取的关于此概念的论断，按时间倒序——这是词条持续进化的原材料。</p><ul class="memory-list">${memory}</ul></div>` : ''}
      ${related ? `<div class="wiki-section"><h2>Related · 相关概念</h2><div class="concept-links">${related}</div></div>` : ''}
      ${refs ? `<div class="wiki-section"><h2>Coverage · 相关文章</h2><ul class="ref-list">${refs}</ul></div>` : ''}
      <p class="meta-line">${e.origin === 'curated' ? '✍️ 人工撰写的种子词条' : '🤖 由 Claude 生成'} · 更新于 ${fmtDate(e.updated_at)}</p>
    </div>
  `;
}

/* ---------- 视图：学习方法 ---------- */
function renderGuide() {
  app.innerHTML = `
  <div class="guide">
    <div class="page-head">
      <h1>学习方法</h1>
      <p class="sub">这个站不只是资讯聚合——它是一套「用一手英文内容学英语」的工作流。</p>
    </div>

    <h2>🎯 为什么读博客，而不是教材</h2>
    <p>教材英语是无菌的，而博客是<strong>活的英语</strong>：Simon Willison 怎么描述一个 bug、Howard Marks 怎么表达不确定性、Rodney Brooks 怎么反驳炒作——这些真实语境里的表达方式，才是词汇和语感的最好来源。同时你顺便获得了这三个领域的一手认知，一份时间两份收益。</p>

    <h2>📐 三层阅读法</h2>
    <ul>
      <li><strong>第一层 · 扫（每天 5 分钟）：</strong>刷「最新文章」页的标题和中文摘要，知道领域里发生了什么。不点开，不焦虑。</li>
      <li><strong>第二层 · 选读（每天 15–20 分钟）：</strong>挑 1–2 篇感兴趣的，展开导读看要点和核心词汇，再决定要不要读原文。读原文时遇到生词先猜，再双击查词验证。</li>
      <li><strong>第三层 · 精读（每周 1–2 篇）：</strong>选一篇难度略高于舒适区的文章（比当前水平高一档，如 B2 → C1），逐段读完。把导读里的核心词汇连同原文例句抄进 Anki 或生词本，隔天复习。</li>
    </ul>
    <div class="tip-box">💡 难度标记基于 CEFR：B1 大约是四级水平，B2 是六级，C1 是雅思 7 分左右的阅读难度。选文章时「i+1」——比你的水平难一点点，才有最大的学习增益。</div>

    <h2>🪜 难度阶梯（按此顺序建立信心）</h2>
    <div class="ladder">
      <div class="ladder-step"><span class="lv">第 1 级</span><b>Seth Godin · Derek Sivers · James Clear</b> —— 短句、日常词汇、每篇 1–3 分钟。适合建立每天读英文的习惯。</div>
      <div class="ladder-step"><span class="lv">第 2 级</span><b>Paul Graham · Morgan Housel · One Useful Thing</b> —— 篇幅变长但语言极其清晰，是学「用简单英语表达深刻思想」的典范。</div>
      <div class="ladder-step"><span class="lv">第 3 级</span><b>Simon Willison · Howard Marks · The Robot Report</b> —— 行业术语增多，开始积累 AI 与投资的专业词汇。</div>
      <div class="ladder-step"><span class="lv">第 4 级</span><b>Stratechery · Lilian Weng · Aeon · 财报股东信</b> —— 长文、复杂论证、抽象概念。读顺这一级，英文阅读就不再是障碍。</div>
    </div>

    <h2>🧰 配套工具建议</h2>
    <ul>
      <li><strong>本站查词：</strong>任何英文段落里双击单词，直接弹出释义（并附有道跳转）。</li>
      <li><strong>Anki / Eudic 欧路：</strong>把「核心词汇」连同原文例句做成卡片。<em>带语境的卡片记忆效率远高于孤立单词。</em></li>
      <li><strong>沉浸式翻译（浏览器插件）：</strong>读原文吃力时开双语对照——但尽量只在第三、四级文章上用，别让它变成拐杖。</li>
      <li><strong>知识库页：</strong>遇到不懂的概念（World Models、DCF……）先看本站词条，英文定义本身就是精心控制难度的阅读材料。</li>
    </ul>

    <h2>📈 一个可持续的节奏</h2>
    <p>不要制定「每天精读一篇」这种坚持不了三天的计划。可持续的最小配置是：<strong>每天扫一遍标题（5 分钟）+ 每周精读两篇 + 每周复习一次生词卡</strong>。三个月后回头看第 1 级的文章，你会惊讶于自己的进步。</p>
  </div>`;
}

/* ---------- 查词 ---------- */
function initDictionary() {
  const popup = document.getElementById('dictPopup');
  let lookupSeq = 0; // 连续双击时只保留最后一次查询的结果

  document.addEventListener('dblclick', async (e) => {
    if (popup.contains(e.target)) return;
    const sel = window.getSelection();
    const word = sel?.toString().trim();
    if (!word || !/^[a-zA-Z][a-zA-Z'-]{1,30}$/.test(word)) return;
    if (!e.target.closest('.lookup')) return;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    showDictPopup(word, rect);
  });

  document.addEventListener('click', (e) => {
    if (!popup.hidden && !popup.contains(e.target)) popup.hidden = true;
  });

  async function showDictPopup(word, rect) {
    const seq = ++lookupSeq;
    popup.innerHTML = `<h5>${esc(word)}</h5><div class="sense">查询中…</div>`;
    popup.hidden = false;
    positionPopup(rect);

    let body = '';
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
      if (res.ok) {
        const data = await res.json();
        const entry = Array.isArray(data) ? data[0] : null;
        if (entry) {
          const phonetic = entry.phonetic || entry.phonetics?.find((p) => p.text)?.text || '';
          const senses = entry.meanings
            ?.slice(0, 3)
            .map((m) => {
              const def = m.definitions?.[0];
              return `<div class="sense"><span class="pos">${esc(m.partOfSpeech)}</span>${esc(def?.definition || '')}</div>`;
            })
            .join('');
          body = `<h5>${esc(entry.word)} <span class="phonetic">${esc(phonetic)}</span></h5>${senses || ''}`;
        }
      }
    } catch { /* 网络失败时走下方 fallback */ }
    if (seq !== lookupSeq) return; // 已有更新的查询，丢弃本次结果

    if (!body) body = `<h5>${esc(word)}</h5><div class="sense">未找到英文释义，试试下方词典链接。</div>`;

    popup.innerHTML = `
      <button class="close-btn" aria-label="关闭">✕</button>
      ${body}
      <div class="dict-links">
        <a href="https://dict.youdao.com/result?word=${encodeURIComponent(word)}&lang=en" target="_blank" rel="noopener">有道词典 ↗</a>
        <a href="https://www.ldoceonline.com/dictionary/${encodeURIComponent(word.toLowerCase())}" target="_blank" rel="noopener">朗文 ↗</a>
      </div>`;
    popup.querySelector('.close-btn').addEventListener('click', () => (popup.hidden = true));
    positionPopup(rect);
  }

  function positionPopup(rect) {
    const top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX;
    popup.style.top = `${top}px`;
    popup.style.left = '0px';
    const width = popup.offsetWidth || 300;
    left = Math.min(left, document.documentElement.clientWidth - width - 12);
    popup.style.left = `${Math.max(8, left)}px`;
  }
}

/* ---------- 启动 ---------- */
async function main() {
  initTheme();
  initDictionary();

  const [sources, articles, analysis, wiki] = await Promise.all([
    loadJSON('sources.json'),
    loadJSON('articles.json'),
    loadJSON('analysis.json'),
    loadJSON('wiki.json'),
  ]);

  if (!sources) {
    app.innerHTML = '<div class="empty">加载失败：缺少 data/sources.json。<div class="hint">请通过本地服务器访问（如 <code>npm run dev</code>），直接双击打开 HTML 文件无法读取数据。</div></div>';
    return;
  }
  Object.assign(state, { sources, articles, analysis, wiki });

  window.addEventListener('hashchange', route);
  route();
}

main().catch((err) => {
  console.error(err);
  app.innerHTML = `<div class="empty">页面出错了：${esc(err.message || err)}<div class="hint">刷新重试；若持续出现请检查 data/*.json 是否有效。</div></div>`;
});
