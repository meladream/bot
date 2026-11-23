/**
 * Telegram-бот магазина на Cloudflare Workers + D1 (без серверов и таблиц).
 *
 * Telegram присылает сообщения на /webhook, бот отвечает через Bot API.
 * Каталог, корзина и брони лежат в базе D1 (binding DB).
 * Админ управляет товарами и бронями кнопками прямо в Telegram.
 *
 * Секреты (Cloudflare → Settings → Variables and Secrets): BOT_TOKEN, WEBHOOK_SECRET.
 * Обычные настройки (SHOP_NAME, CURRENCY, MANAGER_USERNAME, ADMIN_IDS) — в wrangler.jsonc.
 */

const PAGE_SIZE = 8;

// ------------------------------------------------------------------ утилиты

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtPrice = (p) => (Number.isInteger(p) ? String(p) : Number(p).toFixed(2));
const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function parseNum(s) {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const v = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

const cur = (env) => env.CURRENCY || "₽";
const shopName = (env) => env.SHOP_NAME || "Наш магазин";
const manager = (env) => String(env.MANAGER_USERNAME || "").replace(/^@/, "");
const adminIds = (env) =>
  String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const isAdmin = (env, uid) => adminIds(env).includes(Number(uid));
/** Админ, который сейчас в админ-режиме (не переключился на вид покупателя). */
const asAdmin = async (env, uid) => isAdmin(env, uid) && !(await getSetting(env, `cv:${uid}`));

const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });
const kb = (rows) => ({ inline_keyboard: rows });

// ------------------------------------------------------------------ Telegram API

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let j = {};
  try { j = await r.json(); } catch { /* пустой ответ */ }
  if (!j.ok) console.log("Telegram error:", method, JSON.stringify(j));
  return j;
}

const send = (env, chat, text, markup) =>
  tg(env, "sendMessage", {
    chat_id: chat, text, parse_mode: "HTML", reply_markup: markup,
    disable_web_page_preview: true,
  });

const edit = (env, msg, text, markup) =>
  tg(env, "editMessageText", {
    chat_id: msg.chat.id, message_id: msg.message_id, text,
    parse_mode: "HTML", reply_markup: markup, disable_web_page_preview: true,
  });

const del = (env, msg) =>
  tg(env, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });

/** Показать экран: редактируем сообщение, а если там фото — шлём новое. */
async function show(env, msg, text, markup) {
  if (msg.photo) {
    await del(env, msg);
    return send(env, msg.chat.id, text, markup);
  }
  return edit(env, msg, text, markup);
}

const ack = (env, cb, text) =>
  tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text });

/** Всплывающее окно с «ОК». Возвращает true: «ответ на кнопку уже дан». */
async function warn(env, cb, text) {
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: true });
  return true;
}

/** Короткая подсказка внизу экрана. */
async function toast(env, cb, text) {
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text });
  return true;
}

// ------------------------------------------------------------------ база данных

