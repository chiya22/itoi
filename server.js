// server.js (Playwright ヘッドレス版)
// Expressベースで「毎日7:00に糸井重里のトップページ文章を取得し、メール送信する」MVP
// ※ 私的利用前提。robots.txt / 利用規約の遵守を確認してください。

const path = require('path');
// Windows サービスは作業ディレクトリが System32 になる。プロジェクト直下に固定する。
process.chdir(__dirname);

require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { chromium } = require('playwright');
const sendMail = require('./tool/mailsend').sendMail;
const { fetchDarlingText } = require('./hobonichi');
const { fetchMishimagaArticle } = require('./mishimaga');
const { fetchDataIsCityDaily, formatDataIsCityMail } = require('./dataiscity');

const app = express();

const pino = require('pino');
const fs = require('fs');

const logDir = path.resolve(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'app.log');
// info 以上をログファイルと標準出力の両方へ出す。
// 標準出力は非同期にする。サービスでは同期書き込みがパイプを詰まらせ、定期実行が止まる。
const streams = [
  { level: 'info', stream: pino.destination({ dest: logFile, sync: true, mkdir: true }) },
  { level: 'info', stream: pino.destination({ dest: 1, sync: false, minLength: 0 }) },
];
const logger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams)
);


const TIME_ZONE = 'Asia/Tokyo';

function tokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  if (map.hour === '24') map.hour = '00';
  return map;
}

function formatDate(date = new Date()) {
  const parts = tokyoParts(date);
  return `${parts.year}/${parts.month}/${parts.day}`;
}

// 指定時刻から windowMinutes のあいだ、1日1回実行する。
// node-cron は予定秒を1秒でも過ぎるとその回を見逃し扱いにして実行しない。
// Windows サービスではタイマーが遅れやすく、毎朝飛ばされていた。
function scheduleDaily({ name, hour, minute, windowMinutes, task }) {
  let lastKey = '';
  let running = false;
  const start = hour * 60 + minute;

  const tick = async () => {
    if (running) return;
    const parts = tokyoParts();
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (lastKey === key) return;
    const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (nowMinutes < start || nowMinutes >= start + windowMinutes) return;
    lastKey = key;
    running = true;
    try {
      await task();
    } catch (err) {
      logger.error({ job: name, err }, 'ジョブが例外で終了');
    } finally {
      running = false;
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ job: name, err }, 'スケジューラエラー'));
  }, 15000);
  tick().catch((err) => logger.error({ job: name, err }, 'スケジューラエラー'));

  logger.info({
    job: name,
    at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    windowMinutes,
    timezone: TIME_ZONE,
  }, '定期実行を登録');
}

async function runDarlingJob() {
  const formattedDate = formatDate();
  logger.info({ job: 'darling', date: formattedDate }, 'ジョブ開始');
  try {
    const result = await fetchDarlingText();
    if (result.fallback) logger.warn('トップ抽出が弱い可能性 → yesterday にフォールバック');
    const text = result.text;
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
}

scheduleDaily({ name: 'darling', hour: 7, minute: 0, windowMinutes: 30, task: runDarlingJob });

function formatMishimagaMail(result) {
  const header = [
    result.episode ? `回数: ${result.episode}` : null,
    result.title ? `タイトル: ${result.title}` : null,
    result.date ? `更新日: ${result.date}` : null,
    result.url ? `URL: ${result.url}` : null,
  ].filter(Boolean).join('\n');
  return `${header}\n\n${result.body || '本文を取得できませんでした。'}`;
}

async function runMishimagaJob() {
  const formattedDate = formatDate();
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
}

scheduleDaily({ name: 'mishimaga', hour: 7, minute: 5, windowMinutes: 30, task: runMishimagaJob });

async function runDataIsCityJob() {
  const formattedDate = formatDate();
  logger.info({ job: 'dataiscity', date: formattedDate }, 'ジョブ開始');
  try {
    const result = await fetchDataIsCityDaily();
    const subject = result.body
      ? `今日、手を打つこと ${formattedDate}`
      : `今日、手を打つこと取得失敗 ${formattedDate}`;
    await sendMail(subject, formatDataIsCityMail(result));
    logger.info({
      job: 'dataiscity',
      subject,
      title: result.title,
      date: result.date,
      bytes: result.body?.length || 0,
    }, 'ジョブ完了');
  } catch (err) {
    logger.error({ job: 'dataiscity', err }, 'ジョブ中エラー');
    try {
      await sendMail(`今日、手を打つこと取得失敗 ${formattedDate}`, `エラー: ${err?.message || err}`);
    } catch (mailErr) {
      logger.error({ job: 'dataiscity', err: mailErr }, '失敗通知メールの送信に失敗');
    }
  }
}

scheduleDaily({ name: 'dataiscity', hour: 7, minute: 10, windowMinutes: 30, task: runDataIsCityJob });

// 手動実行用（UIなし）
app.get('/healthz', (_req, res) => res.send('OK'));
// app.post('/run', async (_req, res) => {
//   const formattedDate = formatDate(new Date());
//   const result = { ok: true, darling: null, mishimaga: null };
//   logger.info({ job: 'manual', date: formattedDate }, '手動実行開始');

//   try {
//     const result = await fetchDarlingText();
//     const text = result.text;
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

const browserPath = chromium.executablePath();
logger.info({
  cwd: process.cwd(),
  pid: process.pid,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  mailConfigured: Boolean(process.env.MAIL_TO && process.env.XSERVER_HOST_NAME),
  browserPath,
  browserExists: fs.existsSync(browserPath),
}, 'プロセス起動');

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));
server.on('error', (err) => {
  logger.error({ err }, 'HTTPサーバーの起動に失敗。定期実行は継続します');
});
