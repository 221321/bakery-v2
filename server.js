// ВкусноЦех 2.0 — производство + доставка + 1С
// Чистый Node.js, без внешних зависимостей. Хранилище: JSON-файлы в ./data
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SYNC_KEY = process.env.SYNC_KEY || 'bakery_1c_2026';

// ---------- Хранилище ----------
const TABLES = ['users', 'ingredients', 'price_docs', 'ingredient_requests', 'receipts',
  'products', 'product_price_history', 'recipes', 'clients', 'orders',
  'production_logs', 'stock', 'debt_settlements', 'counters'];

const db = {};

function loadTable(name) {
  const f = path.join(DATA_DIR, name + '.json');
  try { db[name] = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { db[name] = (name === 'stock' || name === 'counters') ? {} : []; }
}
function saveTable(name) {
  const f = path.join(DATA_DIR, name + '.json');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db[name], null, 2), 'utf8');
  fs.renameSync(tmp, f);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
TABLES.forEach(loadTable);

function nextNumber(kind) {
  db.counters[kind] = (db.counters[kind] || 0) + 1;
  saveTable('counters');
  return db.counters[kind];
}
function genId() { return crypto.randomBytes(8).toString('hex'); }
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }

// ---------- Сессии ----------
const sessions = new Map(); // token -> {userId, role}

function getUserFromReq(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)vt_token=([a-f0-9]+)/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  const u = db.users.find(x => x.id === s.userId && x.active);
  return u || null;
}

// ---------- Утилиты HTTP ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', ch => {
      size += ch.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      data += ch;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---------- Себестоимость (рекурсивно, с защитой от циклов) ----------
function recipeCost(recipeId, seen) {
  seen = seen || new Set();
  if (seen.has(recipeId)) return 0; // цикл — не считаем
  seen.add(recipeId);
  const r = db.recipes.find(x => x.id === recipeId);
  if (!r) return 0;
  let total = 0;
  for (const it of r.items) {
    if (it.type === 'ingredient') {
      const ing = db.ingredients.find(x => x.id === it.ref_id);
      if (ing) total += (ing.price || 0) * it.qty;
    } else if (it.type === 'recipe') {
      const sub = db.recipes.find(x => x.id === it.ref_id);
      if (sub) {
        const subCost = recipeCost(sub.id, new Set(seen));
        const out = sub.output_qty || 1;
        total += (subCost / out) * it.qty;
      }
    }
  }
  return total;
}
function productCost(productId) {
  const r = db.recipes.find(x => x.product_id === productId && !x.is_semifinished);
  if (!r) return null;
  const out = r.output_qty || 1;
  return recipeCost(r.id) / out;
}

// ---------- Остатки и резервы ----------
function reservedQty(productId) {
  let sum = 0;
  for (const o of db.orders) {
    if (o.status === 'new' || o.status === 'in_transit') {
      for (const it of o.items) if (it.product_id === productId) sum += it.qty;
    }
  }
  return sum;
}
function stockInfo() {
  return db.products.filter(p => p.active).map(p => {
    const onHand = db.stock[p.id] || 0;
    const reserved = reservedQty(p.id);
    return { product_id: p.id, name: p.name, on_hand: onHand, reserved, available: onHand - reserved };
  });
}

// ---------- Долги ----------
function clientDebts() {
  const map = {}; // client_id -> {debt, oldest_date}
  for (const o of db.orders) {
    if (o.status !== 'delivered' || !o.payment) continue;
    const d = o.payment.debt_amount || 0;
    if (d <= 0) continue;
    if (!map[o.client_id]) map[o.client_id] = { debt: 0, oldest: null, orders: [] };
    map[o.client_id].debt += d;
    map[o.client_id].orders.push({ order_id: o.id, number: o.number, date: o.delivery_date, amount: d });
    if (!map[o.client_id].oldest || o.delivery_date < map[o.client_id].oldest) map[o.client_id].oldest = o.delivery_date;
  }
  for (const s of db.debt_settlements) {
    if (map[s.client_id]) map[s.client_id].debt -= s.amount;
  }
  const out = [];
  for (const cid of Object.keys(map)) {
    if (map[cid].debt > 0.009) {
      const c = db.clients.find(x => x.id === cid);
      const days = map[cid].oldest ? Math.floor((Date.now() - new Date(map[cid].oldest).getTime()) / 86400000) : 0;
      out.push({ client_id: cid, client_name: c ? c.name : '?', debt: Math.round(map[cid].debt * 100) / 100, oldest: map[cid].oldest, days_overdue: days, orders: map[cid].orders });
    }
  }
  return out.sort((a, b) => b.debt - a.debt);
}

