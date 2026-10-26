// index.js — Полный магазин и установщик iOS-приложений (AppleIPA) для Bothost
// Включает: Telegram-бота, Mini App каталог, перехват UDID, авто-подпись zsign и раздачу itms-services://

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawn, execFile } = require('child_process');

// ═══════════════════════════════════════════════════════════
// 1. АВТОУСТАНОВКА NPM-ПАКЕТОВ НА BOTHOST
// ═══════════════════════════════════════════════════════════
function ensurePackages() {
  const pkgs = ['telegraf', 'express', 'better-sqlite3', 'dotenv'];
  const missing = pkgs.filter((p) => !fs.existsSync(path.join(__dirname, 'node_modules', p)));
  if (!missing.length) return;
  console.log('[BOOT] Устанавливаю зависимости:', missing.join(', '));
  try {
    execSync(`npm install ${missing.join(' ')} --no-audit --no-fund --loglevel=error`, {
      cwd: __dirname,
      stdio: 'inherit',
    });
  } catch (e) {
    console.error('[BOOT] Ошибка npm install:', e.message);
    process.exit(1);
  }
}
ensurePackages();

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const Database = require('better-sqlite3');

// ═══════════════════════════════════════════════════════════
// 2. КОНФИГУРАЦИЯ И ПАПКИ ХРАНИЛИЩА
// ═══════════════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВСТАВЬ_СЮДА_ТОКЕН_ОТ_BOTFATHER';
const ADMIN_ID = Number(process.env.ADMIN_ID || process.env.DEV_MAIN || 0); // Твой Telegram ID
const PORT = Number(process.env.PORT || 3080);

if (!BOT_TOKEN || BOT_TOKEN.includes('ВСТАВЬ')) {
  console.error('❌ ОШИБКА: Укажи BOT_TOKEN в .env или прямо в коде index.js (строка 33)!');
  process.exit(1);
}

const DIRS = {
  bin: path.join(__dirname, 'bin'),
  data: path.join(__dirname, 'data'),
  cleanIpa: path.join(__dirname, 'storage', 'clean_ipa'),   // Исходные .ipa файлы (например sber.ipa)
  signedIpa: path.join(__dirname, 'storage', 'signed_ipa'), // Временные подписанные .ipa для клиентов
  certs: path.join(__dirname, 'storage', 'certs'),          // Сертификаты: cert.p12 и cert.mobileprovision
};
for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

