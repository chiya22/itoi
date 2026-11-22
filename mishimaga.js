// ミシマガジンのトップページで「読みに行く」をクリックし、
// 遷移先の「第XXX回」の記事内容（回数・タイトル・日付・本文）を取得するスクリプト（Playwright版）
//
// 使い方:
//   npm install playwright
//   npx playwright install chromium
//   node mishimaga.js
// 定期実行は server.js の cron（毎朝7:00）から fetchMishimagaArticle() を呼ぶ。

const { chromium } = require('playwright');

const TOP_URL = 'https://www.mishimaga.com/';

async function fetchMishimagaArticle() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(TOP_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // 「読みに行く」の文字の後ろにアイコン（span::after）が付くため、
    // アクセシブルネームの完全一致では見つからない。今日の読みもののリンク先へ直接進む。
    const link = page.locator('#reading p.btn a').filter({ hasText: '読みに行く' }).first();
    await link.waitFor({ state: 'attached', timeout: 15000 });
    const href = await link.getAttribute('href');
    if (!href) throw new Error('「読みに行く」のリンク先が見つかりません');
    await page.goto(new URL(href, TOP_URL).href, { waitUntil: 'networkidle', timeout: 60000 });
    console.log('遷移先URL:', page.url());

    // 「第XXX回」のラベルを起点に、タイトル・日付・本文を取得
    const result = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

      // 「第XXX回」だけを含む要素を探す（パンくずのリンクは除外）
      const labelRe = /^第\s*[0-9０-９]+\s*回$/;
      const label =
        [...document.querySelectorAll('body *')].find(
          (el) =>
            el.children.length === 0 &&
            labelRe.test(el.textContent.trim()) &&
            !el.closest('a, nav, [class*="bread"], [class*="pankuzu"]')
        ) || null;
      const episode = label ? label.textContent.trim() : null;

      // タイトル: ラベルの近くにある見出し（h1〜h3、画像見出しは除外）
      let title = null;
      let node = label;
      for (let i = 0; i < 5 && node && !title; i++) {
        const h = node.parentElement?.querySelector('h1, h2, h3');
        if (h && h.textContent.trim() && !h.querySelector('img')) title = h.textContent.trim();
        node = node.parentElement;
      }
      if (!title) {
        title = document.querySelector('meta[property="og:title"]')?.content || document.title;
      }

      // 更新日: YYYY.MM.DD 形式
      const dateMatch = document.body.innerText.match(/\d{4}\.\d{1,2}\.\d{1,2}/);
      const date = dateMatch ? dateMatch[0] : null;

      // 本文: よくある本文用セレクタを順に試し、だめならラベルの祖先から推定
      const bodySelectors = [
        '.entry-content', '.entry-body', '.post-content', '.article-body',
        '.article_body', '.content-body', '#entry', 'article', 'main',
      ];
      let bodyEl = null;
      for (const sel of bodySelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 200) { bodyEl = el; break; }
      }
      if (!bodyEl && label) {
        let n = label.parentElement;
        while (n && n !== document.body) {
          if (n.querySelectorAll('p').length >= 3) { bodyEl = n; break; }
          n = n.parentElement;
        }
      }

      let body = null;
      if (bodyEl) {
        // シェアボタン・関連記事・バックナンバー等を除いた複製から本文を取得
        const clone = bodyEl.cloneNode(true);
        clone
          .querySelectorAll('script, style, nav, aside, footer, [class*="share"], [class*="sns"], [class*="related"], [class*="recommend"], [class*="backnumber"]')
          .forEach((el) => el.remove());
        clone.style.position = 'absolute';
        clone.style.left = '-99999px';
        document.body.appendChild(clone);
        body = clean(clone.innerText);
        clone.remove();
      }

      return { url: location.href, episode, title, date, body };
    });

    return result;
  } finally {
    await browser.close();
  }
}

function printArticle(result) {
  console.log('==============================');
  console.log('回数    :', result.episode);
  console.log('タイトル:', result.title);
  console.log('更新日  :', result.date);
  console.log('==============================');
  console.log(result.body);
}

module.exports = { fetchMishimagaArticle };

if (require.main === module) {
  (async () => {
    try {
      const result = await fetchMishimagaArticle();
      printArticle(result);
    } catch (err) {
      console.error('エラー:', err.message);
      process.exitCode = 1;
    }
  })();
}