// ---------- Роутер API ----------
const routes = [];
function route(method, pattern, roles, handler) {
  routes.push({ method, pattern, roles, handler });
}
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const names = [];
    const rx = new RegExp('^' + r.pattern.replace(/:[^/]+/g, m => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    const m = pathname.match(rx);
    if (m) {
      const params = {};
      names.forEach((n, i) => params[n] = decodeURIComponent(m[i + 1]));
      return { r, params };
    }
  }
  return null;
}

// ===== Авторизация =====
route('POST', '/api/login', null, async (req, res, ctx) => {
  const { username, password } = ctx.body;
  const u = db.users.find(x => x.username === username && x.password === hash(password || ''));
  if (!u) return sendJSON(res, 401, { error: 'Неверный логин или пароль' });
  if (!u.active) return sendJSON(res, 403, { error: 'Аккаунт отключён' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: u.id, role: u.role });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `vt_token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`
  });
  res.end(JSON.stringify({ id: u.id, name: u.name, role: u.role }));
});
route('POST', '/api/logout', null, async (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vt_token=([a-f0-9]+)/);
  if (m) sessions.delete(m[1]);
  res.writeHead(200, { 'Set-Cookie': 'vt_token=; Path=/; Max-Age=0', 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});
route('GET', '/api/me', ['any'], async (req, res, ctx) => {
  const u = ctx.user;
  sendJSON(res, 200, { id: u.id, name: u.name, role: u.role });
});

// ===== Сотрудники (менеджер) =====
route('GET', '/api/users', ['manager'], async (req, res) => {
  sendJSON(res, 200, db.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active })));
});
route('POST', '/api/users', ['manager'], async (req, res, ctx) => {
  const { username, password, name, role } = ctx.body;
  if (!username || !password || !name || !['manager', 'zavhoz', 'baker', 'expeditor'].includes(role))
    return sendJSON(res, 400, { error: 'Заполните все поля' });
  if (db.users.find(u => u.username === username)) return sendJSON(res, 400, { error: 'Логин занят' });
  const u = { id: genId(), username, password: hash(password), name, role, active: true };
  db.users.push(u); saveTable('users');
  sendJSON(res, 200, { id: u.id });
});
route('PUT', '/api/users/:id', ['manager'], async (req, res, ctx) => {
  const u = db.users.find(x => x.id === ctx.params.id);
  if (!u) return sendJSON(res, 404, { error: 'Не найден' });
  if (ctx.body.name) u.name = ctx.body.name;
  if (ctx.body.password) u.password = hash(ctx.body.password);
  if (typeof ctx.body.active === 'boolean') u.active = ctx.body.active;
  saveTable('users');
  sendJSON(res, 200, { ok: true });
});

// ===== Сырьё (завхоз ведёт, пекарь видит без цен) =====
route('GET', '/api/ingredients', ['any'], async (req, res, ctx) => {
  const showPrices = ctx.user.role === 'zavhoz' || ctx.user.role === 'manager';
  sendJSON(res, 200, db.ingredients.filter(i => i.active).map(i =>
    showPrices ? i : { id: i.id, name: i.name, unit: i.unit, active: i.active }));
});
route('POST', '/api/ingredients', ['zavhoz', 'manager'], async (req, res, ctx) => {
  const { name, unit, price } = ctx.body;
  const UNITS = ['г', 'кг', 'мл', 'л', 'шт', 'уп'];
  if (!name || !UNITS.includes(unit)) return sendJSON(res, 400, { error: 'Название и единица (г/кг/мл/л/шт/уп) обязательны' });
  if (db.ingredients.find(i => i.name.toLowerCase() === name.toLowerCase() && i.active))
    return sendJSON(res, 400, { error: 'Такое сырьё уже есть' });
  const ing = { id: genId(), name: name.trim(), unit, price: Number(price) || 0, active: true, created_at: nowISO() };
  db.ingredients.push(ing); saveTable('ingredients');
  sendJSON(res, 200, ing);
});
route('PUT', '/api/ingredients/:id', ['zavhoz', 'manager'], async (req, res, ctx) => {
  const ing = db.ingredients.find(i => i.id === ctx.params.id);
  if (!ing) return sendJSON(res, 404, { error: 'Не найдено' });
  if (ctx.body.name) ing.name = ctx.body.name.trim();
  if (typeof ctx.body.active === 'boolean') ing.active = ctx.body.active;
  saveTable('ingredients');
  sendJSON(res, 200, { ok: true });
});