// ═══════════════════════════════════════════════════════════
// 3. БАЗА ДАННЫХ SQLITE (ЮЗЕРЫ, ПРИЛОЖЕНИЯ, ЗАКАЗЫ, ПРОМОКОДЫ)
// ═══════════════════════════════════════════════════════════
const db = new Database(path.join(DIRS.data, 'ipa_store.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    username TEXT,
    udid TEXT DEFAULT NULL,
    device_model TEXT DEFAULT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    version TEXT NOT NULL,
    icon TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    ipa_filename TEXT NOT NULL,
    external_ipa_url TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS promos (
    code TEXT PRIMARY KEY,
    discount_pct INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    apps_json TEXT NOT NULL,
    promo_code TEXT DEFAULT NULL,
    total_price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
`);

// Заполняем стартовый каталог приложений и промокоды, если база пустая
if (db.prepare('SELECT COUNT(*) as c FROM apps').get().c === 0) {
  const seedApps = [
    ['sber', 'СберБанк Онлайн', 'Банки', 'v15.4.0', '🟢', 'ru.sberbank.online', 'sber.ipa'],
    ['tbank', 'Т-Банк (Тинькофф)', 'Банки', 'v6.25.0', '🟡', 'ru.tcsbank.mb', 'tbank.ipa'],
    ['alfa', 'Альфа-Банк', 'Банки', 'v12.19.0', '🔴', 'ru.alfabank.mobile.ios', 'alfa.ipa'],
    ['wb_biz', 'WB Бизнес', 'Банки', 'v2.20.0', '🟣', 'ru.wildberries.business', 'wb_biz.ipa'],
    ['alfa_str', 'АльфаСтрахование', 'Банки', 'v3.34.2', '❤️', 'ru.alfastrah.mobile', 'alfa_str.ipa'],
    ['lukoil', 'АЗС Лукойл', 'Авто и транспорт', 'v4.11.0', '⛽', 'ru.lukoil.azs', 'lukoil.ipa'],
    ['tatneft', 'АЗС Татнефть', 'Авто и транспорт', 'v2.12.0', '🟢', 'ru.tatneft.azs', 'tatneft.ipa'],
    ['2gis', '2ГИС (Карты)', 'Авто и транспорт', 'v6.14.0', '🗺', 'ru.doublegis.grym', '2gis.ipa'],
    ['yota', 'YOTA', 'Связь', 'v13.90', '🔵', 'ru.yota.app', 'yota.ipa'],
    ['v2ray', 'v2RayTun', 'Инструменты', 'v1.4.8', '🕶', 'com.v2raytun.app', 'v2ray.ipa'],
    ['chatgpt', 'ChatGPT', 'Нейросети', 'v1.2026', '🤖', 'com.openai.chat', 'chatgpt.ipa'],
    ['claude', 'Claude AI', 'Нейросети', 'v1.2.0', '🧠', 'com.anthropic.claude', 'claude.ipa'],
    ['vk_mod', 'VK (BHTwitter/VKMod)', 'Соцсети', 'v8.95', '🔷', 'com.vk.vkclient', 'vk.ipa'],
    ['tiktok', 'TikTok Dark (Мод)', 'Соцсети', 'v36.5.0', '🎵', 'com.zhiliaoapp.musically', 'tiktok.ipa'],
  ];
  const insApp = db.prepare('INSERT INTO apps (id, name, category, version, icon, bundle_id, ipa_filename) VALUES (?, ?, ?, ?, ?, ?, ?)');
  seedApps.forEach((a) => insApp.run(...a));

  const insPromo = db.prepare('INSERT OR IGNORE INTO promos (code, discount_pct) VALUES (?, ?)');
  insPromo.run('TT_5', 5);
  insPromo.run('MIPSIK', 15);
  insPromo.run('FREE10', 10);
}

// ═══════════════════════════════════════════════════════════
// 4. АВТОЗАГРУЗКА БИНАРНИКОВ (CLOUDFLARED И ZSIGN ДЛЯ LINUX)
// ═══════════════════════════════════════════════════════════
const CLOUDFLARED_BIN = path.join(DIRS.bin, 'cloudflared');
const ZSIGN_BIN = path.join(DIRS.bin, 'zsign');

function downloadBinary(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        file.close();
        return downloadBinary(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function startCloudflareTunnel(port) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');

  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    console.log('[TUNNEL] Скачиваю cloudflared (Linux x64)...');
    await downloadBinary(
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
      CLOUDFLARED_BIN
    );
    fs.chmodSync(CLOUDFLARED_BIN, 0o755);
  }

  return new Promise((resolve) => {
    const child = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']);
    let done = false;

    const parseOut = (chunk) => {
      const text = chunk.toString();
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !done) {
        done = true;
        console.log('[TUNNEL] ✅ HTTPS-туннель активен:', m[0]);
        resolve(m[0]);
      }
    };

    child.stdout.on('data', parseOut);
    child.stderr.on('data', parseOut);
    child.on('error', () => {
      if (!done) resolve(`http://localhost:${port}`);
    });
  });
}

// Подпись .ipa через zsign (если в storage/certs лежат cert.p12 и cert.mobileprovision)
function prepareSignedIpa(appRow, orderId) {
  return new Promise((resolve) => {
    const cleanPath = path.join(DIRS.cleanIpa, appRow.ipa_filename);
    const p12Path = path.join(DIRS.certs, 'cert.p12');
    const provPath = path.join(DIRS.certs, 'cert.mobileprovision');
    const p12Pass = process.env.P12_PASSWORD || '1234';

    // Если указан внешний URL уже подписанного .ipa — отдаём его сразу
    if (appRow.external_ipa_url) {
      return resolve(appRow.external_ipa_url);
    }

    // Если есть бинарник zsign и сертификаты — подписываем на лету
    if (fs.existsSync(ZSIGN_BIN) && fs.existsSync(cleanPath) && fs.existsSync(p12Path) && fs.existsSync(provPath)) {
      const signedName = `${orderId}_${appRow.id}.ipa`;
      const signedPath = path.join(DIRS.signedIpa, signedName);

      if (fs.existsSync(signedPath)) {
        return resolve(`${PUBLIC_URL}/signed/${signedName}`);
      }

      execFile(
        ZSIGN_BIN,
        ['-k', p12Path, '-p', p12Pass, '-m', provPath, '-o', signedPath, '-z', '5', cleanPath],
        { timeout: 120000 },
        (err) => {
          if (!err && fs.existsSync(signedPath)) {
            // Автоудаление через 15 минут для экономии места на Bothost
            setTimeout(() => fs.unlink(signedPath, () => {}), 15 * 60 * 1000).unref?.();
            return resolve(`${PUBLIC_URL}/signed/${signedName}`);
          }
          resolve(`${PUBLIC_URL}/clean/${appRow.ipa_filename}`);
        }
      );
      return;
    }

    // Иначе раздаём файл напрямую из папки clean_ipa (если ты положил туда уже подписанный .ipa)
    resolve(`${PUBLIC_URL}/clean/${appRow.ipa_filename}`);
  });
}