let dbReady = false;
async function initDb(env) {
  if (dbReady) return;
  const q = (sql) => env.DB.prepare(sql);
  await env.DB.batch([
    q("CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, " +
      "photo TEXT NOT NULL DEFAULT '', parent_id INTEGER NOT NULL DEFAULT 0, UNIQUE(parent_id, name))"),
    q("CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, " +
      "name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, " +
      "description TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '')"),
    q("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY)"),
    q("CREATE TABLE IF NOT EXISTS states(user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')"),
    q("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    q("CREATE TABLE IF NOT EXISTS cart(user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, qty INTEGER NOT NULL, " +
      "PRIMARY KEY(user_id, product_id))"),
    q("CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, " +
      "username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', " +
      "status TEXT NOT NULL DEFAULT 'new', total REAL NOT NULL DEFAULT 0, bonus_spent INTEGER NOT NULL DEFAULT 0, " +
      "bonus_earned INTEGER NOT NULL DEFAULT 0, promo_code TEXT NOT NULL DEFAULT '', " +
      "promo_discount INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    q("CREATE TABLE IF NOT EXISTS promos(code TEXT PRIMARY KEY, kind TEXT NOT NULL, value INTEGER NOT NULL, " +
      "max_uses INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL DEFAULT '', " +
      "active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    q("CREATE TABLE IF NOT EXISTS promo_uses(code TEXT NOT NULL, user_id INTEGER NOT NULL, order_id INTEGER, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(code, user_id))"),
    q("CREATE TABLE IF NOT EXISTS user_promo(user_id INTEGER PRIMARY KEY, code TEXT NOT NULL)"),
    q("CREATE TABLE IF NOT EXISTS bonus_log(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, " +
      "delta INTEGER NOT NULL, reason TEXT NOT NULL, order_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    q("CREATE INDEX IF NOT EXISTS idx_bonus_user ON bonus_log(user_id)"),
    q("CREATE TABLE IF NOT EXISTS relay(admin_chat INTEGER NOT NULL, msg_id INTEGER NOT NULL, client_id INTEGER NOT NULL, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(admin_chat, msg_id))"),
    q("CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, " +
      "product_id INTEGER, name TEXT NOT NULL, price REAL NOT NULL, qty INTEGER NOT NULL)"),
  ]);
  // база, созданная старой версией, не имеет колонки photo у разделов
  try { await env.DB.prepare("ALTER TABLE categories ADD COLUMN photo TEXT NOT NULL DEFAULT ''").run(); }
  catch { /* колонка уже есть */ }
  // бонусные колонки у броней из прошлых версий
  for (const alter of [
    "ALTER TABLE orders ADD COLUMN bonus_spent INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN bonus_earned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN promo_code TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN promo_discount INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await env.DB.prepare(alter).run(); } catch { /* колонка уже есть */ }
  }
  // подразделы: у разделов из прошлых версий нет parent_id, пересобираем таблицу (id сохраняются)
  let needRebuild = false;
  try { await env.DB.prepare("SELECT parent_id FROM categories LIMIT 1").first(); }
  catch { needRebuild = true; }
  if (needRebuild) {
    try {
      await env.DB.batch([
        q("DROP TABLE IF EXISTS categories_new"),
        q("CREATE TABLE categories_new(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, " +
          "photo TEXT NOT NULL DEFAULT '', parent_id INTEGER NOT NULL DEFAULT 0, UNIQUE(parent_id, name))"),
        q("INSERT INTO categories_new(id, name, photo, parent_id) SELECT id, name, photo, 0 FROM categories"),
        q("DROP TABLE categories"),
        q("ALTER TABLE categories_new RENAME TO categories"),
      ]);
    } catch (e) {
      console.log("Не удалось обновить таблицу разделов:", e && e.stack ? e.stack : e);
    }
  }
  dbReady = true;
}

const all = async (env, sql, ...args) =>
  (await env.DB.prepare(sql).bind(...args).all()).results || [];
const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

const PRODUCT_SQL =
  "SELECT p.*, c.name AS category, c.photo AS cat_photo FROM products p JOIN categories c ON c.id = p.category_id";

const getProduct = (env, pid) => first(env, PRODUCT_SQL + " WHERE p.id = ?", pid);

const MAX_DEPTH = 3; // раздел → подраздел → подраздел подраздела

/** Дерево разделов: у каждого узла own (свои товары), total (с подразделами) и children. */
async function loadTree(env) {
  const cats = await all(env, "SELECT id, name, photo, parent_id FROM categories ORDER BY name");
  const counts = await all(env, "SELECT category_id, COUNT(*) AS n FROM products GROUP BY category_id");
  const own = new Map(counts.map((r) => [r.category_id, r.n]));
  const nodes = new Map(cats.map((c) => [c.id, { ...c, own: own.get(c.id) || 0, children: [], total: 0 }]));
  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : null;
    if (parent) parent.children.push(n);
    else roots.push(n); // и «осиротевшие» (родитель удалён) показываем как обычные разделы
  }
  const sum = (n) => (n.total = n.own + n.children.reduce((s, c) => s + sum(c), 0));
  roots.forEach(sum);
  return { nodes, roots };
}

const chain = (tree, id) => {
  const list = [];
  let n = tree.nodes.get(id);
  while (n && list.length < 10) { list.unshift(n); n = n.parent_id ? tree.nodes.get(n.parent_id) : null; }
  return list;
};
const depthOf = (tree, id) => chain(tree, id).length;
const pathOf = (tree, id) => chain(tree, id).map((n) => n.name).join(" › ");
/** Фото раздела; если у него нет своего, берём фото ближайшего родителя. */
const photoOf = (tree, id) => [...chain(tree, id)].reverse().find((n) => n.photo)?.photo || "";

/** Все разделы списком «Жидкости», «Жидкости › Солевые», … в порядке обхода дерева. */
function flatSections(tree) {
  const out = [];
  const walk = (n) => { out.push({ id: n.id, path: pathOf(tree, n.id) }); n.children.forEach(walk); };
  tree.roots.forEach(walk);
  return out;
}

/** Разделы верхнего уровня, в которых есть хоть один товар (на любой глубине). */
const catsWithProducts = async (env) =>
  (await loadTree(env)).roots.filter((r) => r.total > 0).map((r) => ({ id: r.id, name: r.name, n: r.total }));

const productsIn = (env, cid) =>
  all(env, PRODUCT_SQL + " WHERE p.category_id = ? ORDER BY (p.stock <= 0), p.name", cid);

async function searchProducts(env, text) {
  const t = text.toLowerCase();
  const rows = await all(env, PRODUCT_SQL + " ORDER BY (p.stock <= 0), p.name");
  return rows.filter((r) => r.name.toLowerCase().includes(t)).slice(0, 20);
}

async function ensureCategory(env, name, parentId = 0) {
  const row = await first(env, "SELECT id FROM categories WHERE name = ? AND parent_id = ?", name, parentId);
  if (row) return row.id;
  return (await run(env, "INSERT INTO categories(name, parent_id) VALUES (?, ?)", name, parentId)).meta.last_row_id;
}

const isConfirmed = async (env, uid) =>
  !!(await first(env, "SELECT 1 AS x FROM users WHERE id = ?", uid));

async function getState(env, uid) {
  const r = await first(env, "SELECT state, data FROM states WHERE user_id = ?", uid);
  return r ? { state: r.state, data: JSON.parse(r.data || "{}") } : null;
}
const setState = (env, uid, state, data = {}) =>
  run(env,
    "INSERT INTO states(user_id, state, data) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data",
    uid, state, JSON.stringify(data));
const clearState = (env, uid) => run(env, "DELETE FROM states WHERE user_id = ?", uid);

const getSetting = async (env, key) =>
  (await first(env, "SELECT value FROM settings WHERE key = ?", key))?.value || "";
const setSetting = (env, key, value) =>
  run(env, "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key, value);
const delSetting = (env, key) => run(env, "DELETE FROM settings WHERE key = ?", key);

// ------------------------------------------------------------------ корзина

const cartCount = async (env, uid) =>
  (await first(env, "SELECT COALESCE(SUM(qty), 0) AS n FROM cart WHERE user_id = ?", uid)).n;

/** Приводит корзину в порядок (удалённые товары, закончившийся остаток) и возвращает строки. */
async function cartRows(env, uid) {
  await run(env,
    "DELETE FROM cart WHERE user_id = ? AND (product_id NOT IN (SELECT id FROM products) " +
    "OR product_id IN (SELECT id FROM products WHERE stock <= 0))", uid);
  await run(env,
    "UPDATE cart SET qty = (SELECT stock FROM products WHERE id = cart.product_id) " +
    "WHERE user_id = ? AND qty > (SELECT stock FROM products WHERE id = cart.product_id)", uid);
  return all(env,
    "SELECT c.product_id, c.qty, p.name, p.price, p.stock FROM cart c " +
    "JOIN products p ON p.id = c.product_id WHERE c.user_id = ? ORDER BY c.rowid", uid);
}

async function cartView(env, uid) {
  const before = await cartCount(env, uid);
  const rows = await cartRows(env, uid);
  const after = rows.reduce((s, r) => s + r.qty, 0);
  const note = before !== after ? "\n⚠️ Наличие изменилось, корзина обновлена." : "";

  if (!rows.length) {
    return {
      text: "🧺 <b>Корзина пуста</b>" + note + "\n\nДобавьте товары из каталога кнопкой «🛒 В корзину».",
      markup: kb([[btn("📚 В каталог", "catalog")]]),
    };
  }
  const { total, promo, discount, net } = await cartTotals(env, uid, rows);
  const lines = rows.map((r, i) =>
    `${i + 1}. ${esc(r.name)} × ${r.qty} — ${fmtPrice(r.price * r.qty)} ${cur(env)}`);
  const earn = Math.floor((net * bonusPercent(env)) / 100);
  const promoLine = promo
    ? (promo.kind === "bonus" ? "" : `\n🏷 Промокод ${esc(promo.code)} (${promoLabel(env, promo)}): −${fmtPrice(discount)} ${cur(env)}` +
      `\n<b>К оплате: ${fmtPrice(net)} ${cur(env)}</b>`)
    : "";
  const text =
    "🧺 <b>Ваша корзина</b>\n\n" + lines.join("\n") +
    `\n\n<b>Итого: ${fmtPrice(total)} ${cur(env)}</b>` + promoLine + note +
    (earn > 0 ? `\n🎁 За эту бронь начислим бонусов: ~${earn}` : "") +
    "\n\nБронь на самовывоз, оплата при получении.";
  const mk = rows.map((r) => [
    btn("➖", `cart:dec:${r.product_id}`),
    btn(`${short(r.name)} ×${r.qty}`, "noop"),
    btn("➕", `cart:inc:${r.product_id}`),
  ]);
  mk.push([promo ? btn(`❌ Убрать промокод ${promo.code}`, "promo:drop") : btn("🏷 Промокод", "promo:enter")]);
  mk.push([btn("🗑 Очистить", "cart:clear"), btn("✅ Забронировать", "cart:go")]);
  mk.push([btn("📚 В каталог", "catalog")]);
  return { text, markup: kb(mk) };
}

// ------------------------------------------------------------------ промокоды

const PROMO_KINDS = { bonus: "🎁 Бонусы", percent: "🏷 Скидка %", fixed: "💵 Скидка суммой" };
const PROMO_FAIL_LIMIT = 5;           // неверных попыток подряд
const PROMO_FAIL_WINDOW_MS = 3600000; // и блокировка на час

const promoLabel = (env, p) =>
  p.kind === "bonus" ? `+${p.value} бонусов` : p.kind === "percent" ? `−${p.value}%` : `−${p.value} ${cur(env)}`;
const normCode = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
const validCode = (s) => /^[A-Z0-9_-]{3,20}$/.test(s);
const todayIso = () => new Date().toISOString().slice(0, 10);
const promoExpired = (p) => !!p.expires_at && p.expires_at < todayIso();

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (x) => alphabet[x % alphabet.length]).join("");
}

/** Скидка промокода на сумму (бонусные промокоды скидки не дают). */
function promoDiscount(p, total) {
  if (!p) return 0;
  const d = p.kind === "percent" ? Math.floor((total * p.value) / 100) : p.kind === "fixed" ? p.value : 0;
  return Math.max(0, Math.min(d, total));
}

const pendingPromo = (env, uid) =>
  first(env, "SELECT p.* FROM user_promo u JOIN promos p ON p.code = u.code WHERE u.user_id = ?", uid);

/** Суммы корзины: total — товары, discount — личная скидка по промокоду, net — после скидки. */
async function cartTotals(env, uid, rows = null) {
  rows = rows || (await cartRows(env, uid));
  const total = rows.reduce((s, r) => s + r.price * r.qty, 0);
  const promo = await pendingPromo(env, uid);
  const discount = promoDiscount(promo, total);
  return { total, promo, discount, net: total - discount };
}

/**
 * Вернуть промокод после отмены брони (restorePending) или когда клиент убрал его из корзины.
 * При возврате использование остаётся занятым за клиентом (лимит не превысится), если же
 * у клиента уже другой активный код или код удалён, использование освобождается.
 */
async function releasePromo(env, uid, code, restorePending) {
  if (restorePending && (await first(env, "SELECT 1 AS x FROM promos WHERE code = ?", code))) {
    const ins = await run(env, "INSERT OR IGNORE INTO user_promo(user_id, code) VALUES (?, ?)", uid, code);
    if (ins.meta.changes === 1) {
      await run(env, "UPDATE promo_uses SET order_id = NULL WHERE code = ? AND user_id = ?", code, uid);
      return true;
    }
  }
  const del = await run(env, "DELETE FROM promo_uses WHERE code = ? AND user_id = ?", code, uid);
  if (del.meta.changes === 1) await run(env, "UPDATE promos SET used = MAX(used - 1, 0) WHERE code = ?", code);
  return false;
}

/** Ввод промокода покупателем. Возвращает {ok, text}. */
async function redeemPromo(env, uid, raw) {
  const failKey = `pf:${uid}`;
  const [n0, ts0] = (await getSetting(env, failKey)).split("|").map(Number);
  const now = Date.now();
  const recent = ts0 && now - ts0 < PROMO_FAIL_WINDOW_MS;
  if (recent && n0 >= PROMO_FAIL_LIMIT) {
    return { ok: false, text: "⛔ Слишком много неверных кодов. Попробуйте через час." };
  }
  const fail = async (text) => {
    await setSetting(env, failKey, `${recent ? n0 + 1 : 1}|${recent ? ts0 : now}`);
    return { ok: false, text };
  };

  const code = normCode(raw);
  if (!validCode(code)) return fail("❌ Такого промокода нет. Проверьте написание.");
  const p = await first(env, "SELECT * FROM promos WHERE code = ?", code);
  if (!p || !p.active) return fail("❌ Такого промокода нет. Проверьте написание.");
  if (promoExpired(p)) return fail("⌛ Срок действия промокода закончился.");
  if (await first(env, "SELECT 1 AS x FROM promo_uses WHERE code = ? AND user_id = ?", code, uid)) {
    return { ok: false, text: "ℹ️ Вы уже использовали этот промокод." };
  }
  if (p.kind !== "bonus") {
    const pend = await first(env, "SELECT code FROM user_promo WHERE user_id = ?", uid);
    if (pend) {
      return { ok: false,
        text: `ℹ️ У вас уже есть активный промокод <b>${esc(pend.code)}</b>. Он применится к вашей брони, ` +
          "или уберите его в корзине, чтобы ввести другой." };
    }
  }

  // занимаем использование атомарно: сначала запись пользователя, затем счётчик с проверкой лимита
  const claim = await run(env, "INSERT OR IGNORE INTO promo_uses(code, user_id) VALUES (?, ?)", code, uid);
  if (claim.meta.changes !== 1) return { ok: false, text: "ℹ️ Вы уже использовали этот промокод." };
  const inc = await run(env,
    "UPDATE promos SET used = used + 1 WHERE code = ? AND active = 1 AND (max_uses = 0 OR used < max_uses)", code);
  if (inc.meta.changes !== 1) {
    await run(env, "DELETE FROM promo_uses WHERE code = ? AND user_id = ?", code, uid);
    return fail("😔 Промокод уже использовали максимальное число раз.");
  }
  await delSetting(env, failKey);

  if (p.kind === "bonus") {
    await bonusAdd(env, uid, p.value, "promo");
    return { ok: true,
      text: `🎉 Промокод <b>${esc(code)}</b> активирован!\nНачислено бонусов: <b>+${p.value}</b>.\n` +
        `Баланс: ${await bonusBalance(env, uid)}.` };
  }
  await run(env, "INSERT OR REPLACE INTO user_promo(user_id, code) VALUES (?, ?)", uid, code);
  return { ok: true,
    text: `🎉 Промокод <b>${esc(code)}</b> принят!\nВаша личная скидка: <b>${promoLabel(env, p)}</b> на следующую бронь. ` +
      "Она применится автоматически, посмотрите в корзине." };
}

const promoOkMarkup = () =>
  kb([[btn("🧺 Корзина", "cart:view"), btn("🛍 Каталог", "catalog")], [btn("🏠 Меню", "menu")]]);
const promoFailMarkup = () =>
  kb([[btn("🏷 Ввести другой", "promo:enter")], [btn("🏠 Меню", "menu")]]);

const PROMO_ASK = "🏷 <b>Промокод</b>\n\nОтправьте код одним сообщением. Бонусы начислим сразу, " +
  "а скидка применится к вашей следующей брони.\n\n/cancel — отмена";

// админ: список и карточка

async function promoListScreen(env) {
  const list = await all(env, "SELECT * FROM promos ORDER BY created_at DESC, code LIMIT 30");
  const rows = list.map((p) => [btn(
    `${p.active && !promoExpired(p) ? "🟢" : "⚪️"} ${p.code} · ${promoLabel(env, p)} · ${p.used}${p.max_uses ? "/" + p.max_uses : ""}`,
    `pr:view:${p.code}`)]);
  rows.push([btn("➕ Создать промокод", "pr:new")], [btn("⬅️ Админ-панель", "adm:panel")]);
  return {
    text: "🏷 <b>Промокоды</b>\n\n" + (list.length
      ? "🟢 действует, ⚪️ выключен или истёк. В конце: сколько раз использован."
      : "Пока нет ни одного. Создайте первый."),
    markup: kb(rows),
  };
}

async function promoCardScreen(env, code) {
  const p = await first(env, "SELECT * FROM promos WHERE code = ?", code);
  if (!p) return null;
  const left = p.max_uses ? `${p.used} из ${p.max_uses}` : `${p.used} (без ограничения)`;
  const status = !p.active ? "⚪️ выключен" : promoExpired(p) ? "⌛ истёк" : "🟢 действует";
  const text = `🏷 <b>${esc(p.code)}</b>\n\n` +
    `Тип: ${PROMO_KINDS[p.kind] || p.kind}\nЧто даёт: <b>${promoLabel(env, p)}</b>\n` +
    `Использований: ${left}\nДействует до: ${p.expires_at || "бессрочно"}\nСтатус: ${status}\n\n` +
    "Каждый клиент может использовать код один раз. Скидка личная: действует только у того, кто ввёл код.";
  return {
    text,
    markup: kb([
      [btn(p.active ? "⏸ Выключить" : "▶️ Включить", `pr:tog:${p.code}`), btn("🗑 Удалить", `pr:del:${p.code}`)],
      [btn("⬅️ К списку", "pr:list")],
    ]),
  };
}

// ------------------------------------------------------------------ бонусы

const bonusPercent = (env) => {
  const v = Number(env.BONUS_PERCENT ?? 5);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 5;
};
const bonusMaxPercent = (env) => {
  const v = Number(env.BONUS_MAX_PERCENT ?? 30);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 30;
};

const bonusBalance = async (env, uid) =>
  (await first(env, "SELECT COALESCE(SUM(delta), 0) AS b FROM bonus_log WHERE user_id = ?", uid)).b;

/** Сколько бонусов можно списать в этой брони. */
const maxSpend = (env, balance, total) =>
  Math.max(0, Math.min(balance, Math.floor((total * bonusMaxPercent(env)) / 100)));

const bonusAdd = (env, uid, delta, reason, orderId = null) =>
  run(env, "INSERT INTO bonus_log(user_id, delta, reason, order_id) VALUES (?, ?, ?, ?)",
    uid, delta, reason, orderId);

/** Списание одним запросом: проходит, только если на карте хватает бонусов (защита от двойной траты). */
async function bonusSpend(env, uid, amount, reason, orderId = null) {
  const r = await run(env,
    "INSERT INTO bonus_log(user_id, delta, reason, order_id) SELECT ?, ?, ?, ? " +
    "WHERE (SELECT COALESCE(SUM(delta), 0) FROM bonus_log WHERE user_id = ?) >= ?",
    uid, -amount, reason, orderId, uid, amount);
  return r.meta.changes === 1;
}

const BONUS_REASONS = {
  earn: "начислено за бронь",
  spend: "списано в брони",
  refund: "возврат по брони",
  manual: "корректировка магазина",
  promo: "промокод",
};

async function bonusScreen(env, uid) {
  const bal = await bonusBalance(env, uid);
  const st = await first(env,
    "SELECT COUNT(*) AS n, COALESCE(SUM(total - promo_discount - bonus_spent), 0) AS s FROM orders WHERE user_id = ? AND status = 'done'", uid);
  const log = await all(env,
    "SELECT delta, reason, order_id FROM bonus_log WHERE user_id = ? ORDER BY id DESC LIMIT 5", uid);
  const pct = bonusPercent(env);
  const lines = [
    `💳 <b>Бонусная карта</b> № ${String(uid).slice(-6).padStart(6, "0")}`,
    "",
    `🎁 Баланс: <b>${bal}</b> бонусов`,
    `🛍 Выдано броней: ${st.n} на ${fmtPrice(st.s)} ${esc(cur(env))}`,
    "",
  ];
  if (pct > 0) lines.push(`✨ Возвращаем ${pct}% бонусами с каждой выданной брони.`);
  lines.push(`💳 1 бонус = 1 ${esc(cur(env))}. Бонусами можно оплатить до ${bonusMaxPercent(env)}% стоимости брони.`);
  if (log.length) {
    lines.push("", "<b>Последние операции</b>");
    for (const r of log) {
      const sign = r.delta > 0 ? `+${r.delta}` : `−${-r.delta}`;
      const ref = r.order_id ? ` №${r.order_id}` : "";
      lines.push(`${sign} · ${BONUS_REASONS[r.reason] || r.reason}${ref}`);
    }
  }
  return { text: lines.join("\n"), markup: kb([[btn("🛍 В каталог", "catalog")], [btn("🏠 Меню", "menu")]]) };
}

// ------------------------------------------------------------------ чат клиент ↔ магазин

const SUPPORT_GAP_MS = 5000; // защита от потока сообщений от одного клиента
const SUPPORT_MAX_TEXT = 1500;

/** Писать магазину можно, пока у клиента есть активная бронь: новая или подтверждённая. */
const hasOrders = async (env, uid) =>
  !!(await first(env,
    "SELECT 1 AS x FROM orders WHERE user_id = ? AND status IN ('new', 'confirmed') LIMIT 1", uid));

/** Кнопки под списком «Мои брони»: «Связаться с магазином» только если есть брони. */
const ordersMarkup = async (env, uid) =>
  kb((await hasOrders(env, uid))
    ? [[btn("📚 В каталог", "catalog")], [btn("✉️ Связаться с магазином", "sup:start")]]
    : [[btn("📚 В каталог", "catalog")]]);

const supportMarkup = () =>
  kb([[btn("✉️ Написать ещё", "sup:start")], [btn("🏠 Меню", "menu")]]);

/** Сообщение клиента → всем админам. Возвращает, скольким доставлено. */
async function forwardToAdmins(env, m) {
  const u = m.from;
  const lastOrder = await first(env, "SELECT id, status FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1", u.id);
  const who = `<a href="tg://user?id=${u.id}">${esc(u.first_name || "клиент")}</a>` +
    (u.username ? ` (@${esc(u.username)})` : "") + ` · ID ${u.id}`;
  const orderLine = lastOrder ? `\n🧾 Последняя бронь №${lastOrder.id}: ${STATUS[lastOrder.status] || lastOrder.status}` : "";
  const head = `💬 <b>Сообщение от клиента</b>\n${who}${orderLine}`;
  const markup = kb([[btn("↩️ Ответить", `rep:${u.id}`)]]);

  await run(env, "DELETE FROM relay WHERE created_at < datetime('now', '-30 days')");
  let delivered = 0;
  for (const aid of adminIds(env)) {
    try {
      const ids = [];
      if (m.text) {
        const body = m.text.length > SUPPORT_MAX_TEXT ? m.text.slice(0, SUPPORT_MAX_TEXT) + "…" : m.text;
        const r = await send(env, aid, `${head}\n\n${esc(body)}`, markup);
        if (r.ok && r.result?.message_id) ids.push(r.result.message_id);
      } else {
        const h = await send(env, aid, head);
        if (h.ok && h.result?.message_id) ids.push(h.result.message_id);
        const c = await tg(env, "copyMessage", {
          chat_id: aid, from_chat_id: m.chat.id, message_id: m.message_id, reply_markup: markup,
        });
        if (c.ok && c.result?.message_id) ids.push(c.result.message_id);
        else if (c.ok) ids.push(0);
      }
      for (const id of ids.filter(Boolean)) {
        await run(env, "INSERT OR REPLACE INTO relay(admin_chat, msg_id, client_id) VALUES (?, ?, ?)", aid, id, u.id);
      }
      if (ids.length) delivered++;
    } catch (e) {
      console.log("Не удалось переслать админу", aid, e);
    }
  }
  return delivered;
}

/** Ответ админа → клиенту. Остальным админам тоже показываем, кто и что ответил. */
async function replyToClient(env, clientId, m) {
  const markup = kb((await hasOrders(env, clientId))
    ? [[btn("✉️ Ответить магазину", "sup:start")], [btn("🏠 Меню", "menu")]]
    : [[btn("🏠 Меню", "menu")]]);
  let r;
  if (m.text) {
    const body = m.text.length > 3500 ? m.text.slice(0, 3500) + "…" : m.text;
    r = await send(env, clientId, `💬 <b>Магазин:</b>\n${esc(body)}`, markup);
  } else {
    await send(env, clientId, "💬 <b>Магазин:</b>");
    r = await tg(env, "copyMessage", {
      chat_id: clientId, from_chat_id: m.chat.id, message_id: m.message_id, reply_markup: markup,
    });
  }
  if (!r.ok) return false;
  const note = `↪️ ${esc(m.from.first_name || "Админ")} ответил клиенту ${clientId}:\n` +
    (m.text ? esc(m.text.length > 500 ? m.text.slice(0, 500) + "…" : m.text) : "(вложение)");
  for (const aid of adminIds(env)) {
    if (aid !== m.from.id) {
      try { await send(env, aid, note); } catch { /* админ мог не открывать бота */ }
    }
  }
  return true;
}

async function adminReplyResult(env, chat, ok) {
  return send(env, chat, ok
    ? "✅ Отправлено клиенту."
    : "⚠️ Не доставлено: клиент мог заблокировать бота.");
}

// ------------------------------------------------------------------ брони

const STATUS = {
  new: "🆕 Новая",
  confirmed: "✅ Подтверждена",
  done: "📦 Выдана",
  cancelled: "❌ Отменена",
};
const STATUS_USER = {
  new: "🆕 ждёт подтверждения",
  confirmed: "✅ подтверждена, ждёт вас",
  done: "📦 выдана",
  cancelled: "❌ отменена",
};

function userLink(o) {
  const name = esc(o.first_name || "клиент");
  const tag = o.username ? ` (@${esc(o.username)})` : "";
  return `<a href="tg://user?id=${o.user_id}">${name}</a>${tag}`;
}

async function orderText(env, o, admin) {
  const items = await all(env, "SELECT name, price, qty FROM order_items WHERE order_id = ? ORDER BY id", o.id);
  const lines = items.map((i, n) =>
    `${n + 1}. ${esc(i.name)} × ${i.qty} — ${fmtPrice(i.price * i.qty)} ${cur(env)}`);
  const parts = [`🧾 <b>Бронь №${o.id}</b> · ${STATUS[o.status] || o.status}`, ""];
  if (admin) parts.push(`👤 ${userLink(o)}`, `📞 ${esc(o.contact)}`, "");
  parts.push(...lines, "", `<b>Итого: ${fmtPrice(o.total)} ${cur(env)}</b>`);
  if (o.promo_discount > 0) parts.push(`🏷 Промокод ${esc(o.promo_code)}: −${fmtPrice(o.promo_discount)} ${cur(env)}`);
  if (o.bonus_spent > 0) parts.push(`🎁 Оплачено бонусами: −${o.bonus_spent} ${cur(env)}`);
  if (o.bonus_spent > 0 || o.promo_discount > 0) {
    parts.push(`<b>К оплате: ${fmtPrice(o.total - o.promo_discount - o.bonus_spent)} ${cur(env)}</b>`);
  }
  if (o.bonus_earned > 0) parts.push(`✨ Начислено бонусов: +${o.bonus_earned}`);
  if (!admin) parts.push("", "Самовывоз, оплата при получении.");
  return parts.join("\n");
}

function orderButtons(o) {
  const rows = [];
  if (o.status === "new") {
    rows.push([btn("✅ Подтвердить", `ord:${o.id}:confirm`), btn("❌ Отменить", `ord:${o.id}:cancel`)]);
  } else if (o.status === "confirmed") {
    rows.push([btn("📦 Выдан", `ord:${o.id}:done`), btn("❌ Отменить", `ord:${o.id}:cancel`)]);
  }
  rows.push([btn("✉️ Написать клиенту", `rep:${o.user_id}`)]);
  rows.push([btn("📋 Все брони", "adm:orders")]);
  return kb(rows);
}

async function myOrdersText(env, uid) {
  const orders = await all(env, "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 5", uid);
  if (!orders.length) return "📋 <b>Мои брони</b>\n\nПока нет ни одной брони.";
  const ids = orders.map((o) => o.id);
  const items = await all(env,
    `SELECT order_id, name, qty FROM order_items WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
    ...ids);
  const blocks = orders.map((o) => {
    const list = items.filter((i) => i.order_id === o.id).map((i) => `${esc(i.name)} ×${i.qty}`).join(", ");
    return `<b>№${o.id}</b> · ${fmtPrice(o.total)} ${cur(env)} · ${STATUS_USER[o.status] || o.status}` +
      (o.promo_discount > 0 ? ` · 🏷 −${fmtPrice(o.promo_discount)}` : "") +
      (o.bonus_spent > 0 ? ` · 🎁 −${o.bonus_spent}` : "") +
      (o.bonus_earned > 0 ? ` · ✨ +${o.bonus_earned}` : "") + `\n${list}`;
  });
  return "📋 <b>Мои брони</b>\n\n" + blocks.join("\n\n");
}

async function placeOrder(env, m, contact, wantSpend = 0) {
  const uid = m.from.id;
  const chat = m.chat.id;
  await clearState(env, uid);

  const rows = await cartRows(env, uid);
  if (!rows.length) {
    return send(env, chat, "Корзина пуста.", kb([[btn("📚 В каталог", "catalog")]]));
  }

  // резервируем остаток; если что-то не получилось, откатываем уже зарезервированное
  const reserved = [];
  let failed = null;
  for (const r of rows) {
    const res = await run(env,
      "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", r.qty, r.product_id, r.qty);
    if (res.meta.changes === 1) reserved.push(r);
    else { failed = r; break; }
  }
  if (failed) {
    for (const r of reserved) {
      await run(env, "UPDATE products SET stock = stock + ? WHERE id = ?", r.qty, r.product_id);
    }
    return send(env, chat,
      `😔 Пока вы оформляли бронь, «${esc(failed.name)}» закончился в нужном количестве. Проверьте корзину.`,
      kb([[btn("🧺 Корзина", "cart:view")]]));
  }

  const total = rows.reduce((s, r) => s + r.price * r.qty, 0);
  // личный промокод: забираем одним запросом, чтобы при двойной отправке скидка не применилась дважды
  let promo = null;
  let discount = 0;
  const pend = await pendingPromo(env, uid);
  if (pend) {
    const taken = await run(env, "DELETE FROM user_promo WHERE user_id = ?", uid);
    if (taken.meta.changes === 1) { promo = pend; discount = promoDiscount(pend, total); }
  }
  const net = total - discount;
  const spend = wantSpend > 0
    ? Math.min(wantSpend, maxSpend(env, await bonusBalance(env, uid), net)) : 0;
  const res = await run(env,
    "INSERT INTO orders(user_id, username, first_name, contact, status, total, promo_code, promo_discount) " +
    "VALUES (?, ?, ?, ?, 'new', ?, ?, ?)",
    uid, m.from.username || "", m.from.first_name || "", contact, total, promo ? promo.code : "", discount);
  const oid = res.meta.last_row_id;
  if (promo) await run(env, "UPDATE promo_uses SET order_id = ? WHERE code = ? AND user_id = ?", oid, promo.code, uid);
  await env.DB.batch(rows.map((r) =>
    env.DB.prepare("INSERT INTO order_items(order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)")
      .bind(oid, r.product_id, r.name, r.price, r.qty)));
  await run(env, "DELETE FROM cart WHERE user_id = ?", uid);

  let spendNote = "";
  if (spend > 0) {
    if (await bonusSpend(env, uid, spend, "spend", oid)) {
      await run(env, "UPDATE orders SET bonus_spent = ? WHERE id = ?", spend, oid);
    } else {
      spendNote = "\n\n⚠️ Бонусы списать не получилось (на карте не хватило), оплата полной суммой.";
    }
  }

  const o = await first(env, "SELECT * FROM orders WHERE id = ?", oid);
  await send(env, chat,
    `✅ <b>Бронь №${oid} принята!</b>\n\n` + (await orderText(env, o, false)) + spendNote +
    "\n\nМенеджер скоро свяжется с вами. Статус смотрите в «📋 Мои брони».",
    kb([[btn("📋 Мои брони", "my")], [btn("✉️ Связаться с магазином", "sup:start")], [btn("📚 В каталог", "catalog")]]));

  const adminText = "🔔 <b>Новая бронь!</b>\n\n" + (await orderText(env, o, true));
  for (const id of adminIds(env)) {
    try { await send(env, id, adminText, orderButtons(o)); }
    catch (e) { console.log("Не удалось уведомить админа", id, e); }
  }
}

async function orderCallback(env, cb, id, act) {
  const msg = cb.message;
  const o = await first(env, "SELECT * FROM orders WHERE id = ?", id);
  if (!o) return warn(env, cb, "Бронь не найдена");

  if (act === "view") {
    await show(env, msg, await orderText(env, o, true), orderButtons(o));
    return;
  }

  const rule = {
    confirm: { to: "confirmed", from: ["new"] },
    done: { to: "done", from: ["new", "confirmed"] },
    cancel: { to: "cancelled", from: ["new", "confirmed"] },
  }[act];
  if (!rule) return;

  const res = await run(env,
    `UPDATE orders SET status = ? WHERE id = ? AND status IN (${rule.from.map(() => "?").join(",")})`,
    rule.to, id, ...rule.from);
  let fresh = await first(env, "SELECT * FROM orders WHERE id = ?", id);
  if (res.meta.changes !== 1) {
    await show(env, msg, await orderText(env, fresh, true), orderButtons(fresh));
    return warn(env, cb, "Статус уже изменён");
  }

  let extra = "";
  if (rule.to === "cancelled") {
    const items = await all(env, "SELECT product_id, qty FROM order_items WHERE order_id = ?", id);
    for (const it of items) {
      if (it.product_id != null) {
        await run(env, "UPDATE products SET stock = stock + ? WHERE id = ?", it.qty, it.product_id);
      }
    }
    if (o.bonus_spent > 0) {
      await bonusAdd(env, o.user_id, o.bonus_spent, "refund", id);
      extra = `\n🎁 Списанные бонусы (${o.bonus_spent}) вернулись на карту.`;
    }
    if (o.promo_code) {
      if (await releasePromo(env, o.user_id, o.promo_code, true)) {
        extra += `\n🏷 Промокод ${o.promo_code} вернулся: скидка применится к новой брони.`;
      }
    }
  }
  if (rule.to === "done") {
    const earned = Math.floor(((o.total - o.promo_discount - o.bonus_spent) * bonusPercent(env)) / 100);
    if (earned > 0) {
      await bonusAdd(env, o.user_id, earned, "earn", id);
      await run(env, "UPDATE orders SET bonus_earned = ? WHERE id = ?", earned, id);
      extra = `\n✨ Начислено бонусов: +${earned}. Баланс: ${await bonusBalance(env, o.user_id)}.`;
    }
  }
  fresh = await first(env, "SELECT * FROM orders WHERE id = ?", id);
  await show(env, msg, await orderText(env, fresh, true), orderButtons(fresh));

  const notice = {
    confirmed: `✅ Бронь №${id} подтверждена. Товар ждёт вас, приходите за ним.`,
    done: `📦 Бронь №${id} выдана. Спасибо за покупку!`,
    cancelled: `❌ Бронь №${id} отменена. Если это ошибка, свяжитесь с менеджером.`,
  }[rule.to] + extra;
  const noticeRows = [[btn("📋 Мои брони", "my")]];
  if (await hasOrders(env, o.user_id)) noticeRows.push([btn("✉️ Связаться с магазином", "sup:start")]);
  await send(env, o.user_id, notice, kb(noticeRows));
}

// ------------------------------------------------------------------ внешний вид

const AGE_TEXT = "🔞 Каталог только для лиц старше 18 лет.\nВам уже исполнилось 18?";
const ADMIN_TEXT =
  "⚙️ <b>Админ-панель</b>\n\n" +
  "Чтобы изменить товар, откройте его в каталоге: под карточкой появятся кнопки " +
  "управления (остаток, цена, описание, фото товара и раздела, перемещение, удаление).\n\n" +
  "📂 Разделы и подразделы: откройте «Каталог» → раздел. Там кнопки «➕ Подраздел», «➕ Товар сюда», " +
  "переименование, фото и удаление раздела (удалить можно только пустой).\n\n" +
  "Новые брони приходят сюда сообщением с кнопками статуса. " +
  "Чтобы они приходили, один раз нажмите /start у бота.\n\n" +
  "💬 Сообщения клиентов тоже приходят сюда. Ответьте на них функцией Telegram «Ответить» " +
  "(или кнопкой «↩️ Ответить»), и текст уйдёт клиенту.\n\n" +
  "/active — активные брони\n/banner — главная картинка магазина (меню и каталог)\n" +
  "/user — посмотреть бота глазами покупателя (вернуться: /admin)\n" +
  "/bonus ID — баланс клиента, /bonus ID +100 или -50 — начислить или списать\n" +
  "/promos — промокоды (создать, выключить, удалить)\n/stats — статистика\n/export — выгрузить товары файлом\n/cancel — отменить ввод";

const adminPanel = () =>
  kb([
    [btn("➕ Добавить товар", "adm:add")],
    [btn("📋 Активные брони", "adm:orders")],
    [btn("🏷 Промокоды", "pr:list")],
    [btn("👁 Режим покупателя", "adm:off")],
    [btn("📚 Открыть каталог", "menu")],
  ]);

const askAge = (env, chat) =>
  send(env, chat, AGE_TEXT,
    kb([[btn("Да, мне есть 18", "age:yes"), btn("Нет", "age:no")]]));

const welcomeText = (env) =>
  env.WELCOME_TEXT || "Добро пожаловать! Здесь можно посмотреть каталог и забронировать товар для самовывоза.";

async function menuText(env) {
  const head = `✨ <b>${esc(shopName(env))}</b> ✨\n\n`;
  if (!(await catsWithProducts(env)).length) return head + "Каталог пока пуст.";
  return head + esc(welcomeText(env)) + "\n\n🔎 Ищете что-то конкретное? Просто напишите название товара.";
}

async function mainMenu(env, uid) {
  const n = await cartCount(env, uid);
  const rows = [
    [btn("🛍 Каталог", "catalog")],
    [btn(n ? `🛒 Забронировать (${n})` : "🛒 Забронировать", "cart:view")],
    [btn("📋 Мои брони", "my"), btn(`🎁 Бонусы: ${await bonusBalance(env, uid)}`, "bonus")],
    [btn("🏷 Промокод", "promo:enter")],
  ];
  if (await hasOrders(env, uid)) rows.push([btn("✉️ Связаться с магазином", "sup:start")]);
  if (manager(env)) rows.push([urlBtn("💬 Менеджер", `https://t.me/${manager(env)}`)]);
  if (await asAdmin(env, uid)) rows.push([btn("⚙️ Админ-панель", "adm:panel")]);
  else if (isAdmin(env, uid)) rows.push([btn("⚙️ Вернуться в админ-режим", "adm:on")]);
  return kb(rows);
}

/**
 * Показать экран на месте текущего сообщения. С картинкой: если там уже фото,
 * заменяем его, иначе удаляем сообщение и шлём новое. Без картинки: обычный текст.
 */
async function screen(env, msg, text, markup, photo) {
  if (!photo) return show(env, msg, text, markup);
  if (msg.photo) {
    const r = await tg(env, "editMessageMedia", {
      chat_id: msg.chat.id, message_id: msg.message_id,
      media: { type: "photo", media: photo, caption: text, parse_mode: "HTML" },
      reply_markup: markup,
    });
    if (r.ok || /not modified/i.test(r.description || "")) return r;
  }
  await del(env, msg);
  const r = await tg(env, "sendPhoto", {
    chat_id: msg.chat.id, photo, caption: text, parse_mode: "HTML", reply_markup: markup,
  });
  if (r.ok) return r;
  return send(env, msg.chat.id, text, markup);
}

/** Главное меню новым сообщением (с картинкой-баннером, если админ её задал). */
async function sendMenu(env, chat, uid) {
  const text = await menuText(env);
  const markup = await mainMenu(env, uid);
  const banner = await getSetting(env, "banner");
  if (banner) {
    const r = await tg(env, "sendPhoto", {
      chat_id: chat, photo: banner, caption: text, parse_mode: "HTML", reply_markup: markup,
    });
    if (r.ok) return;
  }
  return send(env, chat, text, markup);
}

/** Главное меню на месте текущего сообщения. */
async function showMenu(env, msg, uid) {
  return screen(env, msg, await menuText(env), await mainMenu(env, uid), await getSetting(env, "banner"));
}

/** Экран «Каталог»: выбор раздела верхнего уровня. Админ видит и пустые разделы. */
async function catalogView(env, uid) {
  const tree = await loadTree(env);
  const admin = await asAdmin(env, uid);
  const roots = admin ? tree.roots : tree.roots.filter((r) => r.total > 0);
  const n = await cartCount(env, uid);
  const rows = roots.map((c) => [btn(`${c.name} (${c.total})`, `sec:${c.id}`)]);
  if (admin) rows.push([btn("➕ Раздел", "subnew:0")]);
  rows.push([btn(n ? `🛒 Забронировать (${n})` : "🛒 Забронировать", "cart:view"), btn("🏠 Меню", "menu")]);
  const text = roots.length
    ? "🛍 <b>Каталог</b>\n\nВыберите раздел 👇"
    : "🛍 <b>Каталог</b>\n\nПока пусто." + (admin ? "\nСоздайте первый раздел кнопкой «➕ Раздел»." : "");
  return { text, markup: kb(rows), photo: await getSetting(env, "banner") };
}

/** Экран раздела: подразделы, кнопка «Товары» и (для админа) управление разделом. */
async function sectionView(env, id, uid, tree = null) {
  tree = tree || (await loadTree(env));
  const n = tree.nodes.get(id);
  if (!n) return null;
  const admin = await asAdmin(env, uid);
  const kids = admin ? n.children : n.children.filter((c) => c.total > 0);
  const rows = kids.map((c) => [btn(`${c.name} (${c.total})`, `sec:${c.id}`)]);
  if (n.own > 0) rows.push([btn(`📦 Товары раздела (${n.own})`, `pg:${id}:0`)]);
  if (admin) {
    const add = [btn("➕ Товар сюда", `addcat:${id}`)];
    if (depthOf(tree, id) < MAX_DEPTH) add.unshift(btn("➕ Подраздел", `subnew:${id}`));
    rows.push(add);
    rows.push([btn("✏️ Название", `snm:${id}`), btn("🖼 Фото", `catph:${id}`)]);
    rows.push([btn("🗑 Удалить раздел", `sdel:${id}`)]);
  }
  rows.push([
    btn("⬅️ Назад", n.parent_id && tree.nodes.has(n.parent_id) ? `sec:${n.parent_id}` : "catalog"),
    btn("🏠 Меню", "menu"),
  ]);
  let hint = "";
  if (kids.length && n.own) hint = "\n\nВыберите подраздел или откройте товары 👇";
  else if (kids.length) hint = "\n\nВыберите подраздел 👇";
  else if (!n.own) hint = "\n\nРаздел пока пуст. Добавьте подраздел или товар.";
  return {
    text: `📂 <b>${esc(pathOf(tree, id))}</b>${hint}`,
    markup: kb(rows),
    photo: photoOf(tree, id) || (await getSetting(env, "banner")),
  };
}

/** Отправить готовый экран новым сообщением. */
async function sendView(env, chat, v) {
  if (v.photo) {
    const r = await tg(env, "sendPhoto", {
      chat_id: chat, photo: v.photo, caption: v.text, parse_mode: "HTML", reply_markup: v.markup,
    });
    if (r.ok) return r;
  }
  return send(env, chat, v.text, v.markup);
}

const showCatalog = async (env, msg, uid) => {
  const v = await catalogView(env, uid);
  return screen(env, msg, v.text, v.markup, v.photo);
};

const productLine = (env, p) =>
  `${p.stock > 0 ? "" : "❌ "}${p.name} — ${fmtPrice(p.price)} ${cur(env)}`;

function productText(env, p) {
  let stock;
  if (p.stock <= 0) stock = "❌ Нет в наличии";
  else if (p.stock <= 3) stock = `⚠️ Осталось ${p.stock} шт.`;
  else stock = `✅ В наличии: ${p.stock} шт.`;
  const parts = [
    `<b>${esc(p.name)}</b>`,
    `<i>${esc(p.path || p.category)}</i>`,
    "",
    `💰 <b>${fmtPrice(p.price)} ${esc(cur(env))}</b>`,
    stock,
  ];
  if (p.description) parts.push("", esc(p.description));
  return parts.join("\n");
}

/** Карточка товара. i — номер в разделе (листание ◀️ ▶️) или -1 (без листания, например из поиска). */
async function cardView(env, p, admin, uid, i) {
  const n = await cartCount(env, uid);
  const tree = await loadTree(env);
  const rows = [];
  rows.push([p.stock > 0 ? btn("🛒 В корзину", `add:${p.id}:${i}`) : btn("❌ Нет в наличии", "noop")]);
  if (n > 0) rows.push([btn(`🧺 Забронировать (${n})`, "cart:view")]);
  if (i >= 0) {
    const total = (await first(env, "SELECT COUNT(*) AS n FROM products WHERE category_id = ?", p.category_id)).n;
    if (total > 1) {
      rows.push([
        btn("◀️", `pg:${p.category_id}:${(i - 1 + total) % total}`),
        btn(`${i + 1} / ${total}`, "noop"),
        btn("▶️", `pg:${p.category_id}:${(i + 1) % total}`),
      ]);
    }
  }
  if (manager(env)) {
    rows.push([urlBtn("💬 Спросить менеджера",
      `https://t.me/${manager(env)}?text=${encodeURIComponent("Вопрос по товару: " + p.name)}`)]);
  }
  if (admin) {
    rows.push([btn("➖ 1 шт.", `stk:${p.id}:-1:${i}`), btn("➕ 1 шт.", `stk:${p.id}:1:${i}`)]);
    rows.push([btn("✏️ Название", `ed:name:${p.id}`), btn("💰 Цена", `ed:price:${p.id}`)]);
    rows.push([btn("📦 Остаток", `ed:stock:${p.id}`), btn("📝 Описание", `ed:desc:${p.id}`)]);
    rows.push([btn("🖼 Фото товара", `ed:photo:${p.id}`), btn("🗑 Удалить", `del:${p.id}`)]);
    rows.push([btn("📂 Переместить", `mv:${p.id}`), btn("🖼 Фото раздела", `catph:${p.category_id}`)]);
  }
  // назад: админу на экран раздела; покупателю на экран раздела, если там есть подразделы, иначе уровнем выше
  const node = tree.nodes.get(p.category_id);
  let back = "catalog";
  if (admin || (node && node.children.some((c) => c.total > 0))) back = `sec:${p.category_id}`;
  else if (node && node.parent_id && tree.nodes.has(node.parent_id)) back = `sec:${node.parent_id}`;
  rows.push([btn("⬅️ Назад", back), btn("📚 Каталог", "catalog"), btn("🏠 Меню", "menu")]);
  // у товара нет своего фото — показываем фото его раздела (или ближайшего родителя)
  return {
    text: productText(env, { ...p, path: pathOf(tree, p.category_id) }),
    markup: kb(rows),
    photo: p.photo || photoOf(tree, p.category_id),
  };
}

async function sendCard(env, chat, p, i = -1, admin = false) {
  const v = await cardView(env, p, admin, chat, i);
  if (v.photo) {
    const r = await tg(env, "sendPhoto", {
      chat_id: chat, photo: v.photo, caption: v.text, parse_mode: "HTML", reply_markup: v.markup,
    });
    if (r.ok) return r;
  }
  return send(env, chat, v.text, v.markup);
}

async function screenCard(env, msg, p, i, admin, uid) {
  const v = await cardView(env, p, admin, uid, i);
  return screen(env, msg, v.text, v.markup, v.photo);
}

async function refreshCard(env, msg, p, i, admin, uid) {
  const v = await cardView(env, p, admin, uid, i);
  if (msg.photo) {
    return tg(env, "editMessageCaption", {
      chat_id: msg.chat.id, message_id: msg.message_id, caption: v.text,
      parse_mode: "HTML", reply_markup: v.markup,
    });
  }
  return edit(env, msg, v.text, v.markup);
}

// ------------------------------------------------------------------ сообщения

async function onMessage(env, m) {
  if (!m.chat || m.chat.type !== "private" || !m.from) return;
  const uid = m.from.id;
  const chat = m.chat.id;
  const text = (m.text || "").trim();

  if (text.startsWith("/")) return onCommand(env, m, text.split(/[\s@]/)[0].toLowerCase());

  // админ отвечает на сообщение клиента обычным «Ответить» в Telegram
  if (m.reply_to_message && isAdmin(env, uid)) {
    const rel = await first(env, "SELECT client_id FROM relay WHERE admin_chat = ? AND msg_id = ?",
      chat, m.reply_to_message.message_id);
    if (rel) {
      await clearState(env, uid);
      return adminReplyResult(env, chat, await replyToClient(env, rel.client_id, m));
    }
  }

  const st = await getState(env, uid);
  if (st) return onState(env, m, st);

  if (!text) return;
  if (!(await isConfirmed(env, uid))) return askAge(env, chat);

  if (text.length < 2) return send(env, chat, "Введите минимум 2 символа для поиска.");
  const found = await searchProducts(env, text);
  if (!found.length) {
    return send(env, chat, "Ничего не найдено. Попробуйте другое слово.", await mainMenu(env, uid));
  }
  const rows = found.map((p) => [btn(productLine(env, p), `item:${p.id}:-1`)]);
  rows.push([btn("⬅️ В меню", "menu")]);
  return send(env, chat, `Найдено: ${found.length}`, kb(rows));
}

async function activeOrdersScreen(env) {
  const orders = await all(env,
    "SELECT * FROM orders WHERE status IN ('new', 'confirmed') ORDER BY id DESC LIMIT 15");
  const rows = orders.map((o) => [btn(
    `№${o.id} · ${short(o.first_name || "клиент", 12)} · ${fmtPrice(o.total)} ${cur(env)} · ${o.status === "new" ? "🆕" : "✅"}`,
    `ord:${o.id}:view`)]);
  rows.push([btn("⬅️ Админ-панель", "adm:panel")]);
  return {
    text: orders.length ? `📋 <b>Активные брони (${orders.length})</b>` : "📋 Активных броней нет.",
    markup: kb(rows),
  };
}

async function onCommand(env, m, cmd) {
  const uid = m.from.id;
  const chat = m.chat.id;
  const admin = isAdmin(env, uid);

  switch (cmd) {
    case "/start":
      await clearState(env, uid);
      if (!(await isConfirmed(env, uid))) return askAge(env, chat);
      return sendMenu(env, chat, uid);
    case "/bonus": {
      const parts = (m.text || "").trim().split(/\s+/);
      if (admin && parts.length >= 2) {
        const target = Number(parts[1]);
        if (!Number.isInteger(target) || target <= 0) {
          return send(env, chat, "Формат: /bonus ID_клиента — баланс\n/bonus ID_клиента +100 — начислить\n/bonus ID_клиента -50 — списать");
        }
        if (parts.length >= 3) {
          const n = Number(parts[2].replace(",", "."));
          if (!Number.isInteger(n) || n === 0) return send(env, chat, "Сумма — целое число, например +100 или -50.");
          if (n > 0) await bonusAdd(env, target, n, "manual");
          else if (!(await bonusSpend(env, target, -n, "manual"))) {
            return send(env, chat, `У клиента ${target} меньше ${-n} бонусов, списать нельзя.`);
          }
          try {
            await send(env, target, `🎁 Магазин ${n > 0 ? "начислил вам" : "списал с вашей карты"} ${Math.abs(n)} бонусов. ` +
              `Баланс: ${await bonusBalance(env, target)}.`);
          } catch { /* клиент мог не открывать бота */ }
        }
        return send(env, chat, `🎁 Клиент ${target}: ${await bonusBalance(env, target)} бонусов.`);
      }
      if (!admin && !(await isConfirmed(env, uid))) return askAge(env, chat);
      const s = await bonusScreen(env, uid);
      return send(env, chat, s.text, s.markup);
    }
    case "/id":
      return send(env, chat, `Ваш Telegram ID: <code>${uid}</code>`);
    case "/cancel":
      await clearState(env, uid);
      return send(env, chat, "Отменено.");
    case "/promo": {
      if (!(await isConfirmed(env, uid))) return askAge(env, chat);
      const arg = (m.text || "").trim().split(/\s+/)[1];
      if (!arg) {
        await setState(env, uid, "promo_enter", {});
        return send(env, chat, PROMO_ASK);
      }
      const r = await redeemPromo(env, uid, arg);
      return send(env, chat, r.text, r.ok ? promoOkMarkup() : promoFailMarkup());
    }
    case "/promos": {
      if (!admin) return;
      const s = await promoListScreen(env);
      return send(env, chat, s.text, s.markup);
    }
    case "/orders":
      if (!(await isConfirmed(env, uid))) return askAge(env, chat);
      return send(env, chat, await myOrdersText(env, uid), await ordersMarkup(env, uid));
    case "/active": {
      if (!admin) return;
      const s = await activeOrdersScreen(env);
      return send(env, chat, s.text, s.markup);
    }
    case "/admin":
      if (!admin) return;
      await clearState(env, uid);
      await delSetting(env, `cv:${uid}`);
      return send(env, chat, ADMIN_TEXT, adminPanel());
    case "/user":
      if (!admin) return;
      await clearState(env, uid);
      await setSetting(env, `cv:${uid}`, "1");
      await send(env, chat, "👁 Режим покупателя включён. Вернуться в админ-режим: /admin");
      return sendMenu(env, chat, uid);
    case "/banner":
      if (!admin) return;
      await setState(env, uid, "banner", {});
      return send(env, chat,
        "Отправьте картинку для главного экрана (или «-», чтобы убрать).\n/cancel — отмена");
    case "/stats": {
      if (!admin) return;
      const t = await first(env, "SELECT COUNT(*) AS n FROM products");
      const o = await first(env, "SELECT COUNT(*) AS n FROM products WHERE stock <= 0");
      const u = await first(env, "SELECT COUNT(*) AS n FROM users");
      const a = await first(env, "SELECT COUNT(*) AS n FROM orders WHERE status IN ('new', 'confirmed')");
      const c = await catsWithProducts(env);
      return send(env, chat,
        `Товаров: ${t.n} (нет в наличии: ${o.n})\nКатегорий: ${c.length}\n` +
        `Активных броней: ${a.n}\nПодтвердили 18+: ${u.n}`);
    }
    case "/export": {
      if (!admin) return;
      const rows = await all(env, PRODUCT_SQL + " ORDER BY c.name, p.name");
      const fd = new FormData();
      fd.append("chat_id", String(chat));
      fd.append("document", new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
        "shop-export.json");
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
      return;
    }
  }
}

// ------------------------------------------------------------------ диалоги

const EDIT_PROMPTS = {
  name: "Введите новое название:",
  price: "Введите новую цену (число):",
  stock: "Введите новый остаток (целое число):",
  desc: "Введите новое описание (или «-», чтобы убрать):",
  photo: "Отправьте новое фото (или «-», чтобы убрать):",
};
const EDIT_COLUMNS = { name: "name", price: "price", stock: "stock", desc: "description", photo: "photo" };

async function onState(env, m, st) {
  const uid = m.from.id;
  const chat = m.chat.id;
  const text = (m.text || "").trim();
  const d = st.data;

  // диалог покупателя: контакты для брони
  if (st.state === "order_contact") {
    if (text.length < 5) {
      return send(env, chat, "Напишите имя и телефон одним сообщением, например:\nИван, +7 900 000-00-00");
    }
    return placeOrder(env, m, text.slice(0, 200), Number(d.spend) || 0);
  }

  // диалог покупателя: ввод промокода
  if (st.state === "promo_enter") {
    await clearState(env, uid);
    if (!text) return send(env, chat, PROMO_ASK);
    const r = await redeemPromo(env, uid, text);
    return send(env, chat, r.text, r.ok ? promoOkMarkup() : promoFailMarkup());
  }

  // диалог покупателя: сообщение магазину
  if (st.state === "support") {
    if (!(await hasOrders(env, uid))) {
      await clearState(env, uid);
      return send(env, chat,
        "Писать магазину можно, пока у вас есть активная бронь. Выберите товар и забронируйте его.",
        kb([[btn("🛍 Каталог", "catalog")], [btn("🏠 Меню", "menu")]]));
    }
    const last = Number(await getSetting(env, `sup:${uid}`)) || 0;
    if (Date.now() - last < SUPPORT_GAP_MS) {
      return send(env, chat, "⏳ Слишком часто. Подождите несколько секунд и отправьте сообщение ещё раз.");
    }
    await setSetting(env, `sup:${uid}`, String(Date.now()));
    const n = await forwardToAdmins(env, m);
    await clearState(env, uid);
    if (!n) {
      return send(env, chat, "😔 Не получилось доставить сообщение. Попробуйте позже.",
        kb([[btn("🏠 Меню", "menu")]]));
    }
    return send(env, chat, "✅ Сообщение отправлено магазину. Ответ придёт сюда, в этот чат.", supportMarkup());
  }

  // остальные диалоги только для админов
  if (!isAdmin(env, uid)) {
    await clearState(env, uid);
    return;
  }

  switch (st.state) {
    case "promo_code": {
      let code = normCode(text);
      if (text === "-") code = randomCode();
      if (!validCode(code)) {
        return send(env, chat, "Код: латинские буквы, цифры, «_» или «-», от 3 до 20 знаков. Или «-» для случайного.");
      }
      if (await first(env, "SELECT 1 AS x FROM promos WHERE code = ?", code)) {
        return send(env, chat, "Такой код уже есть. Введите другой.");
      }
      await setState(env, uid, "promo_kind", { code });
      return send(env, chat, `Код: <b>${esc(code)}</b>\nЧто будет давать промокод?`,
        kb([[btn(PROMO_KINDS.bonus, "pr:kind:bonus")], [btn(PROMO_KINDS.percent, "pr:kind:percent")],
          [btn(PROMO_KINDS.fixed, "pr:kind:fixed")], [btn("✖️ Отмена", "adm:cancel")]]));
    }
    case "promo_value": {
      const n = Number(text.replace(",", "."));
      const max = d.kind === "percent" ? 90 : 1000000;
      if (!Number.isInteger(n) || n < 1 || n > max) {
        return send(env, chat, `Введите целое число от 1 до ${max}.`);
      }
      await setState(env, uid, "promo_limit", { ...d, value: n });
      return send(env, chat, "Сколько человек смогут использовать код? Число, или 0 — без ограничения.");
    }
    case "promo_limit": {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0 || n > 1000000) return send(env, chat, "Введите целое число, 0 — без ограничения.");
      await setState(env, uid, "promo_days", { ...d, max: n });
      return send(env, chat, "Сколько дней действует код? Число дней, или 0 — бессрочно.");
    }
    case "promo_days": {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0 || n > 3650) return send(env, chat, "Введите целое число дней, 0 — бессрочно.");
      const expires = n > 0 ? new Date(Date.now() + n * 86400000).toISOString().slice(0, 10) : "";
      const ins = await run(env,
        "INSERT OR IGNORE INTO promos(code, kind, value, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)",
        d.code, d.kind, d.value, d.max, expires);
      await clearState(env, uid);
      if (ins.meta.changes !== 1) return send(env, chat, "Такой код уже есть. Начните заново: /promos");
      await send(env, chat, "✅ Промокод создан. Сообщите его клиентам.");
      const s = await promoCardScreen(env, d.code);
      return send(env, chat, s.text, s.markup);
    }
    case "reply": {
      const ok = await replyToClient(env, d.client, m);
      await clearState(env, uid);
      return adminReplyResult(env, chat, ok);
    }
    case "banner": {
      if (m.photo) await setSetting(env, "banner", m.photo[m.photo.length - 1].file_id);
      else if (text === "-") await delSetting(env, "banner");
      else return send(env, chat, "Отправьте картинку или «-».");
      await clearState(env, uid);
      await send(env, chat, "✅ Готово. Так теперь выглядит главный экран:");
      return sendMenu(env, chat, uid);
    }
    case "catphoto": {
      let photo;
      if (m.photo) photo = m.photo[m.photo.length - 1].file_id;
      else if (text === "-") photo = "";
      else return send(env, chat, "Отправьте фото или «-».");
      await run(env, "UPDATE categories SET photo = ? WHERE id = ?", photo, d.cid);
      await clearState(env, uid);
      return send(env, chat, "✅ Фото раздела сохранено.", kb([[btn("📂 Открыть раздел", `sec:${d.cid}`)]]));
    }
    case "add_newcat": {
      const name = text.slice(0, 40);
      if (!name) return send(env, chat, "Введите название раздела.");
      const cid = await ensureCategory(env, name, 0);
      await setState(env, uid, "add_name", { cid });
      return send(env, chat, `Раздел «${esc(name)}» готов.\nВведите название товара:`);
    }
    case "sec_new": {
      const name = text.slice(0, 40);
      if (!name) return send(env, chat, "Введите название.");
      const parent = Number(d.parent) || 0;
      if (await first(env, "SELECT 1 AS x FROM categories WHERE name = ? AND parent_id = ?", name, parent)) {
        return send(env, chat, "Такой раздел здесь уже есть. Введите другое название.");
      }
      const id = await ensureCategory(env, name, parent);
      await clearState(env, uid);
      await send(env, chat, "✅ Раздел создан.");
      return sendView(env, chat, await sectionView(env, id, uid));
    }
    case "sec_rename": {
      const name = text.slice(0, 40);
      if (!name) return send(env, chat, "Введите название.");
      const row = await first(env, "SELECT parent_id FROM categories WHERE id = ?", d.cid);
      if (!row) { await clearState(env, uid); return send(env, chat, "Раздел уже удалён."); }
      if (await first(env, "SELECT 1 AS x FROM categories WHERE name = ? AND parent_id = ? AND id != ?",
        name, row.parent_id, d.cid)) {
        return send(env, chat, "Раздел с таким названием здесь уже есть. Введите другое.");
      }
      await run(env, "UPDATE categories SET name = ? WHERE id = ?", name, d.cid);
      await clearState(env, uid);
      await send(env, chat, "✅ Название изменено.");
      return sendView(env, chat, await sectionView(env, d.cid, uid));
    }
    case "add_name": {
      const name = text.slice(0, 100);
      if (!name) return send(env, chat, "Введите название товара.");
      await setState(env, uid, "add_price", { ...d, name });
      return send(env, chat, `Цена, ${esc(cur(env))} (число):`);
    }
    case "add_price": {
      const price = parseNum(text);
      if (price === null) return send(env, chat, "Нужно число, например 450.");
      await setState(env, uid, "add_stock", { ...d, price });
      return send(env, chat, "Остаток на складе (целое число):");
    }
    case "add_stock": {
      const n = parseNum(text);
      if (n === null) return send(env, chat, "Нужно целое число, например 10.");
      await setState(env, uid, "add_desc", { ...d, stock: Math.floor(n) });
      return send(env, chat, "Описание (или «-», если не нужно):");
    }
    case "add_desc":
      await setState(env, uid, "add_photo", { ...d, desc: text === "-" ? "" : text.slice(0, 600) });
      return send(env, chat, "Отправьте фото товара (или «-», если без фото):");
    case "add_photo": {
      let photo;
      if (m.photo) photo = m.photo[m.photo.length - 1].file_id;
      else if (text === "-") photo = "";
      else return send(env, chat, "Отправьте фото или «-».");
      const cid = d.cid || (await ensureCategory(env, d.category || "Прочее", 0));
      if (!(await first(env, "SELECT 1 AS x FROM categories WHERE id = ?", cid))) {
        await clearState(env, uid);
        return send(env, chat, "Этот раздел уже удалён. Начните заново: /admin");
      }
      const res = await run(env,
        "INSERT INTO products(category_id, name, price, stock, description, photo) VALUES (?, ?, ?, ?, ?, ?)",
        cid, d.name, d.price, d.stock, d.desc, photo);
      await clearState(env, uid);
      await send(env, chat, "✅ Товар добавлен. Ещё один — /admin");
      return sendCard(env, chat, await getProduct(env, res.meta.last_row_id), -1, true);
    }
    case "edit": {
      const { field, pid } = d;
      if (!EDIT_COLUMNS[field] || !(await getProduct(env, pid))) {
        await clearState(env, uid);
        return send(env, chat, "Товар уже удалён.");
      }
      let value;
      if (field === "photo") {
        if (m.photo) value = m.photo[m.photo.length - 1].file_id;
        else if (text === "-") value = "";
        else return send(env, chat, "Отправьте фото или «-».");
      } else if (field === "price" || field === "stock") {
        const n = parseNum(text);
        if (n === null) return send(env, chat, "Нужно число, например 450.");
        value = field === "stock" ? Math.floor(n) : n;
      } else if (field === "desc") {
        value = text === "-" ? "" : text.slice(0, 600);
      } else {
        if (!text) return send(env, chat, "Название не может быть пустым.");
        value = text.slice(0, 100);
      }
      await run(env, `UPDATE products SET ${EDIT_COLUMNS[field]} = ? WHERE id = ?`, value, pid);
      await clearState(env, uid);
      await send(env, chat, "✅ Обновлено");
      return sendCard(env, chat, await getProduct(env, pid), -1, true);
    }
    default:
      await clearState(env, uid);
  }
}

// ------------------------------------------------------------------ кнопки

const ADMIN_ACTIONS = ["adm", "stk", "del", "delok", "ed", "addcat", "ord", "catph", "rep",
  "subnew", "snm", "sdel", "sdelok", "mv", "mvto", "pr"];

async function onCallback(env, cb) {
  const answered = await route(env, cb);
  if (!answered) await ack(env, cb);
}

async function route(env, cb) {
  const msg = cb.message;
  if (!msg) return;
  const uid = cb.from.id;
  const [a, b, c, d] = (cb.data || "").split(":");

  if (a === "noop") return;

  if (a === "age") {
    if (b === "no") {
      await edit(env, msg, "Доступ закрыт. Возвращайтесь, когда исполнится 18.");
      return;
    }
    await run(env, "INSERT OR IGNORE INTO users(id) VALUES (?)", uid);
    await showMenu(env, msg, uid);
    return;
  }

  if (ADMIN_ACTIONS.includes(a)) {
    if (!isAdmin(env, uid)) return warn(env, cb, "Нет доступа");
    return adminCallback(env, cb, a, b, c, d);
  }

  if (!(await isConfirmed(env, uid))) return warn(env, cb, "Нажмите /start");

  switch (a) {
    case "menu":
      await clearState(env, uid);
      await showMenu(env, msg, uid);
      return;
    case "catalog":
      await showCatalog(env, msg, uid);
      return;
    case "sec":
      return showSection(env, cb, Number(b));
    case "promo": {
      if (b === "drop") {
        const pend = await first(env, "SELECT code FROM user_promo WHERE user_id = ?", uid);
        if (pend) {
          await run(env, "DELETE FROM user_promo WHERE user_id = ?", uid);
          await releasePromo(env, uid, pend.code, false);
        }
        const v = await cartView(env, uid);
        await show(env, msg, v.text, v.markup);
        return toast(env, cb, "Промокод убран");
      }
      await setState(env, uid, "promo_enter", {});
      await send(env, msg.chat.id, PROMO_ASK);
      return;
    }
    case "pg":
      return showPager(env, cb, Number(b), Number(c));
    case "cat": // старые кнопки из прошлых версий
      return showPager(env, cb, Number(b), 0);
    case "item":
      return openItem(env, cb, Number(b), Number(c));
    case "add":
      return addToCart(env, cb, Number(b), Number(c));
    case "cart":
      return cartAction(env, cb, b, Number(c));
    case "sup":
      if (!(await hasOrders(env, uid))) {
        return warn(env, cb, "Написать магазину можно, пока у вас есть активная бронь. Выберите товар и забронируйте его.");
      }
      await setState(env, uid, "support", {});
      await send(env, msg.chat.id,
        "✉️ <b>Сообщение магазину</b>\n\nНапишите одним сообщением, что хотите узнать. Можно приложить фото. " +
        "Ответ придёт сюда, в этот чат.\n\n/cancel — отмена");
      return;
    case "bonus": {
      const s = await bonusScreen(env, uid);
      await show(env, msg, s.text, s.markup);
      return;
    }
    case "bon": {
      const rows = await cartRows(env, uid);
      if (!rows.length) return toast(env, cb, "Корзина пуста");
      const { net: total } = await cartTotals(env, uid, rows);
      const spend = b === "use" ? maxSpend(env, await bonusBalance(env, uid), total) : 0;
      await askContact(env, msg.chat.id, uid, spend, total, msg);
      return;
    }
    case "my":
      await show(env, msg, await myOrdersText(env, uid), await ordersMarkup(env, uid));
      return;
  }
}

/** Открыть раздел: покупателю сразу товары, если подразделов нет; админу всегда экран раздела. */
async function showSection(env, cb, id) {
  const uid = cb.from.id;
  const tree = await loadTree(env);
  const n = tree.nodes.get(id);
  const admin = await asAdmin(env, uid);
  if (!n || (!admin && n.total === 0)) {
    await warn(env, cb, "Раздел пуст или изменился");
    await showCatalog(env, cb.message, uid);
    return true;
  }
  if (!admin && !n.children.some((c) => c.total > 0)) return showPager(env, cb, id, 0);
  const v = await sectionView(env, id, uid, tree);
  await screen(env, cb.message, v.text, v.markup, v.photo);
}

async function showPager(env, cb, cid, i) {
  const uid = cb.from.id;
  const items = await productsIn(env, cid);
  if (!items.length) {
    await warn(env, cb, "Раздел пуст или изменился");
    await showMenu(env, cb.message, uid);
    return true;
  }
  const n = items.length;
  i = (((Number.isFinite(i) ? i : 0) % n) + n) % n;
  await screenCard(env, cb.message, items[i], i, await asAdmin(env, uid), uid);
}

async function openItem(env, cb, pid, i) {
  const uid = cb.from.id;
  const p = await getProduct(env, pid);
  if (!p) {
    await warn(env, cb, "Товар больше недоступен");
    await showMenu(env, cb.message, uid);
    return true;
  }
  await screenCard(env, cb.message, p, Number.isFinite(i) ? i : -1, await asAdmin(env, uid), uid);
}

async function addToCart(env, cb, pid, i) {
  const uid = cb.from.id;
  const p = await getProduct(env, pid);
  if (!p || p.stock <= 0) return warn(env, cb, "Этого товара уже нет в наличии");
  const row = await first(env, "SELECT qty FROM cart WHERE user_id = ? AND product_id = ?", uid, pid);
  const qty = row ? row.qty : 0;
  if (qty + 1 > p.stock) return toast(env, cb, `В наличии только ${p.stock} шт., они уже в корзине`);
  await run(env,
    "INSERT INTO cart(user_id, product_id, qty) VALUES (?, ?, 1) " +
    "ON CONFLICT(user_id, product_id) DO UPDATE SET qty = qty + 1", uid, pid);
  await refreshCard(env, cb.message, p, Number.isFinite(i) ? i : -1, await asAdmin(env, uid), uid);
  return toast(env, cb, `Добавлено в корзину ✅ (${qty + 1} шт.)`);
}

/** Запросить имя и телефон для брони (spend — сколько бонусов спишем). */
async function askContact(env, chat, uid, spend, total, msg = null) {
  await setState(env, uid, "order_contact", { spend });
  const t = await cartTotals(env, uid);
  total = t.net;
  const promoNote = t.discount > 0 ? `\n\n🏷 Промокод ${esc(t.promo.code)}: −${fmtPrice(t.discount)} ${esc(cur(env))}, к оплате ${fmtPrice(t.net)} ${esc(cur(env))}.` : "";
  const pay = promoNote + (spend > 0
    ? `\n\n🎁 Бонусами оплатим <b>${spend} ${esc(cur(env))}</b>, к оплате <b>${fmtPrice(total - spend)} ${esc(cur(env))}</b>.`
    : "");
  const text =
    "📝 <b>Оформление брони</b>" + pay +
    "\n\nНапишите одним сообщением, как к вам обращаться и ваш телефон, например:\n" +
    "<i>Иван, +7 900 000-00-00</i>\n\n/cancel — отмена";
  return msg ? edit(env, msg, text) : send(env, chat, text);
}

async function cartAction(env, cb, act, pid) {
  const uid = cb.from.id;
  const msg = cb.message;
  let answered = false;

  if (act === "inc") {
    const p = await getProduct(env, pid);
    const row = await first(env, "SELECT qty FROM cart WHERE user_id = ? AND product_id = ?", uid, pid);
    if (!p || !row || row.qty + 1 > p.stock) answered = await toast(env, cb, "Больше нет в наличии");
    else await run(env, "UPDATE cart SET qty = qty + 1 WHERE user_id = ? AND product_id = ?", uid, pid);
  } else if (act === "dec") {
    await run(env, "UPDATE cart SET qty = qty - 1 WHERE user_id = ? AND product_id = ?", uid, pid);
    await run(env, "DELETE FROM cart WHERE user_id = ? AND qty <= 0", uid);
  } else if (act === "clear") {
    await run(env, "DELETE FROM cart WHERE user_id = ?", uid);
  } else if (act === "go") {
    const rows = await cartRows(env, uid);
    if (!rows.length) return toast(env, cb, "Корзина пуста");
    const { net: total } = await cartTotals(env, uid, rows);
    const bal = await bonusBalance(env, uid);
    const ms = maxSpend(env, bal, total);
    if (ms > 0) {
      await send(env, msg.chat.id,
        `🎁 <b>Бонусы</b>\n\nНа вашей карте <b>${bal}</b> бонусов. Ими можно оплатить до ` +
        `<b>${ms} ${esc(cur(env))}</b> из ${fmtPrice(total)} ${esc(cur(env))} (не больше ${bonusMaxPercent(env)}% брони).\n\nСписать?`,
        kb([[btn(`💳 Списать ${ms}`, "bon:use"), btn("Не списывать", "bon:no")]]));
      return;
    }
    await askContact(env, msg.chat.id, uid, 0, total);
    return;
  }

  const v = await cartView(env, uid);
  await show(env, msg, v.text, v.markup);
  return answered || undefined;
}

async function adminCallback(env, cb, a, b, c, d) {
  const msg = cb.message;
  const uid = cb.from.id;
  const chat = msg.chat.id;

  switch (a) {
    case "pr": {
      if (b === "list") {
        await clearState(env, uid);
        const s = await promoListScreen(env);
        await show(env, msg, s.text, s.markup);
        return;
      }
      if (b === "new") {
        await setState(env, uid, "promo_code", {});
        await send(env, chat, "🏷 Введите код (латиница, цифры, «_», «-», 3–20 знаков) или «-», чтобы придумать случайный.\n/cancel — отмена");
        return;
      }
      if (b === "kind") {
        const stt = await getState(env, uid);
        if (!stt || stt.state !== "promo_kind" || !PROMO_KINDS[c]) return warn(env, cb, "Начните заново: /promos");
        await setState(env, uid, "promo_value", { code: stt.data.code, kind: c });
        await send(env, chat, c === "bonus"
          ? "Сколько бонусов начислять за ввод кода? (целое число)"
          : c === "percent" ? "Сколько процентов скидки? (1–90)" : `Размер скидки в ${esc(cur(env))}? (целое число)`);
        return;
      }
      const p = await first(env, "SELECT * FROM promos WHERE code = ?", c || "");
      if (!p) return warn(env, cb, "Промокод не найден");
      if (b === "tog") await run(env, "UPDATE promos SET active = 1 - active WHERE code = ?", p.code);
      if (b === "del") {
        await show(env, msg, `Удалить промокод <b>${esc(p.code)}</b>? Неиспользованные личные скидки клиентов тоже пропадут.`,
          kb([[btn("🗑 Да, удалить", `pr:delok:${p.code}`), btn("Отмена", `pr:view:${p.code}`)]]));
        return;
      }
      if (b === "delok") {
        await run(env, "DELETE FROM promos WHERE code = ?", p.code);
        await run(env, "DELETE FROM user_promo WHERE code = ?", p.code);
        await run(env, "DELETE FROM promo_uses WHERE code = ? AND order_id IS NULL", p.code);
        const s = await promoListScreen(env);
        await show(env, msg, s.text, s.markup);
        return;
      }
      const s = await promoCardScreen(env, p.code);
      await show(env, msg, s.text, s.markup);
      return;
    }
    case "adm": {
      await clearState(env, uid);
      if (b === "off") {
        await setSetting(env, `cv:${uid}`, "1");
        await toast(env, cb, "Режим покупателя. Вернуться: /admin");
        await showMenu(env, msg, uid);
        return true;
      }
      if (b === "on") {
        await delSetting(env, `cv:${uid}`);
        await show(env, msg, ADMIN_TEXT, adminPanel());
        return;
      }
      if (b === "add") {
        const rows = flatSections(await loadTree(env)).map((x) => [btn(x.path, `addcat:${x.id}`)]);
        rows.push([btn("➕ Новый раздел", "addcat:new")], [btn("✖️ Отмена", "adm:cancel")]);
        await show(env, msg, "В какой раздел добавить товар?", kb(rows));
      } else if (b === "orders") {
        const s = await activeOrdersScreen(env);
        await show(env, msg, s.text, s.markup);
      } else {
        await show(env, msg, ADMIN_TEXT, adminPanel());
      }
      return;
    }
    case "ord":
      return orderCallback(env, cb, Number(b), c);
    case "rep": {
      const cid = Number(b);
      if (!Number.isInteger(cid) || cid <= 0) return warn(env, cb, "Клиент не найден");
      await setState(env, uid, "reply", { client: cid });
      await send(env, chat,
        `✍️ Пишите ответ клиенту (ID ${cid}). Ваше следующее сообщение уйдёт ему, можно с фото.\n/cancel — отмена`);
      return;
    }
    case "catph": {
      const row = await first(env, "SELECT name FROM categories WHERE id = ?", Number(b));
      if (!row) return warn(env, cb, "Раздел не найден");
      await setState(env, uid, "catphoto", { cid: Number(b) });
      await send(env, chat,
        `Отправьте фото для раздела «${esc(row.name)}» (или «-», чтобы убрать).\n` +
        "Оно показывается у товаров этого раздела, у которых нет своего фото.\n/cancel — отмена");
      return;
    }
    case "stk": {
      const pid = Number(b);
      if (!(await getProduct(env, pid))) return warn(env, cb, "Товар не найден");
      await run(env, "UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?", Number(c), pid);
      await refreshCard(env, msg, await getProduct(env, pid), Number.isFinite(Number(d)) ? Number(d) : -1, true, uid);
      return;
    }
    case "del": {
      const p = await getProduct(env, Number(b));
      if (!p) return warn(env, cb, "Товар не найден");
      await show(env, msg, `Удалить «${esc(p.name)}»? Это необратимо.`,
        kb([[btn("🗑 Да, удалить", `delok:${p.id}`), btn("Отмена", `item:${p.id}:-1`)]]));
      return;
    }
    case "delok": {
      await run(env, "DELETE FROM products WHERE id = ?", Number(b));
      await show(env, msg, "🗑 Товар удалён.\n\n" + (await menuText(env)), await mainMenu(env, uid));
      return;
    }
    case "ed": {
      if (!EDIT_PROMPTS[b] || !(await getProduct(env, Number(c)))) return warn(env, cb, "Товар не найден");
      await setState(env, uid, "edit", { field: b, pid: Number(c) });
      await send(env, chat, EDIT_PROMPTS[b] + "\n/cancel — отмена");
      return;
    }
    case "addcat": {
      if (b === "new") {
        await setState(env, uid, "add_newcat", {});
        await send(env, chat,
          "Введите название новой категории. Можно с эмодзи, например: 💨 Испарители\n/cancel — отмена");
        return;
      }
      const tree = await loadTree(env);
      if (!tree.nodes.has(Number(b))) return warn(env, cb, "Раздел не найден");
      await setState(env, uid, "add_name", { cid: Number(b) });
      await send(env, chat, `Раздел: ${esc(pathOf(tree, Number(b)))}\nВведите название товара:`);
      return;
    }
    case "subnew": {
      const parent = Number(b) || 0;
      if (parent) {
        const tree = await loadTree(env);
        if (!tree.nodes.has(parent)) return warn(env, cb, "Раздел не найден");
        if (depthOf(tree, parent) >= MAX_DEPTH) return warn(env, cb, `Больше ${MAX_DEPTH} уровней вложенности нельзя`);
        await setState(env, uid, "sec_new", { parent });
        await send(env, chat, `Введите название подраздела в «${esc(pathOf(tree, parent))}»:\n/cancel — отмена`);
        return;
      }
      await setState(env, uid, "sec_new", { parent: 0 });
      await send(env, chat, "Введите название нового раздела. Можно с эмодзи, например: 💨 Испарители\n/cancel — отмена");
      return;
    }
    case "snm": {
      const tree = await loadTree(env);
      if (!tree.nodes.has(Number(b))) return warn(env, cb, "Раздел не найден");
      await setState(env, uid, "sec_rename", { cid: Number(b) });
      await send(env, chat, `Новое название для «${esc(pathOf(tree, Number(b)))}»:\n/cancel — отмена`);
      return;
    }
    case "sdel": {
      const tree = await loadTree(env);
      const n = tree.nodes.get(Number(b));
      if (!n) return warn(env, cb, "Раздел не найден");
      if (n.own > 0 || n.children.length > 0) {
        return warn(env, cb, "Раздел не пуст. Сначала удалите или перенесите его товары и подразделы.");
      }
      await show(env, msg, `Удалить раздел «${esc(pathOf(tree, n.id))}»?`,
        kb([[btn("🗑 Да, удалить", `sdelok:${n.id}`), btn("Отмена", `sec:${n.id}`)]]));
      return;
    }
    case "sdelok": {
      const tree = await loadTree(env);
      const n = tree.nodes.get(Number(b));
      if (!n) return warn(env, cb, "Раздел уже удалён");
      if (n.own > 0 || n.children.length > 0) return warn(env, cb, "Раздел уже не пуст, удалять нельзя.");
      await run(env, "DELETE FROM categories WHERE id = ?", n.id);
      const up = n.parent_id && tree.nodes.has(n.parent_id) ? await sectionView(env, n.parent_id, uid) : null;
      if (up) await screen(env, msg, "🗑 Раздел удалён.\n\n" + up.text, up.markup, up.photo);
      else await showCatalog(env, msg, uid);
      return;
    }
    case "mv": {
      const p = await getProduct(env, Number(b));
      if (!p) return warn(env, cb, "Товар не найден");
      const rows = flatSections(await loadTree(env))
        .filter((x) => x.id !== p.category_id)
        .map((x) => [btn(x.path, `mvto:${p.id}:${x.id}`)]);
      rows.push([btn("✖️ Отмена", `item:${p.id}:-1`)]);
      await show(env, msg, `Куда переместить «${esc(p.name)}»?\nСейчас: ${esc(p.category)}`, kb(rows));
      return;
    }
    case "mvto": {
      const pid = Number(b);
      const tree = await loadTree(env);
      if (!(await getProduct(env, pid))) return warn(env, cb, "Товар не найден");
      if (!tree.nodes.has(Number(c))) return warn(env, cb, "Раздел не найден");
      await run(env, "UPDATE products SET category_id = ? WHERE id = ?", Number(c), pid);
      await screenCard(env, msg, await getProduct(env, pid), -1, true, uid);
      return toast(env, cb, "Товар перемещён ✅");
    }
  }
}

// ------------------------------------------------------------------ точка входа

async function setup(url, env) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  if (!env.BOT_TOKEN) return new Response("Не задан секрет BOT_TOKEN", { status: 500 });
  const r = await tg(env, "setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  return new Response(JSON.stringify(r, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return setup(url, env);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (!env.WEBHOOK_SECRET ||
          request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const update = await request.json();
        await initDb(env);
        if (update.message) await onMessage(env, update.message);
        else if (update.callback_query) await onCallback(env, update.callback_query);
      } catch (e) {
        console.log("Ошибка обработки:", e && e.stack ? e.stack : e);
      }
      return new Response("ok"); // всегда 200, иначе Telegram будет слать повторы
    }

    return new Response("Shop bot is running");
  },
};