// Документ изменения цен сырья
route('GET', '/api/price-docs', ['zavhoz', 'manager'], async (req, res) => {
  sendJSON(res, 200, [...db.price_docs].reverse());
});
route('POST', '/api/price-docs', ['zavhoz', 'manager'], async (req, res, ctx) => {
  const items = (ctx.body.items || []).filter(it => it.ingredient_id && Number(it.new_price) >= 0);
  if (!items.length) return sendJSON(res, 400, { error: 'Пустой документ' });
  const doc = { id: genId(), number: nextNumber('price_doc'), date: today(), author: ctx.user.name, items: [] };
  for (const it of items) {
    const ing = db.ingredients.find(i => i.id === it.ingredient_id);
    if (!ing) continue;
    doc.items.push({ ingredient_id: ing.id, name: ing.name, old_price: ing.price, new_price: Number(it.new_price) });
    ing.price = Number(it.new_price);
  }
  db.price_docs.push(doc);
  saveTable('price_docs'); saveTable('ingredients');
  sendJSON(res, 200, doc);
});

// Заявки пекаря на новое сырьё
route('GET', '/api/ingredient-requests', ['baker', 'zavhoz', 'manager'], async (req, res, ctx) => {
  let list = [...db.ingredient_requests].reverse();
  if (ctx.user.role === 'baker') list = list.filter(r => r.baker_id === ctx.user.id);
  sendJSON(res, 200, list);
});
route('POST', '/api/ingredient-requests', ['baker'], async (req, res, ctx) => {
  const name = (ctx.body.name || '').trim();
  if (!name) return sendJSON(res, 400, { error: 'Укажите название' });
  const r = { id: genId(), name, status: 'pending', baker_id: ctx.user.id, baker_name: ctx.user.name, created_at: nowISO() };
  db.ingredient_requests.push(r); saveTable('ingredient_requests');
  sendJSON(res, 200, r);
});
route('POST', '/api/ingredient-requests/:id/approve', ['zavhoz', 'manager'], async (req, res, ctx) => {
  const r = db.ingredient_requests.find(x => x.id === ctx.params.id);
  if (!r || r.status !== 'pending') return sendJSON(res, 404, { error: 'Заявка не найдена' });
  const UNITS = ['г', 'кг', 'мл', 'л', 'шт', 'уп'];
  const { unit, price } = ctx.body;
  if (!UNITS.includes(unit)) return sendJSON(res, 400, { error: 'Выберите единицу измерения' });
  const ing = { id: genId(), name: r.name, unit, price: Number(price) || 0, active: true, created_at: nowISO() };
  db.ingredients.push(ing);
  r.status = 'approved'; r.resolved_at = nowISO();
  saveTable('ingredients'); saveTable('ingredient_requests');
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/ingredient-requests/:id/reject', ['zavhoz', 'manager'], async (req, res, ctx) => {
  const r = db.ingredient_requests.find(x => x.id === ctx.params.id);
  if (!r || r.status !== 'pending') return sendJSON(res, 404, { error: 'Заявка не найдена' });
  r.status = 'rejected'; r.resolved_at = nowISO();
  saveTable('ingredient_requests');
  sendJSON(res, 200, { ok: true });
});

// ===== Поступления (закуп) =====
route('GET', '/api/receipts', ['zavhoz', 'manager'], async (req, res) => {
  sendJSON(res, 200, [...db.receipts].reverse());
});
route('POST', '/api/receipts', ['zavhoz', 'manager'], async (req, res, ctx) => {
  const { supplier, items } = ctx.body;
  if (!supplier || !Array.isArray(items) || !items.length) return sendJSON(res, 400, { error: 'Поставщик и позиции обязательны' });
  const doc = { id: genId(), number: nextNumber('receipt'), date: ctx.body.date || today(), supplier, author: ctx.user.name, items: [], total: 0, exported_1c: false };
  for (const it of items) {
    const ing = db.ingredients.find(i => i.id === it.ingredient_id);
    if (!ing || !(Number(it.qty) > 0)) continue;
    const qty = Number(it.qty), price = Number(it.price) || 0;
    doc.items.push({ ingredient_id: ing.id, name: ing.name, unit: ing.unit, qty, price, sum: Math.round(qty * price * 100) / 100 });
    doc.total += qty * price;
    if (price > 0 && price !== ing.price) ing.price = price; // цена закупа обновляет справочник
  }
  if (!doc.items.length) return sendJSON(res, 400, { error: 'Нет корректных позиций' });
  doc.total = Math.round(doc.total * 100) / 100;
  db.receipts.push(doc);
  saveTable('receipts'); saveTable('ingredients');
  sendJSON(res, 200, doc);
});

