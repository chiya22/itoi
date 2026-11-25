// Data is CITY「今日、手を打つこと」を取得する。
// 使い方: node dataiscity.js
// 定期実行は server.js が毎朝7:10（日本時間）に fetchDataIsCityDaily() を呼ぶ。

const PAGE_URL = 'https://teleport.jp/dataiscity/daily/';

function extractElement(html, start) {
  const tag = html.slice(start).match(/^<([a-zA-Z0-9]+)/)[1];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = re.exec(html))) {
    if (match[1] === '/') depth -= 1;
    else if (!match[0].endsWith('/>')) depth += 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return html.slice(start);
}

function isNoiseSection(openTag) {
  return /class="[^"]*\b(da|a-su|dy-about|join)\b/.test(openTag)
    || /id="(?:dy-cal|join)"/.test(openTag);
}

function removeNoise(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<section', i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const block = extractElement(html, start);
    const openTag = block.match(/^<section\b[^>]*>/i)[0];
    if (!isNoiseSection(openTag)) out += block;
    i = start + block.length;
  }
  return out;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  let text = html
    .replace(/<nav\b[^>]*class="[^"]*(?:dy-pager|dy-nav)[^"]*"[\s\S]*?<\/nav>/gi, '')
    .replace(/<a\b[^>]*class="[^"]*ccd-link[^"]*"[\s\S]*?<\/a>/gi, '')
    .replace(/<p class="kl">[\s\S]*?<\/p>/gi, '')
    .replace(/<h1 class="a-title">[\s\S]*?<\/h1>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<span class="dy-what">/g, '\n')
    .replace(/<span class="dy-dk">([\s\S]*?)<\/span>/g, '\n$1\n')
    .replace(/<li class="dy-it">/g, '\n\n')
    .replace(/<p class="dy-do">/g, '\n')
    .replace(/<p class="dy-why">/g, '\n')
    .replace(/<ul class="dy-src"[^>]*>/g, '\n出どころ\n')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const name = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const url = new URL(href, PAGE_URL).href;
      return name ? `${name} ${url}` : url;
    })
    .replace(/<\/b>/gi, ' ')
    .replace(/<\/(h1|h2|h3|p|li|div)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function parseDaily(html, url) {
  const articleMatch = html.match(/<article class="daily">[\s\S]*?<\/article>/i);
  const article = removeNoise(articleMatch ? articleMatch[0] : html);
  const titleMatch = article.match(/<h1 class="a-title">([\s\S]*?)<\/h1>/i);
  const title = titleMatch
    ? htmlToText(titleMatch[1].replace(/<span class="dy-date">/g, ' ')).replace(/\s+/g, ' ').trim()
    : (html.match(/<title>(.*?)<\/title>/i) || [])[1] || '';
  const dateMatch = html.match(/<time datetime="(\d{4}-\d{2}-\d{2})">([^<]*)<\/time>/i);
  const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/i) || [])[1] || url;
  const body = htmlToText(article);
  return {
    url: canonical,
    title,
    date: dateMatch ? dateMatch[1] : null,
    dateLabel: dateMatch ? dateMatch[2].trim() : null,
    body,
  };
}

async function fetchDataIsCityDaily() {
  const response = await fetch(PAGE_URL, {
    headers: {
      'User-Agent': 'ItoiTopPageMailer/2.0 (+personal use)',
      'Accept-Language': 'ja',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`取得失敗 ${response.status}`);
  const html = await response.text();
  return parseDaily(html, response.url);
}

function formatDataIsCityMail(result) {
  const header = [
    result.title,
    result.dateLabel,
    result.url,
  ].filter(Boolean).join('\n');
  return `${header}\n\n${result.body || '本文を取得できませんでした。'}`;
}

module.exports = { fetchDataIsCityDaily, formatDataIsCityMail };

if (require.main === module) {
  (async () => {
    try {
      const result = await fetchDataIsCityDaily();
      console.log(formatDataIsCityMail(result));
    } catch (err) {
      console.error('エラー:', err.message);
      process.exitCode = 1;
    }
  })();
}
