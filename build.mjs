// 智能晨报构建脚本：抓取 AI 资讯源，生成当期报纸（index.html）、往期存档与总目录
// 用法：node build.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = join(ROOT, 'site');
const MAX_PER_FEED = 40;
const EXCERPT_LEN = 260;
const WINDOW_HOURS = 36;   // 当期收录最近多久的内容
const MIN_ITEMS = 8;       // 当期最少条数，不足则回退到最近文章
const SECTIONS = ['要闻', '研究前沿', '产品与发布', '开源与社区', '行业与资本', '社区热议', '观点与随笔'];

// 资本类关键词条目自动归入「行业与资本」
const FUNDING_RE =
  /(raise[sd]?\s|funding|series [a-z]\b|\bipo\b|acquir|\bvaluation\b|merger|\$\d[\d.,]*\s*(billion|million|bn|mm?)?\b|\d(\.\d+)?\s*(billion|million)\b|融资|收购|上市|估值|亿美元|万美元|千万美元)/i;

const tKey = (s) => createHash('md5').update(s).digest('hex').slice(0, 12);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '__cdata',
});

const AI_RE =
  /\b(ai|a\.i\.|artificial intelligence|llm|llms|gpt|gpt-?[45o]|chatgpt|openai|anthropic|claude|gemini|deepseek|qwen|通义|kimi|grok|copilot|mistral|llama|agent|agents|rag|diffusion|stable diffusion|midjourney|sora|transformer| AGI\b|机器学习|人工智能|大模型|大语言模型|深度学习|神经网络|智能体|多模态|文生图|文生视频|具身智能)\b/i;

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v)) return text(v[0]);
    if (v.__cdata != null) return text(v.__cdata);
    if (v['#text'] != null) return text(v['#text']);
    return '';
  }
  return String(v);
};

const stripHtml = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, ' ')
    .trim();

const pickLink = (item) => {
  if (typeof item.link === 'string') return item.link.trim();
  if (Array.isArray(item.link)) {
    const alt = item.link.find((l) => l && l['@_rel'] !== 'enclosure');
    return (alt?.['@_href'] || item.link[0]?.['@_href'] || '').trim();
  }
  if (item.link?.['@_href']) return item.link['@_href'].trim();
  if (item.guid) return text(item.guid).trim();
  return '';
};