// ═══════════════════════════════════════════════════════════
// 5. ВЕБ-СЕРВЕР (MINI APP КАТАЛОГ + ПЕРЕХВАТ UDID + ITMS-SERVICES)
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use('/clean', express.static(DIRS.cleanIpa));
app.use('/signed', express.static(DIRS.signedIpa));

let PUBLIC_URL = `http://localhost:${PORT}`;
const bot = new Telegraf(BOT_TOKEN);

function calcCartPrice(appsCount, promoCode) {
  const unitPrice = appsCount >= 3 ? 425 : 500;
  const rawTotal = appsCount * unitPrice;
  const promoRow = promoCode
    ? db.prepare('SELECT discount_pct FROM promos WHERE code = ?').get(String(promoCode).toUpperCase())
    : null;
  const discPct = promoRow ? promoRow.discount_pct : 0;
  const discountSum = Math.round(rawTotal * (discPct / 100));
  return {
    count: appsCount,
    unitPrice,
    rawTotal,
    discPct,
    discountSum,
    finalPrice: Math.max(0, rawTotal - discountSum),
  };
}

// ─── एপিИ для Mini App ───
app.get('/api/catalog', (req, res) => {
  const apps = db.prepare('SELECT * FROM apps ORDER BY category, name').all();
  const promos = db.prepare('SELECT * FROM promos').all();
  res.json({ apps, promos });
});