// ===== Продукция и цены продажи (менеджер) =====
route('GET', '/api/products', ['any'], async (req, res, ctx) => {
  const full = ctx.user.role === 'manager';
  sendJSON(res, 200, db.products.filter(p => p.active).map(p => {
    const base = { id: p.id, name: p.name, code: p.code, sale_price: p.sale_price, active: p.active };
    if (full) {
      const cost = productCost(p.id);
      base.cost = cost === null ? null : Math.round(cost * 100) / 100;
      base.margin = (cost !== null && p.sale_price > 0) ? Math.round((p.sale_price - cost) * 100) / 100 : null;
      base.margin_pct = (cost !== null && cost > 0 && p.sale_price > 0) ? Math.round((p.sale_price - cost) / cost * 10000) / 100 : null;
    }
    return base;
  }));
});
route('POST', '/api/products', ['manager'], async (req, res, ctx) => {
  const { name, sale_price } = ctx.body;
  if (!name) return sendJSON(res, 400, { error: 'Укажите название' });
  if (db.products.find(p => p.name.toLowerCase() === name.toLowerCase() && p.active))
    return sendJSON(res, 400, { error: 'Такая позиция уже есть' });
  const p = { id: genId(), name: name.trim(), code: 'P' + String(nextNumber('product')).padStart(4, '0'), sale_price: Number(sale_price) || 0, active: true };
  db.products.push(p); saveTable('products');
  sendJSON(res, 200, p);
});
route('POST', '/api/products/:id/price', ['manager'], async (req, res, ctx) => {
  const p = db.products.find(x => x.id === ctx.params.id);
  if (!p) return sendJSON(res, 404, { error: 'Не найдено' });
  const np = Number(ctx.body.price);
  if (!(np >= 0)) return sendJSON(res, 400, { error: 'Некорректная цена' });
  db.product_price_history.push({ id: genId(), product_id: p.id, name: p.name, old_price: p.sale_price, new_price: np, date: nowISO(), author: ctx.user.name });
  p.sale_price = np;
  saveTable('products'); saveTable('product_price_history');
  sendJSON(res, 200, { ok: true });
});
route('GET', '/api/products/:id/price-history', ['manager'], async (req, res, ctx) => {
  sendJSON(res, 200, db.product_price_history.filter(h => h.product_id === ctx.params.id).reverse());
});
route('PUT', '/api/products/:id', ['manager'], async (req, res, ctx) => {
  const p = db.products.find(x => x.id === ctx.params.id);
  if (!p) return sendJSON(res, 404, { error: 'Не найдено' });
  if (ctx.body.name) p.name = ctx.body.name.trim();
  if (typeof ctx.body.active === 'boolean') p.active = ctx.body.active;
  saveTable('products');
  sendJSON(res, 200, { ok: true });
});

// ===== Рецепты (пекарь: без цен; менеджер: с себестоимостью) =====
route('GET', '/api/recipes', ['any'], async (req, res, ctx) => {
  const full = ctx.user.role === 'manager';
  sendJSON(res, 200, db.recipes.map(r => {
    const out = { id: r.id, name: r.name, product_id: r.product_id || null, is_semifinished: !!r.is_semifinished, output_qty: r.output_qty, items: r.items, author: r.author };
    if (full) out.cost = Math.round(recipeCost(r.id) * 100) / 100;
    return out;
  }));
});
route('POST', '/api/recipes', ['baker', 'manager'], async (req, res, ctx) => {
  const { product_id, name, is_semifinished, output_qty, items } = ctx.body;
  if (!Array.isArray(items) || !items.length) return sendJSON(res, 400, { error: 'Состав пуст' });
  let recName;
  if (is_semifinished) {
    recName = (name || '').trim();
    if (!recName) return sendJSON(res, 400, { error: 'Укажите название полуфабриката' });
  } else {
    const p = db.products.find(x => x.id === product_id && x.active);
    if (!p) return sendJSON(res, 400, { error: 'Готовая продукция выбирается из каталога' });
    if (db.recipes.find(r => r.product_id === product_id && !r.is_semifinished))
      return sendJSON(res, 400, { error: 'У этой позиции уже есть рецепт — откройте его для редактирования' });
    recName = p.name;
  }
  const clean = [];
  for (const it of items) {
    if (!(Number(it.qty) > 0)) continue;
    if (it.type === 'ingredient' && db.ingredients.find(i => i.id === it.ref_id)) clean.push({ type: 'ingredient', ref_id: it.ref_id, qty: Number(it.qty) });
    if (it.type === 'recipe' && db.recipes.find(r => r.id === it.ref_id && r.is_semifinished)) clean.push({ type: 'recipe', ref_id: it.ref_id, qty: Number(it.qty) });
  }
  if (!clean.length) return sendJSON(res, 400, { error: 'Нет корректных строк состава' });
  const r = { id: genId(), name: recName, product_id: is_semifinished ? null : product_id, is_semifinished: !!is_semifinished, output_qty: Number(output_qty) || 1, items: clean, author: ctx.user.name, created_at: nowISO() };
  db.recipes.push(r); saveTable('recipes');
  sendJSON(res, 200, r);
});
route('PUT', '/api/recipes/:id', ['baker', 'manager'], async (req, res, ctx) => {
  const r = db.recipes.find(x => x.id === ctx.params.id);
  if (!r) return sendJSON(res, 404, { error: 'Не найден' });
  if (Array.isArray(ctx.body.items)) {
    const clean = [];
    for (const it of ctx.body.items) {
      if (!(Number(it.qty) > 0)) continue;
      if (it.type === 'ingredient' && db.ingredients.find(i => i.id === it.ref_id)) clean.push({ type: 'ingredient', ref_id: it.ref_id, qty: Number(it.qty) });
      if (it.type === 'recipe' && it.ref_id !== r.id && db.recipes.find(x => x.id === it.ref_id && x.is_semifinished)) clean.push({ type: 'recipe', ref_id: it.ref_id, qty: Number(it.qty) });
    }
    if (!clean.length) return sendJSON(res, 400, { error: 'Состав не может быть пустым' });
    r.items = clean;
  }
  if (Number(ctx.body.output_qty) > 0) r.output_qty = Number(ctx.body.output_qty);
  saveTable('recipes');
  sendJSON(res, 200, { ok: true });
});

