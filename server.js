// server.js (Playwright ヘッドレス版)
// Expressベースで「毎日7:00に糸井重里のトップページ文章を取得し、メール送信する」MVP
// ※ 私的利用前提。robots.txt / 利用規約の遵守を確認してください。

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { chromium } = require('playwright');
const sendMail = require('./tool/mailsend').sendMail;

const app = express();

const TARGET_URL = 'https://www.1101.com/';
const YESTERDAY_URL = 'https://www.1101.com/darling_column/yesterday.html';

// Playwrightで本文抽出
async function extractDarlingFrom(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'ItoiTopPageMailer/2.0 (+personal use)'
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // スクロールで遅延要素を念のためロード
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const text = await page.evaluate(() => {
      const collectAfterHeading = () => {
        const heading = Array.from(document.querySelectorAll('h1, h2, h3'))
          .find(el => /今日のダーリン/.test(el.textContent || ''));
        if (!heading) return '';
        const parts = [];
        let el = heading.nextElementSibling;
        let hops = 0;
        while (el && hops < 30) {
          const tag = el.tagName;
          if (['P','DIV','SECTION','ARTICLE'].includes(tag)) {
            const t = (el.innerText || '').trim();
            if (t) parts.push(t);
          }
          el = el.nextElementSibling;
          hops++;
        }
        return parts.join('');
      };

      const byHeading = collectAfterHeading();
      if (byHeading && byHeading.length > 120) return byHeading;

      // 既知/一般的な候補領域から最長テキストを選ぶ
      const candidates = [
        '#darling', '.darling', 'article', 'main', '#main'
      ].flatMap(sel => Array.from(document.querySelectorAll(sel)))
       .map(n => (n.innerText || '').trim())
       .filter(Boolean);

      candidates.sort((a, b) => b.length - a.length);
      const longest = candidates[0] || '';
      return longest;
    });

    return (text || '').trim();
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function fetchDarlingText() {
  // 1. トップ
  let text = await extractDarlingFrom(TARGET_URL);
  // 2. テキストが短い/空なら「昨日」ページをフォールバック
  if (!text || text.length < 120) {
    console.warn('トップ抽出が弱い可能性 → yesterday にフォールバック');
    text = await extractDarlingFrom(YESTERDAY_URL);
  }
  return text;
}

// 毎朝7:00（Asia/Tokyo）に実行
cron.schedule('41 13 * * *', async () => {
  console.log('ジョブ開始:', new Date().toISOString());
  try {
    const text = await fetchDarlingText();
    if (text) {
      await sendMail('今日のダーリン', text);
    } else {
      await sendMail('今日のダーリン取得失敗', '本文を取得できませんでした。');
    }
  } catch (err) {
    console.error('ジョブ中エラー:', err);
    try {
      await sendMail('今日のダーリン取得失敗', `エラー: ${err?.message || err}`);
    } catch {}
  }
}, { timezone: 'Asia/Tokyo' });

// 手動実行用（UIなし）
app.get('/healthz', (_req, res) => res.send('OK'));
app.post('/run', async (_req, res) => {
  try {
    const text = await fetchDarlingText();
    await sendMail('今日のダーリン（手動実行）', text || '本文を取得できませんでした。');
    res.json({ ok: true, bytes: text?.length || 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