app.post('/api/order', async (req, res) => {
  try {
    const { userId, apps, promo } = req.body;
    if (!userId || !Array.isArray(apps) || !apps.length) {
      return res.status(400).json({ error: 'Выбери хотя бы одно приложение' });
    }

    const orderId = crypto.randomBytes(3).toString('hex').toUpperCase();
    const pricing = calcCartPrice(apps.length, promo);

    // Если заказывает сам админ — сразу ставим статус 'paid' для удобного теста
    const isAdminUser = Number(userId) === ADMIN_ID;
    const initialStatus = isAdminUser ? 'paid' : 'pending';

    db.prepare(`
      INSERT INTO orders (id, user_id, apps_json, promo_code, total_price, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, Number(userId), JSON.stringify(apps), promo || null, pricing.finalPrice, initialStatus, Date.now());

    const allApps = db.prepare('SELECT * FROM apps').all();
    const appNames = apps.map((id) => allApps.find((a) => a.id === id)?.name || id).join(', ');
    const installPageUrl = `${PUBLIC_URL}/install/${orderId}`;
    const udidStartUrl = `${PUBLIC_URL}/udid/start/${userId}`;

    const kbRows = [];
    if (initialStatus === 'paid') {
      kbRows.push([Markup.button.url('📲 Установить приложения (Safari)', installPageUrl)]);
    } else {
      kbRows.push([Markup.button.callback(`💳 Оплатить ${pricing.finalPrice} ₽ (Тест-оплата)`, `order:pay:${orderId}`)]);
    }
    kbRows.push([Markup.button.url('🔗 Привязать iPhone (UDID)', udidStartUrl)]);

    await bot.telegram.sendMessage(
      Number(userId),
      `🧾 *Заказ #${orderId} создан!*\n\n` +
      `📦 Выбрано (${apps.length} шт.): *${appNames}*\n` +
      (pricing.discPct ? `🏷 Промокод *${promo}*: −${pricing.discPct}% (−${pricing.discountSum} ₽)\n` : '') +
      `💰 Итого: *${pricing.finalPrice} ₽*\n` +
      `📡 Статус: *${initialStatus === 'paid' ? '✅ Оплачен (Админ)' : '⏳ Ожидает оплаты'}*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kbRows) }
    ).catch(() => {});

    res.json({ ok: true, orderId, installUrl: installPageUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Профиль автоматического получения UDID с iPhone ───
app.get('/udid/start/:userId', (req, res) => {
  const { userId } = req.params;
  const uuid1 = crypto.randomUUID();
  const uuid2 = crypto.randomUUID();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${PUBLIC_URL}/udid/callback/${userId}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
    </array>
  </dict>
  <key>PayloadOrganization</key>
  <string>AppleIPA Store</string>
  <key>PayloadDisplayName</key>
  <string>Привязка iPhone к боту</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadUUID</key>
  <string>${uuid1}</string>
  <key>PayloadIdentifier</key>
  <string>com.appleipa.profile.${uuid2}</string>
  <key>PayloadDescription</key>
  <string>Профиль автоматически передаёт UDID вашего iPhone в Telegram-бота для выпуска сертификата установки.</string>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/x-apple-aspen-config; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bind-iphone.mobileconfig"');
  res.send(xml);
});

app.post('/udid/callback/:userId', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const userId = Number(req.params.userId);
  const raw = req.body.toString('utf8');

  const udid = raw.match(/<key>UDID<\/key>\s*<string>([a-zA-Z0-9-]+)<\/string>/)?.[1] || 'Неизвестен';
  const product = raw.match(/<key>PRODUCT<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || 'iPhone';

  db.prepare('UPDATE users SET udid = ?, device_model = ? WHERE id = ?').run(udid, product, userId);

  await bot.telegram.sendMessage(
    userId,
    `📱 *Твой iPhone успешно привязан!*\n\n` +
    `🔹 Модель: *${product}*\n` +
    `🔑 UDID: \`${udid}\`\n\n` +
    `Теперь ты можешь устанавливать приложения из раздела «📦 Мои заказы».`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  res.redirect(301, `${PUBLIC_URL}/udid/done?udid=${encodeURIComponent(udid)}&model=${encodeURIComponent(product)}`);
});

app.get('/udid/done', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>iPhone привязан</title></head>
  <body style="background:#0b0b12;color:#fff;font-family:-apple-system,sans-serif;text-align:center;padding:50px 20px">
    <div style="background:#171724;padding:24px;border-radius:18px;max-width:380px;margin:0 auto">
      <h2>✅ iPhone привязан!</h2>
      <p>Модель: <b>${req.query.model || 'iPhone'}</b></p>
      <p style="font-family:monospace;background:#0e0e17;padding:10px;border-radius:10px;color:#8c7aff;word-break:break-all">${req.query.udid || ''}</p>
      <p style="color:#9a9ab0;font-size:14px">Можешь закрыть эту вкладку и вернуться в Telegram-бота.</p>
    </div>
  </body></html>`);
});

// ─── Раздача manifest.plist для протокола itms-services:// ───
app.get('/plist/:orderId/:appId.plist', async (req, res) => {
  const { orderId, appId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'paid') return res.status(403).send('Order not paid');

  const appRow = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  if (!appRow) return res.status(404).send('App not found');

  const finalIpaUrl = await prepareSignedIpa(appRow, orderId);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${finalIpaUrl}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${appRow.bundle_id}</string>
        <key>bundle-version</key>
        <string>${appRow.version.replace(/^v/i, '')}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${appRow.name}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(plist);
});

// ─── Страница установки оплаченного заказа в Safari ───
app.get('/install/:orderId', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).send('Заказ не найден');
  if (order.status !== 'paid') return res.status(403).send('Заказ ещё не оплачен');

  const appIds = JSON.parse(order.apps_json || '[]');
  const allApps = db.prepare('SELECT * FROM apps').all();

  const cards = appIds.map((id) => {
    const a = allApps.find((x) => x.id === id);
    if (!a) return '';
    const plistUrl = `${PUBLIC_URL}/plist/${order.id}/${a.id}.plist`;
    const itms = `itms-services://?action=download-manifest&url=${encodeURIComponent(plistUrl)}`;
    return `<div style="background:#161622;border:1px solid #26263a;padding:14px 16px;border-radius:16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
      <div style="text-align:left;display:flex;align-items:center;gap:12px">
        <div style="font-size:26px">${a.icon}</div>
        <div><div style="font-weight:700;font-size:15px">${a.name}</div><div style="font-size:12px;color:#8e8ea6">${a.version} · iOS 15+</div></div>
      </div>
      <a href="${itms}" style="background:linear-gradient(90deg,#6b4eff,#936eff);color:#fff;text-decoration:none;padding:10px 18px;border-radius:12px;font-weight:700;font-size:14px">Установить</a>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Установка заказа #${order.id}</title></head>
  <body style="background:#0b0b12;color:#fff;font-family:-apple-system,sans-serif;padding:24px 16px;text-align:center">
    <h2 style="margin-bottom:6px">📲 Заказ #${order.id}</h2>
    <p style="color:#9a9ab0;font-size:13px;max-width:380px;margin:0 auto 20px">Открой эту страницу в браузере <b>Safari</b> на iPhone и нажми «Установить». Подтверди системное окно iOS — иконка появится на рабочем столе.</p>
    <div style="max-width:420px;margin:0 auto">${cards}</div>
  </body></html>`);
});