// ===== Клиенты =====
route('GET', '/api/clients', ['manager', 'expeditor'], async (req, res, ctx) => {
  const q = (ctx.query.q || '').toLowerCase();
  let list = db.clients.filter(c => c.active);
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q));
  sendJSON(res, 200, list.slice(0, 50));
});
route('POST', '/api/clients', ['manager'], async (req, res, ctx) => {
  const { name, phone, address } = ctx.body;
  if (!name) return sendJSON(res, 400, { error: 'Укажите название' });
  const c = { id: genId(), name: name.trim(), code: 'C' + String(nextNumber('client')).padStart(4, '0'), phone: phone || '', address: address || '', active: true };
  db.clients.push(c); saveTable('clients');
  sendJSON(res, 200, c);
});
route('PUT', '/api/clients/:id', ['manager'], async (req, res, ctx) => {
  const c = db.clients.find(x => x.id === ctx.params.id);
  if (!c) return sendJSON(res, 404, { error: 'Не найден' });
  ['name', 'phone', 'address'].forEach(k => { if (ctx.body[k] !== undefined) c[k] = ctx.body[k]; });
  if (typeof ctx.body.active === 'boolean') c.active = ctx.body.active;
  saveTable('clients');
  sendJSON(res, 200, { ok: true });
});

