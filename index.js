/**
 * Telegram-бот магазина на Cloudflare Workers + D1 (без серверов и таблиц).
 *
 * Telegram присылает сообщения на /webhook, бот отвечает через Bot API.
 * Товары лежат в базе D1 (binding DB), админ управляет ими кнопками в Telegram.
 *
 * Секреты (Cloudflare → Settings → Variables and Secrets): BOT_TOKEN, WEBHOOK_SECRET.
 * Обычные настройки (SHOP_NAME, CURRENCY, MANAGER_USERNAME, ADMIN_IDS) — в wrangler.jsonc.
 */

const PAGE_SIZE = 8;

// ------------------------------------------------------------------ утилиты

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtPrice = (p) => (Number.isInteger(p) ? String(p) : Number(p).toFixed(2));

function parseNum(s) {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const v = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

const cur = (env) => env.CURRENCY || "₽";
const shopName = (env) => env.SHOP_NAME || "Наш магазин";
const manager = (env) => String(env.MANAGER_USERNAME || "").replace(/^@/, "");
const isAdmin = (env, uid) =>
  String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(String(uid));

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

async function warn(env, cb, text) {
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: true });
  return true; // «ответ уже дан»
}

// ------------------------------------------------------------------ база данных

let dbReady = false;
async function initDb(env) {
  if (dbReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, " +
      "name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, " +
      "description TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '')"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS states(user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')"),
  ]);
  dbReady = true;
}

const all = async (env, sql, ...args) =>
  (await env.DB.prepare(sql).bind(...args).all()).results || [];
const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

const PRODUCT_SQL =
  "SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id";

const getProduct = (env, pid) => first(env, PRODUCT_SQL + " WHERE p.id = ?", pid);

const catsWithProducts = (env) =>
  all(env,
    "SELECT c.id, c.name, COUNT(p.id) AS n FROM categories c " +
    "JOIN products p ON p.category_id = c.id GROUP BY c.id ORDER BY c.name");

const productsIn = (env, cid) =>
  all(env, PRODUCT_SQL + " WHERE p.category_id = ? ORDER BY (p.stock <= 0), p.name", cid);

async function searchProducts(env, text) {
  const t = text.toLowerCase();
  const rows = await all(env, PRODUCT_SQL + " ORDER BY (p.stock <= 0), p.name");
  return rows.filter((r) => r.name.toLowerCase().includes(t)).slice(0, 20);
}

async function ensureCategory(env, name) {
  const row = await first(env, "SELECT id FROM categories WHERE name = ?", name);
  if (row) return row.id;
  return (await run(env, "INSERT INTO categories(name) VALUES (?)", name)).meta.last_row_id;
}

const cleanupCategories = (env) =>
  run(env, "DELETE FROM categories WHERE id NOT IN (SELECT DISTINCT category_id FROM products)");

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

// ------------------------------------------------------------------ внешний вид

const AGE_TEXT = "🔞 Каталог только для лиц старше 18 лет.\nВам уже исполнилось 18?";
const ADMIN_TEXT =
  "⚙️ <b>Админ-панель</b>\n\n" +
  "Чтобы изменить товар, откройте его в каталоге: под карточкой появятся кнопки " +
  "управления (остаток, цена, описание, фото, удаление).\n\n" +
  "/stats — статистика\n/export — выгрузить товары файлом\n/cancel — отменить ввод";

const adminPanel = () =>
  kb([[btn("➕ Добавить товар", "adm:add")], [btn("📚 Открыть каталог", "menu")]]);

const askAge = (env, chat) =>
  send(env, chat, AGE_TEXT,
    kb([[btn("Да, мне есть 18", "age:yes"), btn("Нет", "age:no")]]));

async function menuText(env) {
  const head = `<b>${esc(shopName(env))}</b>\n`;
  if (!(await catsWithProducts(env)).length) return head + "Каталог пока пуст.";
  return head + "Выберите категорию или отправьте название товара для поиска.";
}

async function mainMenu(env, uid) {
  const rows = (await catsWithProducts(env)).map((c) => [btn(`${c.name} (${c.n})`, `cat:${c.id}:0`)]);
  if (manager(env)) rows.push([urlBtn("💬 Написать менеджеру", `https://t.me/${manager(env)}`)]);
  if (isAdmin(env, uid)) rows.push([btn("⚙️ Админ-панель", "adm:panel")]);
  return kb(rows);
}

const productLine = (env, p) =>
  `${p.stock > 0 ? "" : "❌ "}${p.name} — ${fmtPrice(p.price)} ${cur(env)}`;

function productText(env, p) {
  const stock = p.stock > 0 ? `✅ В наличии: ${p.stock} шт.` : "❌ Нет в наличии";
  const parts = [`<b>${esc(p.name)}</b>`, `💰 ${fmtPrice(p.price)} ${cur(env)}`, stock];
  if (p.description) parts.push("", esc(p.description));
  return parts.join("\n");
}