// ─── Фронтенд Mini App каталога (1-в-1 как на видео) ───
app.get('/app', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>AppleIPA_install</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin: 0; background: #0b0b12; color: #fff; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding-bottom: 100px; }
    .top { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #1e1e2d; }
    .brand { font-weight: 700; font-size: 16px; display: flex; align-items: center; gap: 8px; }
    .hero { margin: 14px 16px; background: linear-gradient(135deg, #1d183b, #121220); border: 1px solid #30285c; border-radius: 18px; padding: 16px; }
    .hero h2 { margin: 0 0 12px; font-size: 20px; line-height: 1.25; }
    .hero span { color: #8c7aff; }
    .tiers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .tier { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 10px 12px; }
    .tier-sub { font-size: 12px; color: #9a9ab0; }
    .tier-val { font-size: 16px; font-weight: 700; margin-top: 4px; }
    .search { margin: 0 16px 12px; }
    .search input { width: 100%; background: #151521; border: 1px solid #262638; color: #fff; padding: 12px 14px; border-radius: 12px; font-size: 14px; outline: none; }
    .cats { display: flex; gap: 8px; overflow-x: auto; padding: 0 16px 12px; scrollbar-width: none; }
    .cats::-webkit-scrollbar { display: none; }
    .cat { background: #171724; color: #a0a0b8; border: 1px solid #252538; padding: 7px 14px; border-radius: 20px; font-size: 13px; white-space: nowrap; cursor: pointer; }
    .cat.active { background: #6b4eff; color: #fff; border-color: #6b4eff; }
    .list { padding: 0 16px; display: flex; flex-direction: column; gap: 10px; }
    .card { background: #141420; border: 1px solid #222233; border-radius: 16px; padding: 12px; display: flex; align-items: center; justify-content: space-between; }
    .card.sel { border-color: #6b4eff; background: #19162e; }
    .left { display: flex; align-items: center; gap: 12px; }
    .ico { width: 46px; height: 46px; border-radius: 12px; background: #232336; display: flex; align-items: center; justify-content: center; font-size: 24px; }
    .name { font-weight: 600; font-size: 15px; }
    .meta { font-size: 12px; color: #85859c; margin-top: 3px; }
    .btn-pick { background: #222234; color: #fff; border: none; padding: 9px 15px; border-radius: 12px; font-weight: 600; font-size: 13px; cursor: pointer; }
    .card.sel .btn-pick { background: #6b4eff; }
    .bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(18,18,28,0.96); backdrop-filter: blur(10px); border-top: 1px solid #28283d; padding: 12px 16px; display: none; align-items: center; justify-content: space-between; }
    .sum { font-size: 18px; font-weight: 800; }
    .sub { font-size: 12px; color: #9c9cb2; }
    .go { background: linear-gradient(90deg, #6b4eff, #936eff); color: #fff; border: none; padding: 13px 22px; border-radius: 14px; font-weight: 700; font-size: 15px; cursor: pointer; }
    .checkout { display: none; padding: 16px; }
    .promo { display: flex; gap: 8px; margin-top: 14px; }
    .promo input { flex: 1; background: #151521; border: 1px solid #28283c; color: #fff; padding: 12px; border-radius: 12px; font-size: 14px; }
    .promo button { background: #252538; color: #fff; border: none; padding: 0 18px; border-radius: 12px; font-weight: 600; }
    .ok-msg { color: #32d74b; font-size: 13px; margin-top: 8px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="top">
    <div class="brand">📲 Install-iOS</div>
    <div style="font-size:12px;color:#8e8ea6" id="countBadge">Загрузка...</div>
  </div>

  <div id="catalogScreen">
    <div class="hero">
      <h2>Нужные приложения — на вашем <span>iPhone</span></h2>
      <div class="tiers">
        <div class="tier"><div class="tier-sub">1–2 приложения</div><div class="tier-val">500 ₽/шт.</div></div>
        <div class="tier"><div class="tier-sub">от 3 приложений</div><div class="tier-val">425 ₽/шт.</div></div>
      </div>
    </div>
    <div class="search"><input id="q" placeholder="🔍 Найти: сбер, тинькофф, лукойл, chatgpt..." oninput="render()"></div>
    <div class="cats" id="cats"></div>
    <div class="list" id="list"></div>
  </div>

  <div class="checkout" id="checkoutScreen">
    <button onclick="toCatalog()" style="background:none;border:none;color:#8c7aff;font-size:15px;padding:0;margin-bottom:12px;cursor:pointer">← Изменить выбор</button>
    <h2 style="margin:0 0 6px">Проверьте выбранное</h2>
    <p style="color:#8e8ea6;font-size:13px;margin:0 0 14px">Само создание заказа не списывает деньги. После подтверждения бот пришлёт кнопку установки.</p>
    <div class="list" id="checkList" style="padding:0"></div>
    <div class="promo">
      <input id="promoInp" placeholder="Введите промокод (например TT_5)">
      <button onclick="checkPromo()">Применить</button>
    </div>
    <div id="promoInfo" class="ok-msg"></div>
  </div>

  <div class="bar" id="bar">
    <div><div class="sum" id="sumTxt">0 ₽</div><div class="sub" id="subTxt">0 приложений</div></div>
    <button class="go" id="goBtn" onclick="nextStep()">Продолжить →</button>
  </div>

  <script>
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.expand(); tg.ready(); }

    let APPS = [];
    let PROMOS = {};
    let sel = new Set();
    let curCat = 'Все';
    let mode = 'catalog';
    let activePromo = null;

    async function load() {
      const r = await fetch('/api/catalog');
      const d = await r.json();
      APPS = d.apps || [];
      (d.promos || []).forEach(p => PROMOS[p.code] = p.discount_pct);
      document.getElementById('countBadge').textContent = APPS.length + ' из ' + APPS.length;
      renderCats();
      render();
    }

    function renderCats() {
      const uniqueCats = ['Все', 'Выбранные', ...new Set(APPS.map(a => a.category))];
      document.getElementById('cats').innerHTML = uniqueCats.map(c => {
        const cnt = c === 'Выбранные' ? ' (' + sel.size + ')' : '';
        return '<button class="cat ' + (curCat === c ? 'active' : '') + '" onclick="setCat(\\'' + c + '\\')">' + c + cnt + '</button>';
      }).join('');
    }

    function setCat(c) { curCat = c; renderCats(); render(); }

    function toggle(id) {
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      renderCats(); render(); updateBar();
    }

    function calc() {
      const n = sel.size;
      const unit = n >= 3 ? 425 : 500;
      const raw = n * unit;
      const pct = activePromo ? (PROMOS[activePromo] || 0) : 0;
      const disc = Math.round(raw * (pct / 100));
      return { n, unit, raw, pct, disc, final: raw - disc };
    }

    function render() {
      const q = document.getElementById('q').value.toLowerCase().trim();
      const items = APPS.filter(a => {
        if (curCat === 'Выбранные' && !sel.has(a.id)) return false;
        if (curCat !== 'Все' && curCat !== 'Выбранные' && a.category !== curCat) return false;
        if (q && !a.name.toLowerCase().includes(q) && !a.category.toLowerCase().includes(q)) return false;
        return true;
      });

      document.getElementById('list').innerHTML = items.map(a => {
        const s = sel.has(a.id);
        return '<div class="card ' + (s ? 'sel' : '') + '" onclick="toggle(\\'' + a.id + '\\')">' +
          '<div class="left"><div class="ico">' + a.icon + '</div>' +
          '<div><div class="name">' + a.name + '</div><div class="meta">iOS 15+ · ' + a.category + ' · ' + a.version + '</div></div></div>' +
          '<button class="btn-pick">' + (s ? '✓ Выбрано' : 'Выбрать') + '</button></div>';
      }).join('');
    }

    function updateBar() {
      const bar = document.getElementById('bar');
      if (!sel.size) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const p = calc();
      document.getElementById('sumTxt').textContent = p.final.toLocaleString('ru-RU') + ' ₽';
      document.getElementById('subTxt').textContent = p.n + ' прил. по ' + p.unit + ' ₽' + (p.disc ? ' (скидка ' + p.pct + '%)' : '');
      document.getElementById('goBtn').textContent = mode === 'catalog' ? 'Продолжить →' : 'Создать заказ';
    }

    function nextStep() {
      if (mode === 'catalog') {
        mode = 'checkout';
        document.getElementById('catalogScreen').style.display = 'none';
        document.getElementById('checkoutScreen').style.display = 'block';
        const p = calc();
        document.getElementById('checkList').innerHTML = APPS.filter(a => sel.has(a.id)).map(a =>
          '<div class="card"><div class="left"><div class="ico">' + a.icon + '</div>' +
          '<div><div class="name">' + a.name + '</div><div class="meta">Версия ' + a.version + '</div></div></div>' +
          '<div style="font-weight:700">' + p.unit + ' ₽</div></div>'
        ).join('');
        updateBar();
        return;
      }
      sendOrder();
    }

    function toCatalog() {
      mode = 'catalog';
      document.getElementById('checkoutScreen').style.display = 'none';
      document.getElementById('catalogScreen').style.display = 'block';
      updateBar();
    }

    function checkPromo() {
      const code = document.getElementById('promoInp').value.trim().toUpperCase();
      if (PROMOS[code]) {
        activePromo = code;
        const p = calc();
        document.getElementById('promoInfo').textContent = 'Промокод ' + code + ' применён: скидка ' + p.pct + '% (−' + p.disc + ' ₽)';
      } else {
        activePromo = null;
        document.getElementById('promoInfo').textContent = '❌ Промокод не найден';
      }
      updateBar();
    }

    async function sendOrder() {
      const uid = tg?.initDataUnsafe?.user?.id || new URLSearchParams(location.search).get('uid');
      const r = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, apps: [...sel], promo: activePromo })
      });
      const d = await r.json();
      if (tg) tg.close();
      else if (d.installUrl) location.href = d.installUrl;
    }

    load();
  </script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════
// 6. ЛОГИКА TELEGRAM-БОТА И АДМИН-ПАНЕЛИ (/admin)
// ═══════════════════════════════════════════════════════════
function ensureUser(from) {
  if (!from?.id) return;
  db.prepare(`
    INSERT INTO users (id, name, username, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username
  `).run(from.id, from.first_name || 'Клиент', from.username || null, Date.now());
}

function mainKeyboard() {
  return Markup.keyboard([
    ['✨ Каталог', '📦 Мои заказы'],
    ['👤 Кабинет', '📲 Привязать iPhone'],
    ['⭐️ Отзывы', '💬 Помощь'],
  ]).resize();
}

async function sendCatalogPrompt(ctx) {
  ensureUser(ctx.from);
  const count = db.prepare('SELECT COUNT(*) as c FROM apps').get().c;
  const appUrl = `${PUBLIC_URL}/app?uid=${ctx.from.id}`;

  return ctx.reply(
    `✨ *Каталог AppleIPA* · ${count} приложений\n` +
    `Иконки, поиск и корзина — в Mini App.\n\n` +
    `💳 *500 ₽ за приложение* · от 3 — по *425 ₽* за каждое\n` +
    `🔥 Чаще всего берут: СберБанк, Т-Банк, Альфа, WB Бизнес, ChatGPT\n\n` +
    `🌐 _Mini App не загружается из-за VPN? Нажми «В браузере»._`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('✨ Открыть каталог', appUrl)],
        [Markup.button.url('🌐 В браузере (Safari)', appUrl)],
      ]),
    }
  );
}

bot.start(async (ctx) => {
  ensureUser(ctx.from);
  await ctx.reply(
    `👋 Привет, *${ctx.from.first_name}*!\nДобро пожаловать в сервис установки приложений на iPhone без ПК.`,
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
  return sendCatalogPrompt(ctx);
});

bot.hears('✨ Каталог', sendCatalogPrompt);

bot.hears('📦 Мои заказы', async (ctx) => {
  const list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(ctx.from.id);
  if (!list.length) {
    return ctx.reply('📦 У тебя пока нет созданных заказов. Открой «✨ Каталог», чтобы выбрать приложения.');
  }

  for (const o of list) {
    const apps = JSON.parse(o.apps_json || '[]');
    const isPaid = o.status === 'paid';
    const installUrl = `${PUBLIC_URL}/install/${o.id}`;

    const rows = isPaid
      ? [[Markup.button.url('📲 Установить приложения (Safari)', installUrl)]]
      : [[Markup.button.callback(`💳 Оплатить ${o.total_price} ₽`, `order:pay:${o.id}`)]];

    await ctx.reply(
      `🧾 *Заказ #${o.id}*\n` +
      `📦 Приложений: *${apps.length} шт.*\n` +
      `💰 Сумма: *${o.total_price} ₽*\n` +
      `📡 Статус: *${isPaid ? '✅ Оплачен (Готов к установке)' : '⏳ Ожидает оплаты'}*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  }
});

bot.hears('👤 Кабинет', async (ctx) => {
  ensureUser(ctx.from);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
  const ordersCount = db.prepare('SELECT COUNT(*) as c FROM orders WHERE user_id = ?').get(ctx.from.id).c;
  const udidUrl = `${PUBLIC_URL}/udid/start/${ctx.from.id}`;

  return ctx.reply(
    `👤 *Личный кабинет*\n\n` +
    `🆔 Твой ID: \`${ctx.from.id}\`\n` +
    `📱 Модель iPhone: *${u?.device_model || 'Не привязан'}*\n` +
    `🔑 UDID: \`${u?.udid || 'Не определён'}\`\n` +
    `📦 Заказов: *${ordersCount}*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('📲 Определить UDID моего iPhone', udidUrl)],
      ]),
    }
  );
});

bot.hears('📲 Привязать iPhone', async (ctx) => {
  const udidUrl = `${PUBLIC_URL}/udid/start/${ctx.from.id}`;
  return ctx.reply(
    `📲 *Привязка твоего iPhone (UDID)*\n\n` +
    `1. Нажми кнопку ниже (откроется в **Safari**).\n` +
    `2. Нажми «Разрешить» во всплывающем окне.\n` +
    `3. Открой **Настройки iPhone → Профиль загружен → Установить**.\n\n` +
    `_Это стандартный профиль Apple: он за 5 секунд передаст боту твой UDID для подписи приложений и сам удалится._`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.url('🔗 Скачать профиль UDID (Safari)', udidUrl)]]),
    }
  );
});

bot.hears('💬 Помощь', (ctx) =>
  ctx.reply(
    `📖 *Как работает установка на iPhone:*\n\n` +
    `1️⃣ Выбираешь нужные приложения в **✨ Каталоге** (при выборе от 3 шт. цена снижается до 425 ₽/шт.).\n` +
    `2️⃣ Привязываешь свой iPhone кнопкой **📲 Привязать iPhone**.\n` +
    `3️⃣ Нажимаешь «Установить» в Safari — приложение сразу качается на домашний экран без компьютера!`,
    { parse_mode: 'Markdown' }
  )
);

bot.hears('⭐️ Отзывы', (ctx) =>
  ctx.reply('⭐️ Все приложения подписываются индивидуальным сертификатом под твой UDID и работают 365 дней без слётов!')
);

// Тестовая/ручная активация заказа по кнопке
bot.action(/^order:pay:([A-Z0-9]+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден', { show_alert: true });

  // Для демо сразу переводим заказ в статус оплаченного (сюда же подключается вебхук ЮMoney/СБП)
  db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(orderId);
  await ctx.answerCbQuery('✅ Оплата подтверждена!', { show_alert: true });

  const installUrl = `${PUBLIC_URL}/install/${orderId}`;
  return ctx.editMessageText(
    `✅ *Заказ #${orderId} успешно оплачен!*\n\n` +
    `Нажми кнопку ниже (открой в **Safari** на iPhone), чтобы установить выбранные приложения на рабочий стол:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('📲 Установить на iPhone (Safari)', installUrl)],
      ]),
    }
  );
});

// ─── Админка (/admin) ───
bot.command('admin', async (ctx) => {
  if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return;
  const usersCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const ordersCount = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const appsCount = db.prepare('SELECT COUNT(*) as c FROM apps').get().c;

  return ctx.reply(
    `🛠 *Админ-панель AppleIPA*\n\n` +
    `👥 Пользователей: *${usersCount}*\n` +
    `📦 Заказов: *${ordersCount}*\n` +
    `📲 Приложений в каталоге: *${appsCount}*\n` +
    `🌐 Текущий HTTPS Mini App:\n\`${PUBLIC_URL}/app\`\n\n` +
    `*Быстрые команды админа:*\n` +
    `• \`/addpromo КОД ПРОЦЕНТ\` — создать промокод (напр. \`/addpromo SALE20 20\`)\n` +
    `• \`/addapp ID|Имя|Категория|Версия|Иконка|BundleID|Файл.ipa\` — добавить приложение`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('addpromo', (ctx) => {
  if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return;
  const [, code, pct] = (ctx.message.text || '').split(/\s+/);
  if (!code || !Number(pct)) return ctx.reply('Формат: `/addpromo КОД 15`', { parse_mode: 'Markdown' });
  db.prepare('INSERT OR REPLACE INTO promos (code, discount_pct) VALUES (?, ?)').run(code.toUpperCase(), Number(pct));
  return ctx.reply(`✅ Промокод *${code.toUpperCase()}* на скидку *${pct}%* добавлен!`, { parse_mode: 'Markdown' });
});

bot.command('addapp', (ctx) => {
  if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return;
  const raw = (ctx.message.text || '').replace(/^\/addapp\s*/i, '');
  const parts = raw.split('|').map((s) => s.trim());
  if (parts.length < 7) {
    return ctx.reply('Формат:\n`/addapp vtb|ВТБ Онлайн|Банки|v18.1|🔵|ru.vtb24.mobilebanking|vtb.ipa`', { parse_mode: 'Markdown' });
  }
  db.prepare(`
    INSERT OR REPLACE INTO apps (id, name, category, version, icon, bundle_id, ipa_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]);
  return ctx.reply(`✅ Приложение *${parts[1]}* добавлено в Mini App каталог!`, { parse_mode: 'Markdown' });
});

// ═══════════════════════════════════════════════════════════
// 7. СТАРТ СЕРВЕРА, БЕСПЛАТНОГО HTTPS И БОТА
// ═══════════════════════════════════════════════════════════
(async () => {
  app.listen(PORT, async () => {
    console.log(`[HTTP] Сервер запущен на порту ${PORT}`);
    PUBLIC_URL = await startCloudflareTunnel(PORT);
    await bot.launch({ dropPendingUpdates: true });
    console.log(`🚀 Бот запущен! Каталог Mini App: ${PUBLIC_URL}/app`);
  });
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