// ===== Заказы (менеджер заносит с вечера) =====
route('GET', '/api/orders', ['manager', 'expeditor'], async (req, res, ctx) => {
  let list = [...db.orders];
  const q = ctx.query;
  if (q.delivery_date) list = list.filter(o => o.delivery_date === q.delivery_date);
  if (q.status) list = list.filter(o => o.status === q.status);
  if (q.from) list = list.filter(o => o.delivery_date >= q.from);
  if (q.to) list = list.filter(o => o.delivery_date <= q.to);
  list.sort((a, b) => (b.delivery_date + b.number).localeCompare(a.delivery_date + a.number));
  sendJSON(res, 200, list.map(o => orderView(o)));
});
function orderView(o) {
  const c = db.clients.find(x => x.id === o.client_id);
  return { ...o, client_name: c ? c.name : '?', client_code: c ? c.code : '', client_address: c ? c.address : '', client_phone: c ? c.phone : '' };
}
route('POST', '/api/orders', ['manager'], async (req, res, ctx) => {
  const { client_id, delivery_date, items, comment } = ctx.body;
  const c = db.clients.find(x => x.id === client_id && x.active);
  if (!c) return sendJSON(res, 400, { error: 'Выберите клиента' });
  if (!delivery_date) return sendJSON(res, 400, { error: 'Укажите дату доставки' });
  if (!Array.isArray(items) || !items.length) return sendJSON(res, 400, { error: 'Пустой заказ' });
  const doc = { id: genId(), number: nextNumber('order'), created_at: nowISO(), delivery_date, client_id, items: [], total: 0, status: 'new', comment: comment || '', payment: null, expeditor_id: null, realized_1c: false, created_by: ctx.user.name };
  for (const it of items) {
    const p = db.products.find(x => x.id === it.product_id && x.active);
    if (!p || !(Number(it.qty) > 0)) continue;
    const qty = Number(it.qty);
    doc.items.push({ product_id: p.id, product_code: p.code, name: p.name, qty, price: p.sale_price, sum: Math.round(qty * p.sale_price * 100) / 100 });
    doc.total += qty * p.sale_price;
  }
  if (!doc.items.length) return sendJSON(res, 400, { error: 'Нет корректных позиций' });
  // Жёсткая проверка остатков: доступно = на складе минус резерв открытых заказов
  const stockNow = stockInfo();
  for (const it of doc.items) {
    const s = stockNow.find(x => x.product_id === it.product_id);
    const avail = s ? s.available : 0;
    if (it.qty > avail) {
      return sendJSON(res, 400, { error: `«${it.name}»: доступно ${avail}, запрошено ${it.qty}. Сначала нужен выпуск от пекаря.` });
    }
  }
  doc.total = Math.round(doc.total * 100) / 100;
  db.orders.push(doc); saveTable('orders');
  sendJSON(res, 200, orderView(doc));
});
route('POST', '/api/orders/:id/cancel', ['manager'], async (req, res, ctx) => {
  const o = db.orders.find(x => x.id === ctx.params.id);
  if (!o) return sendJSON(res, 404, { error: 'Не найден' });
  if (o.status === 'delivered') return sendJSON(res, 400, { error: 'Заказ уже доставлен' });
  o.status = 'cancelled'; saveTable('orders');
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/orders/:id/take', ['expeditor'], async (req, res, ctx) => {
  const o = db.orders.find(x => x.id === ctx.params.id);
  if (!o || o.status !== 'new') return sendJSON(res, 400, { error: 'Заказ недоступен' });
  o.status = 'in_transit'; o.expeditor_id = ctx.user.id; o.expeditor_name = ctx.user.name;
  saveTable('orders');
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/orders/:id/deliver', ['expeditor', 'manager'], async (req, res, ctx) => {
  const o = db.orders.find(x => x.id === ctx.params.id);
  if (!o || (o.status !== 'in_transit' && o.status !== 'new')) return sendJSON(res, 400, { error: 'Заказ недоступен' });
  const { method, paid_amount } = ctx.body; // cash | qr | debt | mixed
  if (!['cash', 'qr', 'debt', 'mixed'].includes(method)) return sendJSON(res, 400, { error: 'Укажите способ оплаты' });
  let paid = Number(paid_amount);
  if (method === 'debt') paid = 0;
  if (method !== 'mixed' && method !== 'debt') paid = o.total;
  if (!(paid >= 0) || paid > o.total) return sendJSON(res, 400, { error: 'Некорректная сумма оплаты' });
  o.status = 'delivered';
  o.delivered_at = nowISO();
  if (!o.expeditor_id) { o.expeditor_id = ctx.user.id; o.expeditor_name = ctx.user.name; }
  o.payment = { method, paid_amount: Math.round(paid * 100) / 100, debt_amount: Math.round((o.total - paid) * 100) / 100 };
  // списание с остатков
  for (const it of o.items) {
    db.stock[it.product_id] = (db.stock[it.product_id] || 0) - it.qty;
  }
  saveTable('orders'); saveTable('stock');
  sendJSON(res, 200, { ok: true });
});

// ===== План производства (пекарь) =====
route('GET', '/api/production-plan', ['any'], async (req, res, ctx) => {
  const date = ctx.query.date || today();
  const agg = {};
  for (const o of db.orders) {
    if (o.delivery_date !== date || o.status === 'cancelled') continue;
    for (const it of o.items) {
      if (!agg[it.product_id]) agg[it.product_id] = { product_id: it.product_id, name: it.name, ordered: 0 };
      agg[it.product_id].ordered += it.qty;
    }
  }
  // фактический выпуск на эту дату
  for (const pl of db.production_logs) {
    if (pl.date !== date) continue;
    for (const it of pl.items) {
      if (!agg[it.product_id]) {
        const p = db.products.find(x => x.id === it.product_id);
        agg[it.product_id] = { product_id: it.product_id, name: p ? p.name : '?', ordered: 0 };
      }
      agg[it.product_id].produced = (agg[it.product_id].produced || 0) + it.qty;
    }
  }
  const rows = Object.values(agg).map(r => ({ ...r, produced: r.produced || 0, on_hand: db.stock[r.product_id] || 0 }));
  rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  sendJSON(res, 200, { date, rows });
});