function cardMarkup(env, p, page, admin) {
  const rows = [];
  if (manager(env)) {
    rows.push([urlBtn("🛒 Заказать у менеджера",
      `https://t.me/${manager(env)}?text=${encodeURIComponent(p.name)}`)]);
  }
  if (admin) {
    rows.push([btn("➖ 1 шт.", `stk:${p.id}:-1:${page}`), btn("➕ 1 шт.", `stk:${p.id}:1:${page}`)]);
    rows.push([btn("✏️ Название", `ed:name:${p.id}`), btn("💰 Цена", `ed:price:${p.id}`)]);
    rows.push([btn("📦 Остаток", `ed:stock:${p.id}`), btn("📝 Описание", `ed:desc:${p.id}`)]);
    rows.push([btn("🖼 Фото", `ed:photo:${p.id}`), btn("🗑 Удалить", `del:${p.id}`)]);
  }
  rows.push([btn("⬅️ Назад", `cat:${p.category_id}:${page}`)]);
  return kb(rows);
}

async function sendCard(env, chat, p, page = 0, admin = false) {
  const text = productText(env, p);
  const markup = cardMarkup(env, p, page, admin);
  if (p.photo) {
    const r = await tg(env, "sendPhoto", {
      chat_id: chat, photo: p.photo, caption: text, parse_mode: "HTML", reply_markup: markup,
    });
    if (r.ok) return;
  }
  return send(env, chat, text, markup);
}

function refreshCard(env, msg, p, page, admin) {
  const text = productText(env, p);
  const markup = cardMarkup(env, p, page, admin);
  if (msg.photo) {
    return tg(env, "editMessageCaption", {
      chat_id: msg.chat.id, message_id: msg.message_id, caption: text,
      parse_mode: "HTML", reply_markup: markup,
    });
  }
  return edit(env, msg, text, markup);
}

// ------------------------------------------------------------------ сообщения

async function onMessage(env, m) {
  if (!m.chat || m.chat.type !== "private" || !m.from) return;
  const uid = m.from.id;
  const chat = m.chat.id;
  const text = (m.text || "").trim();

  if (text.startsWith("/")) return onCommand(env, m, text.split(/[\s@]/)[0].toLowerCase());

  const st = await getState(env, uid);
  if (st) {
    if (isAdmin(env, uid)) return onState(env, m, st);
    await clearState(env, uid);
  }
  if (!text) return;
  if (!(await isConfirmed(env, uid))) return askAge(env, chat);

  if (text.length < 2) return send(env, chat, "Введите минимум 2 символа для поиска.");
  const found = await searchProducts(env, text);
  if (!found.length) {
    return send(env, chat, "Ничего не найдено. Попробуйте другое слово.", await mainMenu(env, uid));
  }
  const rows = found.map((p) => [btn(productLine(env, p), `item:${p.id}:0`)]);
  rows.push([btn("⬅️ В меню", "menu")]);
  return send(env, chat, `Найдено: ${found.length}`, kb(rows));
}

async function onCommand(env, m, cmd) {
  const uid = m.from.id;
  const chat = m.chat.id;
  const admin = isAdmin(env, uid);

  switch (cmd) {
    case "/start":
      await clearState(env, uid);
      if (!(await isConfirmed(env, uid))) return askAge(env, chat);
      return send(env, chat, await menuText(env), await mainMenu(env, uid));
    case "/id":
      return send(env, chat, `Ваш Telegram ID: <code>${uid}</code>`);
    case "/cancel":
      await clearState(env, uid);
      return send(env, chat, "Отменено.");
    case "/admin":
      if (!admin) return;
      await clearState(env, uid);
      return send(env, chat, ADMIN_TEXT, adminPanel());
    case "/stats": {
      if (!admin) return;
      const t = await first(env, "SELECT COUNT(*) AS n FROM products");
      const o = await first(env, "SELECT COUNT(*) AS n FROM products WHERE stock <= 0");
      const u = await first(env, "SELECT COUNT(*) AS n FROM users");
      const c = await catsWithProducts(env);
      return send(env, chat,
        `Товаров: ${t.n} (нет в наличии: ${o.n})\nКатегорий: ${c.length}\nПодтвердили 18+: ${u.n}`);
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

// ------------------------------------------------------------------ диалоги админа

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

  switch (st.state) {
    case "add_newcat": {
      const name = text.slice(0, 40);
      if (!name) return send(env, chat, "Введите название категории.");
      await setState(env, uid, "add_name", { category: name });
      return send(env, chat, "Введите название товара:");
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
      const cid = await ensureCategory(env, d.category);
      const res = await run(env,
        "INSERT INTO products(category_id, name, price, stock, description, photo) VALUES (?, ?, ?, ?, ?, ?)",
        cid, d.name, d.price, d.stock, d.desc, photo);
      await clearState(env, uid);
      await send(env, chat, "✅ Товар добавлен. Ещё один — /admin");
      return sendCard(env, chat, await getProduct(env, res.meta.last_row_id), 0, true);
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
      return sendCard(env, chat, await getProduct(env, pid), 0, true);
    }
    default:
      await clearState(env, uid);
  }
}

// ------------------------------------------------------------------ кнопки

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
    await edit(env, msg, await menuText(env), await mainMenu(env, uid));
    return;
  }

  if (["adm", "stk", "del", "delok", "ed", "addcat"].includes(a)) {
    if (!isAdmin(env, uid)) return warn(env, cb, "Нет доступа");
    return adminCallback(env, cb, a, b, c, d);
  }

  if (!(await isConfirmed(env, uid))) return warn(env, cb, "Нажмите /start");

  switch (a) {
    case "menu":
      await clearState(env, uid);
      await show(env, msg, await menuText(env), await mainMenu(env, uid));
      return;
    case "cat":
      return openCategory(env, cb, Number(b), Number(c));
    case "item":
      return openItem(env, cb, Number(b), Number(c));
  }
}

