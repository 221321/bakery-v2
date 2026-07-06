// Идемпотентная инициализация: не перезаписывает существующие данные.
// Тестовые клиенты ДОЗАЛИВАЮТСЯ в существующий справочник (без дублей по названию).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function genId() { return crypto.randomBytes(8).toString('hex'); }
function fileOf(t) { return path.join(DATA_DIR, t + '.json'); }
function exists(t) { return fs.existsSync(fileOf(t)); }
function read(t, def) { try { return JSON.parse(fs.readFileSync(fileOf(t), 'utf8')); } catch (e) { return def; } }
function write(t, data) { fs.writeFileSync(fileOf(t), JSON.stringify(data, null, 2), 'utf8'); }

if (!exists('users')) {
  write('users', [
    { id: genId(), username: 'manager', password: hash('manager123'), name: 'Менеджер', role: 'manager', active: true },
    { id: genId(), username: 'zavhoz', password: hash('zavhoz123'), name: 'Завхоз', role: 'zavhoz', active: true },
    { id: genId(), username: 'baker1', password: hash('baker123'), name: 'Пекарь Смена 1', role: 'baker', active: true },
    { id: genId(), username: 'exp1', password: hash('exp123'), name: 'Экспедитор 1', role: 'expeditor', active: true }
  ]);
  console.log('users: созданы (manager/manager123, zavhoz/zavhoz123, baker1/baker123, exp1/exp123)');
} else console.log('users: уже есть, пропуск');

const empty = ['price_docs', 'ingredient_requests', 'receipts', 'product_price_history',
  'recipes', 'orders', 'production_logs', 'debt_settlements'];
for (const t of empty) if (!exists(t)) { write(t, []); console.log(t + ': пусто'); }
if (!exists('stock')) write('stock', {});
if (!exists('counters')) write('counters', {});

if (!exists('ingredients')) {
  const ings = [
    ['Мука в/с', 'кг', 380], ['Сахар', 'кг', 520], ['Дрожжи прессованные', 'кг', 1200],
    ['Молоко 3.2%', 'л', 620], ['Масло сливочное 82%', 'кг', 4800], ['Яйцо куриное', 'шт', 55],
    ['Соль', 'кг', 150], ['Масло растительное', 'л', 950], ['Крем баварский (основа)', 'кг', 3200],
    ['Сахарная пудра', 'кг', 780]
  ].map(([name, unit, price]) => ({ id: genId(), name, unit, price, active: true, created_at: new Date().toISOString() }));
  write('ingredients', ings);
  console.log('ingredients: демо-справочник создан');
} else console.log('ingredients: уже есть, пропуск');

if (!exists('products')) {
  const prods = [
    ['Донатс классический', 250], ['Донатс баварский крем', 350], ['Берлинер с кремом', 400],
    ['Булочка сдобная', 180], ['Хлеб тостовый', 450]
  ].map(([name, price], i) => ({ id: genId(), name, code: 'P' + String(i + 1).padStart(4, '0'), sale_price: price, active: true }));
  write('products', prods);
  const c = read('counters', {});
  c.product = prods.length; write('counters', c);
  console.log('products: демо-каталог создан');
} else console.log('products: уже есть, пропуск');

// --- Клиенты: дозаливка тестовых (работает и на существующей базе, дублей не создаёт) ---
const TEST_CLIENTS = [
  { code: 'C0001', name: 'Магазин Айгуль', phone: '+7 701 000 00 01', address: 'мкр. 5, д. 12' },
  { code: 'C0002', name: 'ИП Береке', phone: '+7 702 000 00 02', address: 'ул. Абая 3' },
  { code: 'C0003', name: 'ТОО Дастархан', phone: '+7 705 000 00 03', address: 'пр. Мира 41' },
  { code: 'C0004', name: 'Жети Тандыр', phone: '+7 701 000 00 04', address: 'Актау, 3 мкр' },
  { code: 'C0005', name: 'Кафе Достык', phone: '+7 701 000 00 05', address: 'Актау, 5 мкр' },
  { code: 'C0006', name: 'Супермаркет Астыкжан', phone: '+7 701 000 00 06', address: 'Актау, 12 мкр' }
];
const clients = read('clients', []);
let added = 0;
for (const tc of TEST_CLIENTS) {
  if (clients.find(c => c.name.toLowerCase() === tc.name.toLowerCase())) continue;
  clients.push({ id: genId(), ...tc, active: true });
  added++;
}
write('clients', clients);
console.log('clients: добавлено ' + added + ', всего ' + clients.length);

console.log('Готово.');