// ===== Выпуск за смену (пекарь) =====
route('GET', '/api/production-logs', ['baker', 'manager'], async (req, res, ctx) => {
  let list = [...db.production_logs].reverse();
  if (ctx.query.date) list = list.filter(p => p.date === ctx.query.date);
  sendJSON(res, 200, list);
});
route('POST', '/api/production-logs', ['baker', 'manager'], async (req, res, ctx) => {
  const { date, items } = ctx.body;
  if (!Array.isArray(items) || !items.length) return sendJSON(res, 400, { error: 'Пустой выпуск' });
  const doc = { id: genId(), number: nextNumber('production'), date: date || today(), baker_id: ctx.user.id, baker_name: ctx.user.name, items: [], exported_1c: false, created_at: nowISO() };
  for (const it of items) {
    const p = db.products.find(x => x.id === it.product_id && x.active);
    if (!p || !(Number(it.qty) > 0)) continue;
    const qty = Number(it.qty);
    doc.items.push({ product_id: p.id, product_code: p.code, name: p.name, qty });
    db.stock[p.id] = (db.stock[p.id] || 0) + qty;
  }
  if (!doc.items.length) return sendJSON(res, 400, { error: 'Нет корректных позиций' });
  db.production_logs.push(doc);
  saveTable('production_logs'); saveTable('stock');
  sendJSON(res, 200, doc);
});

// ===== Остатки =====
route('GET', '/api/stock', ['any'], async (req, res) => {
  sendJSON(res, 200, stockInfo());
});

// ===== Долги и погашения =====
route('GET', '/api/debts', ['manager', 'expeditor'], async (req, res) => {
  sendJSON(res, 200, clientDebts());
});
route('POST', '/api/debt-settlements', ['manager', 'expeditor'], async (req, res, ctx) => {
  const { client_id, amount, method } = ctx.body;
  const c = db.clients.find(x => x.id === client_id);
  if (!c) return sendJSON(res, 400, { error: 'Клиент не найден' });
  const a = Number(amount);
  if (!(a > 0)) return sendJSON(res, 400, { error: 'Некорректная сумма' });
  const debts = clientDebts().find(d => d.client_id === client_id);
  if (!debts || a > debts.debt + 0.01) return sendJSON(res, 400, { error: 'Сумма больше долга' });
  const s = { id: genId(), number: nextNumber('settlement'), client_id, client_name: c.name, client_code: c.code, amount: a, method: method || 'cash', date: today(), author: ctx.user.name, created_at: nowISO(), exported_1c: false };
  db.debt_settlements.push(s); saveTable('debt_settlements');
  sendJSON(res, 200, s);
});
route('GET', '/api/debt-settlements', ['manager', 'expeditor'], async (req, res) => {
  sendJSON(res, 200, [...db.debt_settlements].reverse());
});

// ===== Отчёты (менеджер) =====
route('GET', '/api/reports/sales', ['manager'], async (req, res, ctx) => {
  const from = ctx.query.from || today();
  const to = ctx.query.to || today();
  const orders = db.orders.filter(o => o.status === 'delivered' && o.delivery_date >= from && o.delivery_date <= to);
  let total = 0, cash = 0, qr = 0, debt = 0, costTotal = 0;
  const byProduct = {};
  const byExpeditor = {};
  for (const o of orders) {
    total += o.total;
    if (o.payment) {
      if (o.payment.method === 'cash') cash += o.payment.paid_amount;
      else if (o.payment.method === 'qr') qr += o.payment.paid_amount;
      else if (o.payment.method === 'mixed') cash += o.payment.paid_amount;
      debt += o.payment.debt_amount || 0;
    }
    const en = o.expeditor_name || '—';
    if (!byExpeditor[en]) byExpeditor[en] = { name: en, orders: 0, total: 0, cash: 0, debt: 0 };
    byExpeditor[en].orders++; byExpeditor[en].total += o.total;
    if (o.payment) { byExpeditor[en].cash += o.payment.paid_amount; byExpeditor[en].debt += o.payment.debt_amount || 0; }
    for (const it of o.items) {
      if (!byProduct[it.product_id]) {
        const cost = productCost(it.product_id);
        byProduct[it.product_id] = { name: it.name, qty: 0, sum: 0, cost_unit: cost };
      }
      byProduct[it.product_id].qty += it.qty;
      byProduct[it.product_id].sum += it.sum;
      if (byProduct[it.product_id].cost_unit !== null) costTotal += byProduct[it.product_id].cost_unit * it.qty;
    }
  }
  sendJSON(res, 200, {
    from, to, orders_count: orders.length,
    total: r2(total), cash: r2(cash), qr: r2(qr), debt: r2(debt),
    cost_total: r2(costTotal), margin: r2(total - costTotal),
    by_product: Object.values(byProduct).map(p => ({ ...p, sum: r2(p.sum), cost_unit: p.cost_unit === null ? null : r2(p.cost_unit) })).sort((a, b) => b.sum - a.sum),
    by_expeditor: Object.values(byExpeditor).map(e => ({ ...e, total: r2(e.total), cash: r2(e.cash), debt: r2(e.debt) }))
  });
});
function r2(x) { return Math.round(x * 100) / 100; }