async function openCategory(env, cb, cid, page) {
  const msg = cb.message;
  const cat = await first(env, "SELECT name FROM categories WHERE id = ?", cid);
  const items = await productsIn(env, cid);
  if (!cat || !items.length) {
    await warn(env, cb, "Категория пуста или изменилась");
    await show(env, msg, await menuText(env), await mainMenu(env, cb.from.id));
    return true;
  }
  const pages = Math.floor((items.length - 1) / PAGE_SIZE) + 1;
  page = Math.max(0, Math.min(page, pages - 1));
  const rows = items
    .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    .map((p) => [btn(productLine(env, p), `item:${p.id}:${page}`)]);
  const nav = [];
  if (page > 0) nav.push(btn("◀️", `cat:${cid}:${page - 1}`));
  nav.push(btn(`${page + 1}/${pages}`, "noop"));
  if (page < pages - 1) nav.push(btn("▶️", `cat:${cid}:${page + 1}`));
  rows.push(nav, [btn("⬅️ В меню", "menu")]);
  await show(env, msg, `<b>${esc(cat.name)}</b>`, kb(rows));
}

async function openItem(env, cb, pid, page) {
  const msg = cb.message;
  const admin = isAdmin(env, cb.from.id);
  const p = await getProduct(env, pid);
  if (!p) {
    await warn(env, cb, "Товар больше недоступен");
    await show(env, msg, await menuText(env), await mainMenu(env, cb.from.id));
    return true;
  }
  if (p.photo || msg.photo) {
    await del(env, msg);
    await sendCard(env, msg.chat.id, p, page, admin);
  } else {
    await edit(env, msg, productText(env, p), cardMarkup(env, p, page, admin));
  }
}

async function adminCallback(env, cb, a, b, c, d) {
  const msg = cb.message;
  const uid = cb.from.id;
  const chat = msg.chat.id;

  switch (a) {
    case "adm": {
      await clearState(env, uid);
      if (b === "add") {
        const cats = await all(env, "SELECT id, name FROM categories ORDER BY name");
        const rows = cats.map((x) => [btn(x.name, `addcat:${x.id}`)]);
        rows.push([btn("➕ Новая категория", "addcat:new")], [btn("✖️ Отмена", "adm:cancel")]);
        await show(env, msg, "Выберите категорию для нового товара:", kb(rows));
      } else {
        await show(env, msg, ADMIN_TEXT, adminPanel());
      }
      return;
    }
    case "stk": {
      const pid = Number(b);
      if (!(await getProduct(env, pid))) return warn(env, cb, "Товар не найден");
      await run(env, "UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?", Number(c), pid);
      await refreshCard(env, msg, await getProduct(env, pid), Number(d) || 0, true);
      return;
    }
    case "del": {
      const p = await getProduct(env, Number(b));
      if (!p) return warn(env, cb, "Товар не найден");
      await show(env, msg, `Удалить «${esc(p.name)}»? Это необратимо.`,
        kb([[btn("🗑 Да, удалить", `delok:${p.id}`), btn("Отмена", `item:${p.id}:0`)]]));
      return;
    }
    case "delok": {
      await run(env, "DELETE FROM products WHERE id = ?", Number(b));
      await cleanupCategories(env);
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
        await send(env, chat, "Введите название новой категории:\n/cancel — отмена");
        return;
      }
      const row = await first(env, "SELECT name FROM categories WHERE id = ?", Number(b));
      if (!row) return warn(env, cb, "Категория не найдена");
      await setState(env, uid, "add_name", { category: row.name });
      await send(env, chat, `Категория: ${esc(row.name)}\nВведите название товара:`);
      return;
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