const pickDate = (item) => {
  const raw = item.pubDate ?? item.published ?? item.updated ?? item['dc:date'] ?? item.date;
  const s = text(raw);
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const pickContent = (item) =>
  text(item['content:encoded']) ||
  text(item.content) ||
  text(item.description) ||
  text(item.summary) ||
  '';

function parseFeed(xmlStr, fallbackName) {
  const doc = parser.parse(xmlStr);
  let items = [];
  let title = fallbackName;
  const rss = doc.rss?.channel;
  const atom = doc.feed;
  const rdf = doc['rdf:RDF'];
  if (rss?.item) {
    items = Array.isArray(rss.item) ? rss.item : [rss.item];
    title = text(rss.title) || title;
  } else if (atom?.entry) {
    items = Array.isArray(atom.entry) ? atom.entry : [atom.entry];
    title = text(atom.title) || title;
  } else if (rdf?.item) {
    items = Array.isArray(rdf.item) ? rdf.item : [rdf.item];
    title = text(rdf.channel?.title) || title;
  } else {
    throw new Error('无法识别的 feed 结构');
  }
  return { title, items };
}

async function fetchGitHub(feed) {
  const since = new Date(Date.now() - (feed.days || 7) * 86400000).toISOString().slice(0, 10);
  const q = `${feed.query || 'ai'} created:>${since} stars:>20`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${feed.limit || 8}`,
      {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'ai-morning-post-builder',
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const articles = (data.items || []).map((r) => ({
      title: r.full_name,
      link: r.html_url,
      source: feed.name,
      category: feed.category || '开源与社区',
      lang: feed.lang,
      date: r.created_at,
      excerpt: `${r.description || '（无描述）'}（★ ${r.stargazers_count}）`,
      force: feed.force,
    }));
    return { ok: true, articles };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let xmlStr = buf.toString('utf8');
    const decl = xmlStr.slice(0, 200).match(/encoding=["']([^"']+)["']/i);
    if (decl && /gb2312|gbk/i.test(decl[1])) {
      try {
        xmlStr = new TextDecoder('gbk').decode(buf);
      } catch {
        /* 保持 utf8 */
      }
    }
    const { items } = parseFeed(xmlStr, feed.name);
    const articles = items
      .map((item) => {
        const link = pickLink(item);
        const t = text(item.title).trim();
        if (!link || !t) return null;
        let excerpt = stripHtml(pickContent(item)).slice(0, EXCERPT_LEN);
        if (/^article url:/i.test(excerpt)) excerpt = '';
        return {
          title: t.replace(/\s+/g, ' '),
          link,
          source: feed.name,
          category: feed.category || '要闻',
          lang: feed.lang,
          force: feed.force,
          date: pickDate(item),
          excerpt,
        };
      })
      .filter(Boolean)
      .filter((a) => !feed.aiOnly || AI_RE.test(a.title + ' ' + a.excerpt));
    return { ok: true, articles };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 抓取 ----------
const config = JSON.parse(readFileSync(join(ROOT, 'feeds.json'), 'utf8'));
const results = await Promise.allSettled(
  config.feeds.map((f) => (f.type === 'github' ? fetchGitHub(f) : fetchFeed(f)))
);

const all = [];
const failed = [];
results.forEach((r, i) => {
  const name = config.feeds[i].name;
  if (r.status === 'fulfilled' && r.value.ok) {
    all.push(...r.value.articles.slice(0, MAX_PER_FEED));
  } else {
    failed.push(`${name}: ${r.reason?.message || String(r.reason)}`);
  }
});

// 去重（同标题）
const seenTitles = new Set();
const deduped = all.filter((a) => {
  const k = a.title.replace(/\s+/g, '').toLowerCase();
  if (seenTitles.has(k)) return false;
  seenTitles.add(k);
  return true;
});

deduped.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

// ---------- 选当期文章 ----------
const now = Date.now();
// 资本类关键词条目跨源重新归类（仓库条目除外）
for (const a of deduped) {
  if (!a.force && FUNDING_RE.test(a.title)) a.category = '行业与资本';
}
const inWindow = deduped.filter(
  (a) =>
    a.force ||
    (a.date && now - Date.parse(a.date) <= WINDOW_HOURS * 3600 * 1000)
);
const pool = inWindow.length >= MIN_ITEMS ? inWindow : deduped;

// 头条：按版面权重 + 新近度挑选（仓库条目不作头条）
const weight = Object.fromEntries(SECTIONS.map((s, i) => [s, SECTIONS.length - i]));
const headline = [...pool]
  .filter((a) => !a.force)
  .sort(
    (a, b) =>
      (weight[b.category] || 0) * 100 + (Date.parse(b.date) || 0) / 1e12 -
      ((weight[a.category] || 0) * 100 + (Date.parse(a.date) || 0) / 1e12)
  )[0];

// 各版块单独限额，避免一个源把其他版块挤掉
const PER_SECTION = 6;
const sections = SECTIONS.map((name) => ({
  name,
  items: pool
    .filter((a) => a.category === name && a !== headline)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, PER_SECTION),
})).filter((s) => s.items.length);

const today = [headline, ...sections.flatMap((s) => s.items)];

if (!today.length) {
  console.error('没有任何可用文章，终止（不覆盖已有版面）');
  process.exit(1);
}

// 本期数字（报纸的「By the numbers」栏）
const ghAll = pool.filter((a) => a.source === 'GitHub');
const maxStars = ghAll.reduce((m, a) => {
  const s = (a.excerpt.match(/★\s*([\d,]+)/) || [])[1];
  return s ? Math.max(m, +s.replace(/,/g, '')) : m;
}, 0);
const stats = [
  { v: today.length, label: '条资讯' },
  { v: today.filter((a) => a.category === '研究前沿').length, label: '篇论文' },
  { v: ghAll.length, label: '个开源新仓库' },
  ...(maxStars ? [{ v: '★' + maxStars, label: '最热仓库' }] : []),
  { v: new Set(today.map((a) => a.source)).size, label: '家来源' },
];

// ---------- 翻译：英文条目若有译文则替换，否则进入翻译队列 ----------
const translationsPath = join(ROOT, 'translations.json');
const translations = existsSync(translationsPath)
  ? JSON.parse(readFileSync(translationsPath, 'utf8'))
  : {};
const needT = [];
for (const a of today) {
  if (a.lang !== 'en') continue;
  const k = tKey(a.title);
  a.tkey = k;
  const t = translations[k];
  if (t?.title) a.title = t.title;
  if (t?.excerpt) a.excerpt = t.excerpt;
  if (!t?.title) needT.push({ key: k, title: a.title, excerpt: a.excerpt, source: a.source });
}
writeFileSync(join(ROOT, 'translate-queue.json'), JSON.stringify(needT, null, 2));

// ---------- 期数与存档 ----------
mkdirSync(join(SITE, 'issues'), { recursive: true });
const manifestPath = join(SITE, 'issues.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : [];

const launch = new Date(config.launchDate + 'T00:00:00+08:00');
const dateK = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
const existing = manifest.find((m) => m.date === dateK);
// 期数规则：创刊日为第 1 期，每天顺延一天；缺刊则跳号
const dayDiff = Math.floor((new Date(dateK + 'T00:00:00+08:00') - launch) / 86400000) + 1;
const finalNo = existing ? existing.no : dayDiff;

const entry = { date: dateK, no: finalNo, headline: headline.title };const manifestSaved = existing
  ? manifest.map((m) => (m.date === dateK ? entry : m))
  : [...manifest, entry].sort((a, b) => a.date.localeCompare(b.date));

// ---------- 模板 ----------
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const fmtCN = (isoOrK) => {
  const d = isoOrK.includes('T') ? new Date(isoOrK) : new Date(isoOrK + 'T12:00:00+08:00');
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${'日一二三四五六'[d.getDay()]}`;
};
const hm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const CSS = `
  :root {
    --paper: #f5f0e6; --paper-deep: #ede6d6; --ink: #26221b; --ink-soft: #5c5548;
    --ink-faint: #9a917f; --seal: #a5382a; --rule: #c9bfa9; --rule-dark: #26221b;
    --serif: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif;
    --latin: "EB Garamond", Georgia, serif;
    --mast: "Ma Shan Zheng", "Noto Serif SC", serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--paper); color: var(--ink); font-family: var(--serif); line-height: 1.75; }
  body::before { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .5;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.5 0 0 0 0 0.42 0 0 0 0.05 0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)'/%3E%3C/svg%3E"); }
  .sheet { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 44px 30px 80px; }
  a { color: inherit; }

  .masthead { text-align: center; }
  .kicker { font-family: var(--latin); font-size: 12px; letter-spacing: .42em; text-transform: uppercase; color: var(--ink-faint); }
  h1.mast { font-family: var(--latin); font-weight: 600; font-size: clamp(56px, 10vw, 88px); letter-spacing: .02em; line-height: 1.1; margin: 4px 0 0; }
  h1.mast .dot { color: var(--seal); }
  .motto { margin-top: 8px; font-size: 13.5px; color: var(--ink-soft); letter-spacing: .1em; }
  .dateline { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 16px; font-size: 13px; color: var(--ink-soft); }
  .dateline::before, .dateline::after { content: ""; flex: 1; max-width: 170px; height: 1px; background: var(--rule); }
  .dateline .no { color: var(--seal); font-family: var(--latin); letter-spacing: .08em; }
  .double-rule { margin-top: 20px; border-top: 3px solid var(--rule-dark); border-bottom: 1px solid var(--rule-dark); height: 7px; }

  /* 头条 */
  .headline { padding: 30px 0 26px; border-bottom: 3px solid var(--rule-dark); }
  .headline .label { display: inline-block; background: var(--seal); color: var(--paper); font-size: 13px; letter-spacing: .35em; padding: 2px 12px 2px 15px; margin-bottom: 14px; }
  .headline h2 { font-size: clamp(30px, 5.4vw, 44px); font-weight: 900; line-height: 1.4; }
  .headline h2 a { text-decoration: none; }
  .headline h2 a:hover { color: var(--seal); }
  .headline .meta { margin: 12px 0 10px; font-size: 13px; color: var(--ink-faint); }
  .headline .meta b { color: var(--seal); font-weight: 600; }
  .headline .lede { font-size: 16.5px; text-align: justify; color: var(--ink-soft); }
  .headline .lede::first-letter { font-size: 2.4em; font-weight: 900; float: left; line-height: 1.1; padding: 2px 8px 0 0; color: var(--ink); }
  .headline .goto { display: inline-block; margin-top: 12px; font-size: 13px; color: var(--seal); letter-spacing: .12em; text-decoration: none; }
  .headline .goto:hover { text-decoration: underline; text-underline-offset: 4px; }

  /* 版块 */
  .section { margin-top: 34px; }
  .section > header { display: flex; align-items: baseline; gap: 16px; }
  .section > header h3 { font-size: 21px; font-weight: 600; letter-spacing: .3em; }
  .section > header .en { font-family: var(--latin); font-size: 12px; letter-spacing: .2em; text-transform: uppercase; color: var(--ink-faint); }
  .section > header .rule { flex: 1; height: 3px; background: var(--rule-dark); }
  .briefs { margin-top: 14px; columns: 2; column-gap: 32px; column-rule: 1px solid var(--rule); }
  .brief { break-inside: avoid; padding: 14px 0; border-bottom: 1px solid var(--rule); }
  .brief h4 { font-size: 17px; font-weight: 600; line-height: 1.55; }
  .brief h4 a { text-decoration: none; }
  .brief h4 a:hover { color: var(--seal); }
  .brief p { margin-top: 6px; font-size: 14px; color: var(--ink-soft); text-align: justify; }
  .brief .meta { font-size: 12.5px; color: var(--ink-faint); }
  .brief .meta b { color: var(--seal); font-weight: 600; }
  .brief .meta a { color: inherit; }

  /* 往期 */
  .archive { margin-top: 46px; border-top: 3px solid var(--rule-dark); padding-top: 16px; }
  .archive h3 { font-size: 15px; letter-spacing: .3em; color: var(--ink-soft); }
  .archive ul { list-style: none; margin-top: 10px; columns: 2; column-gap: 32px; }
  .archive li { font-size: 13.5px; padding: 3px 0; break-inside: avoid; }
  .archive a { color: var(--ink-soft); text-decoration: none; }
  .archive a:hover { color: var(--seal); }
  .archive .all { display: inline-block; margin-top: 10px; font-size: 13px; color: var(--seal); text-decoration: none; letter-spacing: .1em; }
  .archive .all:hover { text-decoration: underline; text-underline-offset: 4px; }

  .colophon { margin-top: 46px; border-top: 3px solid var(--rule-dark); padding-top: 16px; font-size: 12.5px; color: var(--ink-faint); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .colophon .seal-mark { font-family: var(--latin); font-size: 18px; font-weight: 600; color: var(--seal); letter-spacing: .04em; }

  /* 本期数字 */
  .stats { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--rule); padding: 16px 0 14px; }
  .stat { flex: 1; min-width: 96px; text-align: center; border-left: 1px solid var(--rule); padding: 0 6px; }
  .stat:first-child { border-left: none; }
  .stat b { display: block; font-family: var(--latin); font-size: 27px; font-weight: 600; color: var(--seal); line-height: 1.2; }
  .stat span { font-size: 12px; color: var(--ink-faint); letter-spacing: .12em; }

  @media (max-width: 640px) {
    .sheet { padding: 30px 18px 60px; }
    .briefs, .archive ul { columns: 1; }
    .headline .lede::first-letter { font-size: 2em; }
  }
`;

function page(titleSuffix, inner) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titleSuffix}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;900&family=EB+Garamond&family=Ma+Shan+Zheng&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<main class="sheet">
${inner}
</main>
</body>
</html>
`;
}

function briefHTML(a) {
  return `<article class="brief">
    <div class="meta"><b>【${esc(a.source)}】</b>${a.date ? hm(a.date) : ''}</div>
    <h4><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h4>
    ${a.excerpt ? `<p>${esc(a.excerpt)}……</p>` : ''}
  </article>`;
}

// ---------- 当期首页 ----------
const indexHTML = page(
  `Hi, AI · 第 ${finalNo} 期`,
  `<header class="masthead">
    <p class="kicker">The AI Morning Post</p>
    <h1 class="mast">Hi, AI<span class="dot">.</span></h1>
    <p class="motto">一份 AI 标记的晨报 · 每天早上八点，从全网搜罗人工智能领域的新鲜事。</p>
  </header>
  <div class="dateline">
    <span>${fmtCN(dateK)}</span>
    <span class="no">第 ${finalNo} 期</span>
    <span>晨间八时印行</span>
  </div>
  <div class="double-rule"></div>

  <section class="headline">
    <span class="label">今日头条</span>
    <h2><a href="${esc(headline.link)}" target="_blank" rel="noopener">${esc(headline.title)}</a></h2>
    <p class="meta"><b>${esc(headline.source)}</b>${headline.date ? ' · ' + hm(headline.date) : ''}</p>
    ${headline.excerpt ? `<p class="lede">${esc(headline.excerpt)}……</p>` : ''}
    <a class="goto" href="${esc(headline.link)}" target="_blank" rel="noopener">阅读全文 ↗</a>
  </section>

  <section class="stats">
    ${stats.map((s) => `<div class="stat"><b>${s.v}</b><span>${s.label}</span></div>`).join('\n')}
  </section>

  ${sections
    .map(
      (s) => `<section class="section">
    <header><h3>${s.name}</h3><span class="en">${
      { 要闻: 'Top Stories', 研究前沿: 'Research', 产品与发布: 'Products & Launches', 开源与社区: 'Open Source', 行业与资本: 'Business & Funding', 社区热议: 'Community Buzz', 观点与随笔: 'Opinions' }[s.name] || ''
    }</span><div class="rule"></div></header>
    <div class="briefs">${s.items.map(briefHTML).join('\n')}</div>
  </section>`
    )
    .join('\n')}

  <section class="archive">
    <h3>往期回顾</h3>
    <ul>${manifestSaved
      .slice(-9, -1)
      .reverse()
      .map((m) => `<li><a href="issues/${m.date}.html">第 ${m.no} 期 · ${m.date}</a> — ${esc(m.headline)}</li>`)
      .join('\n')}</ul>
    <a class="all" href="archive.html">查看全部往期 →</a>
  </section>

  <footer class="colophon">
    <span><span class="seal-mark">Hi, AI</span> · 一份由 AI 标记编排的晨报</span>
    <span>内容来自公开 RSS 源，版权归原作者所有 · <a href="https://github.com/BaoXuebin/ai-morning-post" target="_blank" rel="noopener" style="color:inherit">GitHub</a></span>
  </footer>`
);

// 当期存档页（与首页同内容，链接改为相对 issues/）
const issueHTML = indexHTML
  .replace(`Hi, AI · 第 ${finalNo} 期`, `Hi, AI · 第 ${finalNo} 期 · ${dateK}`)
  .replaceAll('href="issues/', 'href="../issues/')
  .replaceAll('href="archive.html"', 'href="../archive.html"');
writeFileSync(join(SITE, 'issues', `${dateK}.html`), issueHTML);

// 总目录页
const archiveHTML = page(
  'Hi, AI · 全部往期',
  `<header class="masthead">
    <p class="kicker">The AI Morning Post</p>
    <h1 class="mast">Hi, AI<span class="dot">.</span></h1>
    <p class="motto">一份 AI 标记的晨报 · 全部往期，按日期排列。</p>
  </header>
  <div class="double-rule" style="margin-top:18px"></div>
  <section class="archive" style="border-top:none;margin-top:10px;padding-top:0">
    <ul>${[...manifestSaved]
      .reverse()
      .map(
        (m) =>
          `<li><a href="issues/${m.date}.html">第 ${m.no} 期 · ${m.date}</a> — ${esc(m.headline)}</li>`
      )
      .join('\n')}</ul>
    <a class="all" href="index.html">返回今日头版 →</a>
  </section>
  <footer class="colophon">
    <span><span class="seal-mark">Hi, AI</span> · 一份由 AI 标记编排的晨报</span>
    <span><a href="https://github.com/BaoXuebin/ai-morning-post" target="_blank" rel="noopener" style="color:inherit">GitHub</a></span>
  </footer>`
);

writeFileSync(join(SITE, 'index.html'), indexHTML);
writeFileSync(join(SITE, 'archive.html'), archiveHTML);
writeFileSync(manifestPath, JSON.stringify(manifestSaved, null, 2));

console.log(
  `第 ${finalNo} 期排版完成：${dateK} | 头条《${headline.title}》| 共 ${today.length} 条 | 版块 ${
    sections.map((s) => s.name + '×' + s.items.length).join('、') || '无'
  } | 待翻译 ${needT.length} 条`
);
if (failed.length) console.log('抓取失败的源：\n' + failed.join('\n'));