// ===== 1С API (по секретному ключу) =====
function check1CKey(req, ctx) {
  const key = req.headers['x-sync-key'] || ctx.query.key;
  return key === SYNC_KEY;
}
// Поступления для выгрузки в 1С
route('GET', '/api/1c/receipts', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  sendJSON(res, 200, db.receipts.filter(r => !r.exported_1c));
});
route('POST', '/api/1c/receipts/:id/mark-exported', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  const r = db.receipts.find(x => x.id === ctx.params.id);
  if (!r) return sendJSON(res, 404, { error: 'not found' });
  r.exported_1c = true; saveTable('receipts');
  sendJSON(res, 200, { ok: true });
});
// Выпуск продукции для 1С (Отчёт производства за смену)
route('GET', '/api/1c/production', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  sendJSON(res, 200, db.production_logs.filter(p => !p.exported_1c));
});
route('POST', '/api/1c/production/:id/mark-exported', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  const p = db.production_logs.find(x => x.id === ctx.params.id);
  if (!p) return sendJSON(res, 404, { error: 'not found' });
  p.exported_1c = true; saveTable('production_logs');
  sendJSON(res, 200, { ok: true });
});
// Доставленные заказы для создания реализаций
route('GET', '/api/1c/orders', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  sendJSON(res, 200, db.orders.filter(o => o.status === 'delivered' && !o.realized_1c).map(o => orderView(o)));
});
route('POST', '/api/1c/orders/:id/mark-realized', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  const o = db.orders.find(x => x.id === ctx.params.id);
  if (!o) return sendJSON(res, 404, { error: 'not found' });
  o.realized_1c = true; saveTable('orders');
  sendJSON(res, 200, { ok: true });
});
// Погашения долгов для ПКО
route('GET', '/api/1c/debt-settlements', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  sendJSON(res, 200, db.debt_settlements.filter(s => !s.exported_1c));
});
route('POST', '/api/1c/debt-settlements/:id/mark-exported', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  const s = db.debt_settlements.find(x => x.id === ctx.params.id);
  if (!s) return sendJSON(res, 404, { error: 'not found' });
  s.exported_1c = true; saveTable('debt_settlements');
  sendJSON(res, 200, { ok: true });
});
// Синхронизация контрагентов из 1С (пуш)
route('POST', '/api/1c/clients/sync', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  const list = ctx.body.clients;
  if (!Array.isArray(list)) return sendJSON(res, 400, { error: 'clients array required' });
  let added = 0, updated = 0;
  for (const it of list) {
    if (!it.code || !it.name) continue;
    let c = db.clients.find(x => x.code === it.code);
    if (c) { c.name = it.name; if (it.phone) c.phone = it.phone; if (it.address) c.address = it.address; updated++; }
    else { db.clients.push({ id: genId(), code: it.code, name: it.name, phone: it.phone || '', address: it.address || '', active: true }); added++; }
  }
  saveTable('clients');
  sendJSON(res, 200, { added, updated });
});
// Синхронизация номенклатуры готовой продукции из 1С (пуш, опционально)
route('POST', '/api/1c/products/sync', null, async (req, res, ctx) => {
  if (!check1CKey(req, ctx)) return sendJSON(res, 403, { error: 'bad key' });
  const list = ctx.body.products;
  if (!Array.isArray(list)) return sendJSON(res, 400, { error: 'products array required' });
  let added = 0, updated = 0;
  for (const it of list) {
    if (!it.code || !it.name) continue;
    let p = db.products.find(x => x.code === it.code);
    if (p) { p.name = it.name; updated++; }
    else { db.products.push({ id: genId(), code: it.code, name: it.name, sale_price: Number(it.price) || 0, active: true }); added++; }
  }
  saveTable('products');
  sendJSON(res, 200, { added, updated });
});

// ---------- Статика ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/login.html' : pathname;
  if (p === '/app') p = '/app.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Сервер ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname.startsWith('/api/')) {
    const match = matchRoute(req.method, pathname);
    if (!match) return sendJSON(res, 404, { error: 'not found' });
    const ctx = { params: match.params, query: parsed.query, body: {}, user: null };
    try {
      if (req.method === 'POST' || req.method === 'PUT') ctx.body = await readBody(req);
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    if (match.r.roles) {
      ctx.user = getUserFromReq(req);
      if (!ctx.user) return sendJSON(res, 401, { error: 'Требуется вход' });
      if (!match.r.roles.includes('any') && !match.r.roles.includes(ctx.user.role))
        return sendJSON(res, 403, { error: 'Нет доступа' });
    }
    try { await match.r.handler(req, res, ctx); }
    catch (e) { console.error(e); sendJSON(res, 500, { error: 'Внутренняя ошибка' }); }
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => console.log(`ВкусноЦех 2.0 запущен: http://localhost:${PORT}`));
