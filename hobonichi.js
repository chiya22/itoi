// ほぼ日刊イトイ新聞の「今日のダーリン」本文を取得するスクリプト（Playwright版）
//
// 使い方:
//   npm install playwright
//   npx playwright install chromium
//   node hobonichi.js
// 定期実行は server.js が毎朝7:00（日本時間）に fetchDarlingText() を呼ぶ。

const { chromium } = require('playwright');

const TARGET_URL = 'https://www.1101.com/';
const YESTERDAY_URL = 'https://www.1101.com/darling_column/yesterday.html';

async function extractDarlingFrom(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: 'ItoiTopPageMailer/2.0 (+personal use)',
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const text = await page.evaluate(() => {
      const collectAfterHeading = () => {
        const heading = Array.from(document.querySelectorAll('h1, h2, h3'))
          .find((el) => /今日のダーリン/.test(el.textContent || ''));
        if (!heading) return '';
        const parts = [];
        let el = heading.nextElementSibling;
        let hops = 0;
        while (el && hops < 30) {
          const tag = el.tagName;
          if (['P', 'DIV', 'SECTION', 'ARTICLE'].includes(tag)) {
            const t = (el.innerText || '').trim();
            if (t) parts.push(t);
          }
          el = el.nextElementSibling;
          hops += 1;
        }
        return parts.join('');
      };

      const byHeading = collectAfterHeading();
      if (byHeading && byHeading.length > 120) return byHeading;

      const candidates = [
        '#darling', '.darling', 'article', 'main', '#main',
      ].flatMap((sel) => Array.from(document.querySelectorAll(sel)))
        .map((n) => (n.innerText || '').trim())
        .filter(Boolean);

      candidates.sort((a, b) => b.length - a.length);
      return candidates[0] || '';
    });

    return (text || '').trim();
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function fetchDarlingText() {
  let text = await extractDarlingFrom(TARGET_URL);
  let fallback = false;
  if (!text || text.length < 120) {
    fallback = true;
    text = await extractDarlingFrom(YESTERDAY_URL);
  }
  return { text: (text || '').trim(), fallback };
}

module.exports = { fetchDarlingText };

if (require.main === module) {
  (async () => {
    try {
      const result = await fetchDarlingText();
      if (result.fallback) console.error('トップ抽出が弱いため yesterday にフォールバック');
      console.log(result.text);
    } catch (err) {
      console.error('エラー:', err.message);
      process.exitCode = 1;
    }
  })();
}
