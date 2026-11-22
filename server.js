// server.js (Playwright ヘッドレス版)
// Expressベースで「毎日7:00に糸井重里のトップページ文章を取得し、メール送信する」MVP
// ※ 私的利用前提。robots.txt / 利用規約の遵守を確認してください。

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { chromium } = require('playwright');
const sendMail = require('./tool/mailsend').sendMail;
const { fetchMishimagaArticle } = require('./mishimaga');

const app = express();


const pino = require('pino');
const fs = require('fs');
const path = require('path');


// ログファイルのパス
const logDir = path.resolve(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'app.log');
const logger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: logFile, sync: true, mkdir: true }) },
  ])
);


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
    logger.warn('トップ抽出が弱い可能性 → yesterday にフォールバック');
    text = await extractDarlingFrom(YESTERDAY_URL);
  }
  return text;
}

// 毎日7:00（Asia/Tokyo）に実行
cron.schedule('0 7 * * *', async () => {
  const formattedDate = formatDate(new Date());
  logger.info({ job: 'darling', date: formattedDate }, 'ジョブ開始');
  try {
    const text = await fetchDarlingText();
    const subject = text
      ? `今日のダーリン ${formattedDate}`
      : `今日のダーリン取得失敗 ${formattedDate}`;
    await sendMail(subject, text || '本文を取得できませんでした。');
    logger.info({ job: 'darling', subject, bytes: text?.length || 0 }, 'ジョブ完了');
  } catch (err) {
    logger.error({ job: 'darling', err }, 'ジョブ中エラー');
    try {
      await sendMail(`今日のダーリン取得失敗 ${formattedDate}`, `エラー: ${err?.message || err}`);
    } catch (mailErr) {
      logger.error({ job: 'darling', err: mailErr }, '失敗通知メールの送信に失敗');
    }
  }
}, { timezone: 'Asia/Tokyo' });
logger.info({ job: 'darling', cron: '21 17 * * *', timezone: 'Asia/Tokyo' }, '定期実行を登録');

function formatDate(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

function formatMishimagaMail(result) {
  const header = [
    result.episode ? `回数: ${result.episode}` : null,
    result.title ? `タイトル: ${result.title}` : null,
    result.date ? `更新日: ${result.date}` : null,
    result.url ? `URL: ${result.url}` : null,
  ].filter(Boolean).join('\n');
  return `${header}\n\n${result.body || '本文を取得できませんでした。'}`;
}

// 毎朝7:05（Asia/Tokyo）にミシマガジン最新回を取得してメール送信
cron.schedule('5 7 * * *', async () => {
  const formattedDate = formatDate(new Date());
  logger.info({ job: 'mishimaga', date: formattedDate }, 'ジョブ開始');
  try {
    const result = await fetchMishimagaArticle();
    const subject = result.body
      ? `ミシマガジン ${result.episode || ''} ${formattedDate}`.replace(/\s+/g, ' ').trim()
      : `ミシマガジン取得失敗 ${formattedDate}`;
    await sendMail(subject, formatMishimagaMail(result));
    logger.info({
      job: 'mishimaga',
      subject,
      episode: result.episode,
      title: result.title,
      bytes: result.body?.length || 0,
    }, 'ジョブ完了');
  } catch (err) {
    logger.error({ job: 'mishimaga', err }, 'ジョブ中エラー');
    try {
      await sendMail(`ミシマガジン取得失敗 ${formattedDate}`, `エラー: ${err?.message || err}`);
    } catch (mailErr) {
      logger.error({ job: 'mishimaga', err: mailErr }, '失敗通知メールの送信に失敗');
    }
  }
}, { timezone: 'Asia/Tokyo' });
logger.info({ job: 'mishimaga', cron: '0 7 * * *', timezone: 'Asia/Tokyo' }, '定期実行を登録');

// 手動実行用（UIなし）
app.get('/healthz', (_req, res) => res.send('OK'));
// app.post('/run', async (_req, res) => {
//   const formattedDate = formatDate(new Date());
//   const result = { ok: true, darling: null, mishimaga: null };
//   logger.info({ job: 'manual', date: formattedDate }, '手動実行開始');

//   try {
//     const text = await fetchDarlingText();
//     await sendMail(`今日のダーリン（手動実行） ${formattedDate}`, text || '本文を取得できませんでした。');
//     result.darling = { ok: true, bytes: text?.length || 0 };
//     logger.info({ job: 'manual', target: 'darling', bytes: text?.length || 0 }, '手動実行完了');
//   } catch (e) {
//     result.ok = false;
//     result.darling = { ok: false, error: String(e?.message || e) };
//     logger.error({ job: 'manual', target: 'darling', err: e }, '手動実行エラー');
//   }

//   try {
//     const article = await fetchMishimagaArticle();
//     const subject = `ミシマガジン（手動実行） ${article.episode || ''} ${formattedDate}`.replace(/\s+/g, ' ').trim();
//     const body = formatMishimagaMail(article);
//     await sendMail(article.body ? subject : `ミシマガジン取得失敗（手動実行） ${formattedDate}`, body);
//     result.mishimaga = {
//       ok: Boolean(article.body),
//       episode: article.episode,
//       title: article.title,
//       date: article.date,
//       url: article.url,
//       bytes: article.body?.length || 0,
//     };
//     if (!article.body) result.ok = false;
//     logger.info({
//       job: 'manual',
//       target: 'mishimaga',
//       episode: article.episode,
//       bytes: article.body?.length || 0,
//     }, '手動実行完了');
//   } catch (e) {
//     result.ok = false;
//     result.mishimaga = { ok: false, error: String(e?.message || e) };
//     logger.error({ job: 'manual', target: 'mishimaga', err: e }, '手動実行エラー');
//   }

//   res.status(result.ok ? 200 : 500).json(result);
// });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));
