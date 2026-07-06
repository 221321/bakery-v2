'use strict';
// ВкусноЦех 2.0 — фронтенд (без сборки, без зависимостей)

let ME = null;
const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');

// ---------- Утилиты ----------
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (r.status === 401) { location.href = '/'; throw new Error('auth'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Ошибка запроса');
  return d;
}
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(t._tm); t._tm = setTimeout(() => t.hidden = true, 3000);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₸'; }
function fdate(s) { if (!s) return ''; return s.slice(0, 10).split('-').reverse().join('.'); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function tomorrowStr() { const d = new Date(Date.now() + 86400000); return d.toISOString().slice(0, 10); }

const STATUS = { new: ['Новый', 'info'], in_transit: ['В пути', 'accent'], delivered: ['Доставлен', 'ok'], cancelled: ['Отменён', 'warn'] };
const PAY = { cash: 'Наличные', qr: 'QR/Kaspi', debt: 'В долг', mixed: 'Частично' };
const UNITS = ['г', 'кг', 'мл', 'л', 'шт', 'уп'];

// ---------- Вкладки по ролям ----------
const TABS = {
  manager: [['orders', 'Заказы'], ['plan', 'План'], ['prices', 'Цены и маржа'], ['stock', 'Остатки'], ['clients', 'Клиенты'], ['reports', 'Отчёты'], ['debts', 'Долги'], ['staff', 'Сотрудники']],
  zavhoz: [['ingredients', 'Сырьё'], ['receipts', 'Поступления'], ['requests', 'Заявки пекарей']],
  baker: [['plan', 'План на день'], ['production', 'Выпуск'], ['recipes', 'Рецепты'], ['myrequests', 'Заявки на сырьё']],
  expeditor: [['queue', 'Очередь'], ['closed', 'Закрытые'], ['debts', 'Долги']]
};
let currentTab = null;

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const [id, label] of TABS[ME.role]) {
    const b = document.createElement('button');
    b.className = 'tab' + (id === currentTab ? ' active' : '');
    b.textContent = label;
    b.onclick = () => { currentTab = id; renderTabs(); PAGES[id](); };
    tabsEl.appendChild(b);
  }
}

// ---------- Страницы ----------
const PAGES = {};

// ===== ЗАВХОЗ: Сырьё =====
PAGES.ingredients = async function () {
  const ings = await api('GET', '/api/ingredients');
  view.innerHTML = `
  <div class="panel">
    <h2>Новое сырьё</h2>
    <div class="row">
      <label class="field"><span>Название</span><input id="inName"></label>
      <label class="field"><span>Ед. изм.</span><select id="inUnit">${UNITS.map(u => `<option>${u}</option>`).join('')}</select></label>
      <label class="field"><span>Цена за ед., ₸</span><input id="inPrice" type="number" min="0" step="0.01"></label>
      <button class="btn btn-primary" id="addIng">Добавить</button>
    </div>
  </div>
  <div class="panel">
    <h2>Справочник сырья <span class="muted">(${ings.length})</span></h2>
    <p class="muted" style="margin-bottom:10px">Цены меняются документом — заполните новые цены и проведите.</p>
    <div class="table-scroll"><table>
      <tr><th>Название</th><th>Ед.</th><th class="num">Текущая цена</th><th class="num">Новая цена</th></tr>
      ${ings.map(i => `<tr><td>${esc(i.name)}</td><td>${i.unit}</td><td class="num">${money(i.price)}</td>
        <td class="num"><input data-ing="${i.id}" class="np" type="number" min="0" step="0.01" style="width:110px;border:1px solid var(--line);border-radius:6px;padding:5px 8px"></td></tr>`).join('')}
    </table></div>
    <div style="margin-top:12px"><button class="btn btn-primary" id="runDoc">Провести документ изменения цен</button></div>
  </div>
  <div class="panel"><h2>История документов цен</h2><div id="docsList" class="muted">Загрузка…</div></div>`;

  document.getElementById('addIng').onclick = async () => {
    try {
      await api('POST', '/api/ingredients', { name: document.getElementById('inName').value, unit: document.getElementById('inUnit').value, price: document.getElementById('inPrice').value });
      toast('Сырьё добавлено'); PAGES.ingredients();
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('runDoc').onclick = async () => {
    const items = [...document.querySelectorAll('.np')].filter(i => i.value !== '').map(i => ({ ingredient_id: i.dataset.ing, new_price: i.value }));
    if (!items.length) return toast('Заполните хотя бы одну новую цену', true);
    try { const d = await api('POST', '/api/price-docs', { items }); toast(`Документ №${d.number} проведён`); PAGES.ingredients(); }
    catch (e) { toast(e.message, true); }
  };
  const docs = await api('GET', '/api/price-docs');
  document.getElementById('docsList').innerHTML = docs.length ? docs.slice(0, 15).map(d =>
    `<div class="list-line"><div><b>№${d.number}</b> от ${fdate(d.date)} <span class="muted">· ${esc(d.author)}</span></div>
     <div class="muted">${d.items.map(it => `${esc(it.name)}: ${it.old_price}→${it.new_price}`).join('; ')}</div></div>`).join('') : 'Документов пока нет';
};

// ===== ЗАВХОЗ: Поступления =====
PAGES.receipts = async function () {
  const ings = await api('GET', '/api/ingredients');
  const receipts = await api('GET', '/api/receipts');
  let lines = [];
  view.innerHTML = `
  <div class="panel">
    <h2>Новое поступление (закуп)</h2>
    <div class="row">
      <label class="field"><span>Поставщик</span><input id="rSupplier"></label>
      <label class="field"><span>Дата</span><input id="rDate" type="date" value="${todayStr()}"></label>
    </div>
    <h3>Позиции</h3>
    <div id="rLines"></div>
    <button class="btn btn-sm" id="rAdd">+ позиция</button>
    <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div class="big" id="rTotal">0 ₸</div>
      <button class="btn btn-primary" id="rSave">Провести поступление</button>
    </div>
  </div>
  <div class="panel"><h2>Поступления</h2><div id="rList"></div></div>`;

  const rLines = document.getElementById('rLines');
  function drawLines() {
    rLines.innerHTML = lines.map((l, i) => `
      <div class="compose-line" style="grid-template-columns:1fr 90px 110px 34px">
        <select data-i="${i}" class="rl-ing"><option value="">— сырьё —</option>${ings.map(g => `<option value="${g.id}" ${l.ingredient_id === g.id ? 'selected' : ''}>${esc(g.name)} (${g.unit})</option>`).join('')}</select>
        <input data-i="${i}" class="rl-qty" type="number" min="0" step="0.001" placeholder="кол-во" value="${l.qty || ''}">
        <input data-i="${i}" class="rl-price" type="number" min="0" step="0.01" placeholder="цена" value="${l.price || ''}">
        <button data-i="${i}" class="x-btn rl-x">×</button>
      </div>`).join('');
    let total = 0;
    lines.forEach(l => total += (Number(l.qty) || 0) * (Number(l.price) || 0));
    document.getElementById('rTotal').textContent = money(total);
    rLines.querySelectorAll('.rl-ing').forEach(s => s.onchange = e => { lines[e.target.dataset.i].ingredient_id = e.target.value; const g = ings.find(x => x.id === e.target.value); if (g && !lines[e.target.dataset.i].price) { lines[e.target.dataset.i].price = g.price; drawLines(); } });
    rLines.querySelectorAll('.rl-qty').forEach(s => s.oninput = e => { lines[e.target.dataset.i].qty = e.target.value; recalc(); });
    rLines.querySelectorAll('.rl-price').forEach(s => s.oninput = e => { lines[e.target.dataset.i].price = e.target.value; recalc(); });
    rLines.querySelectorAll('.rl-x').forEach(b => b.onclick = e => { lines.splice(e.target.dataset.i, 1); drawLines(); });
  }
  function recalc() {
    let total = 0; lines.forEach(l => total += (Number(l.qty) || 0) * (Number(l.price) || 0));
    document.getElementById('rTotal').textContent = money(total);
  }
  document.getElementById('rAdd').onclick = () => { lines.push({}); drawLines(); };
  lines.push({}); drawLines();

  document.getElementById('rSave').onclick = async () => {
    try {
      const d = await api('POST', '/api/receipts', { supplier: document.getElementById('rSupplier').value.trim(), date: document.getElementById('rDate').value, items: lines });
      toast(`Поступление №${d.number} проведено`); PAGES.receipts();
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('rList').innerHTML = receipts.length ? receipts.map(r => `
    <div class="list-line"><div><b>№${r.number}</b> от ${fdate(r.date)} · ${esc(r.supplier)}
      ${r.exported_1c ? '<span class="chip ok">в 1С</span>' : '<span class="chip">ожидает 1С</span>'}</div>
      <div><b>${money(r.total)}</b> <span class="muted">· ${r.items.length} поз.</span></div></div>`).join('') : '<span class="muted">Пока нет</span>';
};

// ===== ЗАВХОЗ: Заявки пекарей =====
PAGES.requests = async function () {
  const reqs = await api('GET', '/api/ingredient-requests');
  const pending = reqs.filter(r => r.status === 'pending');
  view.innerHTML = `
  <div class="panel"><h2>Заявки на новое сырьё ${pending.length ? `<span class="chip accent">${pending.length}</span>` : ''}</h2><div id="reqList"></div></div>`;
  document.getElementById('reqList').innerHTML = reqs.length ? reqs.map(r => {
    if (r.status === 'pending') return `
      <div class="list-line"><div><b>${esc(r.name)}</b> <span class="muted">· ${esc(r.baker_name)} · ${fdate(r.created_at)}</span></div>
      <div class="row" style="align-items:center">
        <select id="u_${r.id}" style="border:1px solid var(--line);border-radius:6px;padding:6px">${UNITS.map(u => `<option>${u}</option>`).join('')}</select>
        <input id="p_${r.id}" type="number" min="0" placeholder="цена" style="width:90px;border:1px solid var(--line);border-radius:6px;padding:6px">
        <button class="btn btn-ok btn-sm" data-a="ok" data-id="${r.id}">Одобрить</button>
        <button class="btn btn-danger btn-sm" data-a="no" data-id="${r.id}">Отклонить</button>
      </div></div>`;
    return `<div class="list-line"><div>${esc(r.name)} <span class="muted">· ${esc(r.baker_name)}</span></div>
      <span class="chip ${r.status === 'approved' ? 'ok' : 'warn'}">${r.status === 'approved' ? 'одобрено' : 'отклонено'}</span></div>`;
  }).join('') : '<span class="muted">Заявок нет</span>';
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    try {
      if (b.dataset.a === 'ok') await api('POST', `/api/ingredient-requests/${id}/approve`, { unit: document.getElementById('u_' + id).value, price: document.getElementById('p_' + id).value });
      else await api('POST', `/api/ingredient-requests/${id}/reject`, {});
      toast('Готово'); PAGES.requests();
    } catch (e) { toast(e.message, true); }
  });
};

// ===== ПЕКАРЬ: Заявки на сырьё =====
PAGES.myrequests = async function () {
  const reqs = await api('GET', '/api/ingredient-requests');
  view.innerHTML = `
  <div class="panel"><h2>Запросить новое сырьё</h2>
    <p class="muted" style="margin-bottom:10px">Если в справочнике нет нужного сырья — отправьте заявку завхозу.</p>
    <div class="row"><label class="field"><span>Название</span><input id="rqName"></label>
    <button class="btn btn-primary" id="rqSend">Отправить</button></div></div>
  <div class="panel"><h2>Мои заявки</h2>${reqs.length ? reqs.map(r => `
    <div class="list-line"><div>${esc(r.name)} <span class="muted">· ${fdate(r.created_at)}</span></div>
    <span class="chip ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'warn' : 'info'}">${r.status === 'approved' ? 'одобрено' : r.status === 'rejected' ? 'отклонено' : 'на рассмотрении'}</span></div>`).join('') : '<span class="muted">Заявок нет</span>'}</div>`;
  document.getElementById('rqSend').onclick = async () => {
    try { await api('POST', '/api/ingredient-requests', { name: document.getElementById('rqName').value }); toast('Заявка отправлена завхозу'); PAGES.myrequests(); }
    catch (e) { toast(e.message, true); }
  };
};

// ===== План производства =====
PAGES.plan = async function (date) {
  date = date || todayStr();
  const plan = await api('GET', '/api/production-plan?date=' + date);
  view.innerHTML = `
  <div class="panel">
    <h2>План производства</h2>
    <div class="row">
      <label class="field"><span>Дата</span><input id="plDate" type="date" value="${date}"></label>
      <button class="btn" id="plToday">Сегодня</button>
      <button class="btn" id="plTomorrow">Завтра</button>
    </div>
    <div class="table-scroll"><table>
      <tr><th>Позиция</th><th class="num">Заказано</th><th class="num">Выпущено</th><th class="num">На складе</th><th class="num">Осталось сделать</th></tr>
      ${plan.rows.length ? plan.rows.map(r => {
        const left = Math.max(0, r.ordered - r.produced - Math.max(0, r.on_hand - r.produced));
        return `<tr><td>${esc(r.name)}</td><td class="num"><b>${r.ordered}</b></td><td class="num">${r.produced}</td>
        <td class="num">${r.on_hand}</td><td class="num">${r.ordered > r.on_hand ? `<span class="chip warn">${r.ordered - r.on_hand}</span>` : '<span class="chip ok">хватает</span>'}</td></tr>`;
      }).join('') : '<tr><td colspan="5" class="muted">На эту дату заказов нет</td></tr>'}
    </table></div>
  </div>`;
  document.getElementById('plDate').onchange = e => PAGES.plan(e.target.value);
  document.getElementById('plToday').onclick = () => PAGES.plan(todayStr());
  document.getElementById('plTomorrow').onclick = () => PAGES.plan(tomorrowStr());
};

// ===== ПЕКАРЬ: Выпуск =====
PAGES.production = async function () {
  const products = await api('GET', '/api/products');
  const logs = await api('GET', '/api/production-logs');
  let lines = [{}];
  view.innerHTML = `
  <div class="panel">
    <h2>Выпуск готовой продукции</h2>
    <div class="row"><label class="field"><span>Дата смены</span><input id="prDate" type="date" value="${todayStr()}"></label></div>
    <div id="prLines"></div>
    <button class="btn btn-sm" id="prAdd">+ позиция</button>
    <div style="margin-top:14px"><button class="btn btn-primary" id="prSave">Зафиксировать выпуск</button></div>
  </div>
  <div class="panel"><h2>Журнал выпуска</h2>${logs.length ? logs.slice(0, 20).map(l => `
    <div class="list-line"><div><b>№${l.number}</b> · ${fdate(l.date)} · ${esc(l.baker_name)}
      ${l.exported_1c ? '<span class="chip ok">в 1С</span>' : '<span class="chip">ожидает 1С</span>'}</div>
      <div class="muted">${l.items.map(i => `${esc(i.name)} — ${i.qty}`).join('; ')}</div></div>`).join('') : '<span class="muted">Пока нет</span>'}</div>`;

  const box = document.getElementById('prLines');
  function draw() {
    box.innerHTML = lines.map((l, i) => `
      <div class="compose-line">
        <select data-i="${i}" class="pr-p"><option value="">— позиция —</option>${products.map(p => `<option value="${p.id}" ${l.product_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <input data-i="${i}" class="pr-q" type="number" min="0" step="1" placeholder="шт" value="${l.qty || ''}">
        <button data-i="${i}" class="x-btn pr-x">×</button>
      </div>`).join('');
    box.querySelectorAll('.pr-p').forEach(s => s.onchange = e => lines[e.target.dataset.i].product_id = e.target.value);
    box.querySelectorAll('.pr-q').forEach(s => s.oninput = e => lines[e.target.dataset.i].qty = e.target.value);
    box.querySelectorAll('.pr-x').forEach(b => b.onclick = e => { lines.splice(e.target.dataset.i, 1); draw(); });
  }
  draw();
  document.getElementById('prAdd').onclick = () => { lines.push({}); draw(); };
  document.getElementById('prSave').onclick = async () => {
    try {
      const d = await api('POST', '/api/production-logs', { date: document.getElementById('prDate').value, items: lines });
      toast(`Выпуск №${d.number} зафиксирован — остатки обновлены`); PAGES.production();
    } catch (e) { toast(e.message, true); }
  };
};

// ===== Рецепты (пекарь без цен, менеджер с себестоимостью) =====
PAGES.recipes = async function () {
  const [recipes, products, ings] = await Promise.all([api('GET', '/api/recipes'), api('GET', '/api/products'), api('GET', '/api/ingredients')]);
  const semis = recipes.filter(r => r.is_semifinished);
  const withCost = ME.role === 'manager';
  const productsFree = products.filter(p => !recipes.find(r => r.product_id === p.id && !r.is_semifinished));
  let lines = [{}];
  view.innerHTML = `
  <div class="panel">
    <h2>Новый рецепт</h2>
    <div class="row">
      <label class="field"><span>Тип</span><select id="rcType"><option value="product">Готовая продукция (из каталога)</option><option value="semi">Полуфабрикат</option></select></label>
      <label class="field" id="rcProdBox"><span>Позиция каталога</span><select id="rcProd">${productsFree.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">— все позиции уже с рецептами —</option>'}</select></label>
      <label class="field" id="rcNameBox" style="display:none"><span>Название полуфабриката</span><input id="rcName"></label>
      <label class="field"><span>Выход, шт/порций</span><input id="rcOut" type="number" min="1" value="1"></label>
    </div>
    <h3>Состав (граммовки на весь выход)</h3>
    <div id="rcLines"></div>
    <button class="btn btn-sm" id="rcAdd">+ строка состава</button>
    <div style="margin-top:14px"><button class="btn btn-primary" id="rcSave">Сохранить рецепт</button> <span class="muted" style="font-size:.84rem">После сохранения изменить рецепт может только суперадмин</span></div>
  </div>
  <div class="panel"><h2>Рецепты <span class="muted">(${recipes.length})</span></h2><div id="rcList"></div></div>`;

  document.getElementById('rcType').onchange = e => {
    document.getElementById('rcProdBox').style.display = e.target.value === 'product' ? '' : 'none';
    document.getElementById('rcNameBox').style.display = e.target.value === 'semi' ? '' : 'none';
  };
  const box = document.getElementById('rcLines');
  function opts(sel) {
    return `<option value="">— выбрать —</option>
      <optgroup label="Сырьё">${ings.map(g => `<option value="i:${g.id}" ${sel === 'i:' + g.id ? 'selected' : ''}>${esc(g.name)} (${g.unit})</option>`).join('')}</optgroup>
      ${semis.length ? `<optgroup label="Полуфабрикаты">${semis.map(s => `<option value="r:${s.id}" ${sel === 'r:' + s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup>` : ''}`;
  }
  function draw() {
    box.innerHTML = lines.map((l, i) => `
      <div class="compose-line">
        <select data-i="${i}" class="rc-ref">${opts(l.ref)}</select>
        <input data-i="${i}" class="rc-q" type="number" min="0" step="0.001" placeholder="кол-во" value="${l.qty || ''}">
        <button data-i="${i}" class="x-btn rc-x">×</button>
      </div>`).join('');
    box.querySelectorAll('.rc-ref').forEach(s => s.onchange = e => lines[e.target.dataset.i].ref = e.target.value);
    box.querySelectorAll('.rc-q').forEach(s => s.oninput = e => lines[e.target.dataset.i].qty = e.target.value);
    box.querySelectorAll('.rc-x').forEach(b => b.onclick = e => { lines.splice(e.target.dataset.i, 1); draw(); });
  }
  draw();
  document.getElementById('rcAdd').onclick = () => { lines.push({}); draw(); };
  document.getElementById('rcSave').onclick = async () => {
    const isSemi = document.getElementById('rcType').value === 'semi';
    const items = lines.filter(l => l.ref && Number(l.qty) > 0).map(l => {
      const [t, id] = l.ref.split(':');
      return { type: t === 'i' ? 'ingredient' : 'recipe', ref_id: id, qty: Number(l.qty) };
    });
    try {
      await api('POST', '/api/recipes', { is_semifinished: isSemi, product_id: isSemi ? null : document.getElementById('rcProd').value, name: isSemi ? document.getElementById('rcName').value : null, output_qty: document.getElementById('rcOut').value, items });
      toast('Рецепт сохранён'); PAGES.recipes();
    } catch (e) { toast(e.message, true); }
  };
  // --- Дерево состава: рецепт в рецепте, разворачивается вглубь ---
  function composeTree(recipe, depth) {
    depth = depth || 0;
    if (depth > 6) return '';
    return recipe.items.map(it => {
      if (it.type === 'ingredient') {
        const g = ings.find(x => x.id === it.ref_id);
        return `<div class="tree-line" style="padding-left:${depth * 18}px">• ${esc(g ? g.name : '?')} — <b>${it.qty}</b> ${g ? g.unit : ''}</div>`;
      }
      const sub = recipes.find(x => x.id === it.ref_id);
      if (!sub) return '';
      return `<div class="tree-line pf" style="padding-left:${depth * 18}px">▸ <b>${esc(sub.name)}</b> <span class="chip info">ПФ</span> — ${it.qty} (выход рецепта: ${sub.output_qty})</div>` + composeTree(sub, depth + 1);
    }).join('');
  }
  // --- Группировка: категория → позиции ---
  const finished = recipes.filter(r => !r.is_semifinished);
  const groups = {};
  for (const r of finished) {
    const p = products.find(x => x.id === r.product_id);
    const cat = (p && p.category) || 'Прочее';
    (groups[cat] = groups[cat] || []).push(r);
  }
  const catNames = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ru'));
  let html = catNames.map((cat, ci) => `
    <div class="cat-block">
      <div class="cat-head" data-cat="${ci}"><span class="arr">▸</span> ${esc(cat)} <span class="muted">(${groups[cat].length})</span></div>
      <div class="cat-body" id="catB${ci}" hidden>
        ${groups[cat].map((r, ri) => `
          <div class="rec-item">
            <div class="rec-head" data-rec="${ci}_${ri}"><span class="arr">▸</span> ${esc(r.name)} <span class="muted">· выход ${r.output_qty}</span>
              ${withCost && r.cost !== undefined ? `<span class="chip accent">себест. ${money(r.cost / (r.output_qty || 1))}/ед.</span>` : ''}</div>
            <div class="rec-body" id="recB${ci}_${ri}" hidden>${composeTree(r)}</div>
          </div>`).join('')}
      </div>
    </div>`).join('');
  if (semis.length) {
    html += `<div class="cat-block">
      <div class="cat-head" data-cat="pf"><span class="arr">▸</span> Полуфабрикаты <span class="muted">(${semis.length})</span></div>
      <div class="cat-body" id="catBpf" hidden>
        ${semis.map((r, ri) => `
          <div class="rec-item">
            <div class="rec-head" data-rec="pf_${ri}"><span class="arr">▸</span> ${esc(r.name)} <span class="muted">· выход ${r.output_qty}</span></div>
            <div class="rec-body" id="recBpf_${ri}" hidden>${composeTree(r)}</div>
          </div>`).join('')}
      </div>
    </div>`;
  }
  document.getElementById('rcList').innerHTML = html || '<span class="muted">Рецептов пока нет</span>';
  document.querySelectorAll('.cat-head').forEach(h => h.onclick = () => {
    const b = document.getElementById('catB' + h.dataset.cat);
    b.hidden = !b.hidden; h.querySelector('.arr').textContent = b.hidden ? '▸' : '▾';
  });
  document.querySelectorAll('.rec-head').forEach(h => h.onclick = e => {
    e.stopPropagation();
    const b = document.getElementById('recB' + h.dataset.rec);
    b.hidden = !b.hidden; h.querySelector('.arr').textContent = b.hidden ? '▸' : '▾';
  });
};

// ===== МЕНЕДЖЕР: Цены и маржа =====
PAGES.prices = async function () {
  const products = await api('GET', '/api/products');
  view.innerHTML = `
  <div class="panel">
    <h2>Новая позиция каталога</h2>
    <div class="row">
      <label class="field"><span>Название</span><input id="npName"></label>
      <label class="field"><span>Категория</span><input id="npCat" list="catList" placeholder="Донатсы / Сэндвичи ..."><datalist id="catList"><option>Донатсы</option><option>Берлинеры</option><option>Пирожные и чизкейки</option><option>Арт-десерты</option><option>Сэндвичи</option><option>Хлебобулочные</option><option>Прочее</option></datalist></label>
      <label class="field"><span>Цена продажи, ₸</span><input id="npPrice" type="number" min="0"></label>
      <button class="btn btn-primary" id="npAdd">Добавить</button>
    </div>
  </div>
  <div class="panel">
    <h2>Каталог, себестоимость и маржа</h2>
    <p class="muted" style="margin-bottom:10px">Себестоимость считается из рецептов пекаря по ценам сырья завхоза. Цена продажи меняется с историей.</p>
    <div class="table-scroll"><table>
      <tr><th>Позиция</th><th>Код</th><th class="num">Себестоимость</th><th class="num">Цена продажи</th><th class="num">Маржа</th><th></th></tr>
      ${products.map(p => `<tr>
        <td>${esc(p.name)}</td><td class="muted">${p.code}</td>
        <td class="num">${p.cost === null ? '<span class="chip warn">нет рецепта</span>' : money(p.cost)}</td>
        <td class="num"><input data-p="${p.id}" class="sp" type="number" min="0" value="${p.sale_price}" style="width:100px;border:1px solid var(--line);border-radius:6px;padding:5px 8px;text-align:right"></td>
        <td class="num">${p.margin === null ? '—' : `<b>${money(p.margin)}</b> <span class="muted">(${p.margin_pct}%)</span>`}</td>
        <td><button class="btn btn-sm sp-save" data-p="${p.id}">Сохранить</button></td></tr>`).join('')}
    </table></div>
  </div>`;
  document.getElementById('npAdd').onclick = async () => {
    try { await api('POST', '/api/products', { name: document.getElementById('npName').value, category: document.getElementById('npCat').value, sale_price: document.getElementById('npPrice').value }); toast('Позиция добавлена'); PAGES.prices(); }
    catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('.sp-save').forEach(b => b.onclick = async () => {
    const inp = document.querySelector(`.sp[data-p="${b.dataset.p}"]`);
    try { await api('POST', `/api/products/${b.dataset.p}/price`, { price: inp.value }); toast('Цена обновлена (с историей)'); PAGES.prices(); }
    catch (e) { toast(e.message, true); }
  });
};

// ===== Остатки =====
PAGES.stock = async function () {
  const st = await api('GET', '/api/stock');
  view.innerHTML = `<div class="panel"><h2>Остатки готовой продукции</h2>
  <div class="table-scroll"><table>
    <tr><th>Позиция</th><th class="num">На складе</th><th class="num">В резерве (заказы)</th><th class="num">Доступно</th></tr>
    ${st.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.on_hand}</td><td class="num">${s.reserved}</td>
      <td class="num">${s.available < 0 ? `<span class="chip warn">${s.available}</span>` : `<b>${s.available}</b>`}</td></tr>`).join('')}
  </table></div></div>`;
};

// ===== МЕНЕДЖЕР: Клиенты =====
PAGES.clients = async function () {
  const clients = await api('GET', '/api/clients');
  view.innerHTML = `
  <div class="panel"><h2>Новый клиент</h2>
    <div class="row">
      <label class="field"><span>Название</span><input id="clName"></label>
      <label class="field"><span>Телефон</span><input id="clPhone"></label>
      <label class="field"><span>Адрес</span><input id="clAddr"></label>
      <button class="btn btn-primary" id="clAdd">Добавить</button>
    </div>
    <p class="muted" style="margin-top:8px">Клиенты также подтягиваются из 1С кнопкой «Синхронизировать контрагентов» в расширении.</p>
  </div>
  <div class="panel"><h2>Клиенты</h2>
    <label class="field"><span>Поиск</span><input id="clQ" placeholder="название или код"></label>
    <div id="clList"></div>
  </div>`;
  function draw(list) {
    document.getElementById('clList').innerHTML = list.map(c => `
      <div class="list-line"><div><b>${esc(c.name)}</b> <span class="muted">${c.code}</span>
      <div class="muted" style="font-size:.84rem">${esc(c.address || '')} ${esc(c.phone || '')}</div></div></div>`).join('') || '<span class="muted">Не найдено</span>';
  }
  draw(clients);
  document.getElementById('clQ').oninput = async e => draw(await api('GET', '/api/clients?q=' + encodeURIComponent(e.target.value)));
  document.getElementById('clAdd').onclick = async () => {
    try { await api('POST', '/api/clients', { name: document.getElementById('clName').value, phone: document.getElementById('clPhone').value, address: document.getElementById('clAddr').value }); toast('Клиент добавлен'); PAGES.clients(); }
    catch (e) { toast(e.message, true); }
  };
};

// ===== МЕНЕДЖЕР: Заказы =====
PAGES.orders = async function (filterDate) {
  const products = await api('GET', '/api/products');
  const stock = await api('GET', '/api/stock');
  const avail = {}; stock.forEach(s => avail[s.product_id] = s.available);
  let selClient = null, lines = [{}];
  const fDate = filterDate || tomorrowStr();
  const orders = await api('GET', '/api/orders?delivery_date=' + fDate);
  view.innerHTML = `
  <div class="panel">
    <h2>Новый заказ (на завтра или другую дату)</h2>
    <div class="row">
      <label class="field search-results" style="flex:1;min-width:220px"><span>Клиент</span>
        <input id="oCl" placeholder="начните вводить название" autocomplete="off">
        <div class="search-drop" id="oClDrop" hidden></div>
      </label>
      <label class="field"><span>Дата доставки</span><input id="oDate" type="date" value="${tomorrowStr()}"></label>
    </div>
    <h3>Позиции <span class="muted">(доступно = на складе минус резерв)</span></h3>
    <div id="oLines"></div>
    <button class="btn btn-sm" id="oAdd">+ позиция</button>
    <div class="row" style="margin-top:12px"><label class="field" style="flex:1"><span>Комментарий</span><input id="oComment"></label></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div class="big" id="oTotal">0 ₸</div>
      <button class="btn btn-primary" id="oSave">Создать заказ</button>
    </div>
  </div>
  <div class="panel">
    <h2>Заказы на дату</h2>
    <div class="row"><label class="field"><span>Дата доставки</span><input id="fDate" type="date" value="${fDate}"></label></div>
    <div id="oList"></div>
  </div>`;

  // живой поиск клиента
  const oCl = document.getElementById('oCl'), drop = document.getElementById('oClDrop');
  oCl.oninput = async () => {
    selClient = null;
    const q = oCl.value.trim();
    if (q.length < 1) { drop.hidden = true; return; }
    const list = await api('GET', '/api/clients?q=' + encodeURIComponent(q));
    drop.innerHTML = list.map(c => `<div data-id="${c.id}" data-name="${esc(c.name)}">${esc(c.name)} <span class="muted">${c.code}</span></div>`).join('') || '<div class="muted">не найдено</div>';
    drop.hidden = false;
    drop.querySelectorAll('[data-id]').forEach(el => el.onclick = () => { selClient = el.dataset.id; oCl.value = el.dataset.name; drop.hidden = true; });
  };
  document.addEventListener('click', e => { if (!e.target.closest('.search-results')) drop.hidden = true; });

  const oLines = document.getElementById('oLines');
  function draw() {
    oLines.innerHTML = lines.map((l, i) => `
      <div class="compose-line" style="grid-template-columns:1fr 90px 34px">
        <select data-i="${i}" class="ol-p"><option value="">— позиция —</option>${products.map(p => `<option value="${p.id}" ${l.product_id === p.id ? 'selected' : ''}>${esc(p.name)} · ${money(p.sale_price)} · дост. ${avail[p.id] ?? 0}</option>`).join('')}</select>
        <input data-i="${i}" class="ol-q" type="number" min="0" step="1" placeholder="шт" value="${l.qty || ''}">
        <button data-i="${i}" class="x-btn ol-x">×</button>
      </div>`).join('');
    let total = 0;
    lines.forEach(l => { const p = products.find(x => x.id === l.product_id); if (p) total += (Number(l.qty) || 0) * p.sale_price; });
    document.getElementById('oTotal').textContent = money(total);
    oLines.querySelectorAll('.ol-p').forEach(s => s.onchange = e => { lines[e.target.dataset.i].product_id = e.target.value; draw(); });
    oLines.querySelectorAll('.ol-q').forEach(s => s.oninput = e => { lines[e.target.dataset.i].qty = e.target.value; let t = 0; lines.forEach(l => { const p = products.find(x => x.id === l.product_id); if (p) t += (Number(l.qty) || 0) * p.sale_price; }); document.getElementById('oTotal').textContent = money(t); });
    oLines.querySelectorAll('.ol-x').forEach(b => b.onclick = e => { lines.splice(e.target.dataset.i, 1); draw(); });
  }
  draw();
  document.getElementById('oAdd').onclick = () => { lines.push({}); draw(); };
  document.getElementById('oSave').onclick = async () => {
    if (!selClient) return toast('Выберите клиента из списка', true);
    try {
      const d = await api('POST', '/api/orders', { client_id: selClient, delivery_date: document.getElementById('oDate').value, items: lines, comment: document.getElementById('oComment').value });
      toast(`Заказ №${d.number} создан`); PAGES.orders(document.getElementById('fDate').value);
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('fDate').onchange = e => PAGES.orders(e.target.value);
  document.getElementById('oList').innerHTML = orders.length ? orders.map(o => orderCard(o, true)).join('') : '<span class="muted">Заказов на эту дату нет</span>';
  bindOrderActions(() => PAGES.orders(document.getElementById('fDate').value));
};

function orderCard(o, managerMode) {
  const [sName, sCls] = STATUS[o.status] || [o.status, ''];
  return `<div class="order-card">
    <div class="order-head">
      <div class="order-title">№${o.number} · ${esc(o.client_name)}</div>
      <div><span class="chip ${sCls}">${sName}</span> ${o.realized_1c ? '<span class="chip ok">реализация в 1С</span>' : ''}</div>
    </div>
    <div class="muted" style="font-size:.85rem">${fdate(o.delivery_date)} · ${esc(o.client_address || '')} ${esc(o.client_phone || '')} ${o.expeditor_name ? '· экспедитор: ' + esc(o.expeditor_name) : ''}${o.comment ? ' · ' + esc(o.comment) : ''}</div>
    <ul class="order-items">${o.items.map(i => `<li><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.sum)}</span></li>`).join('')}</ul>
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b>${money(o.total)}</b>
      ${o.payment ? `<span class="muted">${PAY[o.payment.method]}: оплачено ${money(o.payment.paid_amount)}${o.payment.debt_amount > 0 ? `, долг <b style="color:var(--warn)">${money(o.payment.debt_amount)}</b>` : ''}</span>` : ''}
    </div>
    <div class="order-actions">
      ${o.status === 'new' && ME.role === 'expeditor' ? `<button class="btn btn-primary btn-sm act-take" data-id="${o.id}">Взять в доставку</button>` : ''}
      ${(o.status === 'in_transit' || (o.status === 'new' && ME.role === 'manager')) ? `<button class="btn btn-ok btn-sm act-deliver" data-id="${o.id}" data-total="${o.total}">Доставлен + оплата</button>` : ''}
      ${managerMode && (o.status === 'new' || o.status === 'in_transit') ? `<button class="btn btn-danger btn-sm act-cancel" data-id="${o.id}">Отменить</button>` : ''}
    </div>
  </div>`;
}
function bindOrderActions(reload) {
  document.querySelectorAll('.act-take').forEach(b => b.onclick = async () => {
    try { await api('POST', `/api/orders/${b.dataset.id}/take`, {}); toast('Заказ у вас'); reload(); } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('.act-cancel').forEach(b => b.onclick = async () => {
    if (!confirm('Отменить заказ?')) return;
    try { await api('POST', `/api/orders/${b.dataset.id}/cancel`, {}); toast('Отменён'); reload(); } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('.act-deliver').forEach(b => b.onclick = () => {
    const total = Number(b.dataset.total);
    const card = b.closest('.order-card');
    if (card.querySelector('.pay-box')) return;
    const box = document.createElement('div');
    box.className = 'pay-box';
    box.innerHTML = `<div class="row" style="margin-top:10px;align-items:center">
      <select class="pay-m" style="border:1px solid var(--line);border-radius:6px;padding:7px">
        <option value="cash">Наличные (вся сумма)</option><option value="qr">QR/Kaspi (вся сумма)</option>
        <option value="debt">Полностью в долг</option><option value="mixed">Частично</option></select>
      <input class="pay-a" type="number" min="0" max="${total}" placeholder="оплачено, ₸" style="width:130px;border:1px solid var(--line);border-radius:6px;padding:7px" hidden>
      <button class="btn btn-ok btn-sm pay-go">Подтвердить</button></div>`;
    card.appendChild(box);
    const sel = box.querySelector('.pay-m'), amt = box.querySelector('.pay-a');
    sel.onchange = () => amt.hidden = sel.value !== 'mixed';
    box.querySelector('.pay-go').onclick = async () => {
      try {
        await api('POST', `/api/orders/${b.dataset.id}/deliver`, { method: sel.value, paid_amount: sel.value === 'mixed' ? amt.value : undefined });
        toast('Доставка и оплата зафиксированы'); reload();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ===== ЭКСПЕДИТОР: Очередь =====
PAGES.queue = async function () {
  const [news, transit] = await Promise.all([
    api('GET', '/api/orders?status=new&delivery_date=' + todayStr()),
    api('GET', '/api/orders?status=in_transit')
  ]);
  const mine = transit.filter(o => o.expeditor_id === ME.id);
  view.innerHTML = `
  ${mine.length ? `<div class="panel"><h2>У меня в доставке (${mine.length})</h2>${mine.map(o => orderCard(o)).join('')}</div>` : ''}
  <div class="panel"><h2>Очередь на сегодня (${news.length})</h2>${news.length ? news.map(o => orderCard(o)).join('') : '<span class="muted">Новых заказов нет</span>'}</div>`;
  bindOrderActions(PAGES.queue);
};

// ===== ЭКСПЕДИТОР: Закрытые =====
PAGES.closed = async function (date) {
  date = date || todayStr();
  const orders = (await api('GET', `/api/orders?status=delivered&from=${date}&to=${date}`)).filter(o => o.expeditor_id === ME.id);
  let cash = 0, qr = 0, debt = 0;
  orders.forEach(o => { if (o.payment) { if (o.payment.method === 'qr') qr += o.payment.paid_amount; else cash += o.payment.paid_amount; debt += o.payment.debt_amount || 0; } });
  view.innerHTML = `
  <div class="panel"><h2>Мои закрытые заказы</h2>
    <div class="row"><label class="field"><span>Дата</span><input id="cDate" type="date" value="${date}"></label></div>
    <div class="cards">
      <div class="stat"><div class="lbl">Наличные</div><div class="big">${money(cash)}</div></div>
      <div class="stat"><div class="lbl">QR/Kaspi</div><div class="big">${money(qr)}</div></div>
      <div class="stat"><div class="lbl">В долг</div><div class="big" style="color:var(--warn)">${money(debt)}</div></div>
    </div>
    ${orders.length ? orders.map(o => orderCard(o)).join('') : '<span class="muted">Нет доставленных за дату</span>'}
  </div>`;
  document.getElementById('cDate').onchange = e => PAGES.closed(e.target.value);
};

// ===== Долги =====
PAGES.debts = async function () {
  const debts = await api('GET', '/api/debts');
  view.innerHTML = `
  <div class="panel"><h2>Долги клиентов</h2>
    ${debts.length ? debts.map(d => `
      <div class="order-card">
        <div class="order-head"><div class="order-title">${esc(d.client_name)}</div>
          <div><b style="color:var(--warn)">${money(d.debt)}</b> ${d.days_overdue >= 7 ? `<span class="chip warn">просрочка ${d.days_overdue} дн.</span>` : `<span class="chip">${d.days_overdue} дн.</span>`}</div></div>
        <div class="muted" style="font-size:.84rem">${d.orders.map(o => `№${o.number} от ${fdate(o.date)}: ${money(o.amount)}`).join(' · ')}</div>
        <div class="row" style="margin-top:10px;align-items:center">
          <input data-c="${d.client_id}" class="dp-a" type="number" min="0" max="${d.debt}" placeholder="сумма погашения" style="width:160px;border:1px solid var(--line);border-radius:6px;padding:7px">
          <select data-c="${d.client_id}" class="dp-m" style="border:1px solid var(--line);border-radius:6px;padding:7px"><option value="cash">Наличные</option><option value="qr">QR/Kaspi</option></select>
          <button class="btn btn-ok btn-sm dp-go" data-c="${d.client_id}">Принять оплату</button>
        </div>
      </div>`).join('') : '<span class="muted">Долгов нет 🎉</span>'}
  </div>
  <div class="panel"><h2>История погашений</h2><div id="dsList" class="muted">Загрузка…</div></div>`;
  document.querySelectorAll('.dp-go').forEach(b => b.onclick = async () => {
    const cid = b.dataset.c;
    const amt = document.querySelector(`.dp-a[data-c="${cid}"]`).value;
    const m = document.querySelector(`.dp-m[data-c="${cid}"]`).value;
    try { await api('POST', '/api/debt-settlements', { client_id: cid, amount: amt, method: m }); toast('Погашение зафиксировано'); PAGES.debts(); }
    catch (e) { toast(e.message, true); }
  });
  const ds = await api('GET', '/api/debt-settlements');
  document.getElementById('dsList').innerHTML = ds.length ? ds.slice(0, 20).map(s => `
    <div class="list-line"><div>№${s.number} · ${esc(s.client_name)} <span class="muted">· ${fdate(s.date)} · ${esc(s.author)} · ${s.method === 'qr' ? 'QR' : 'нал'}</span>
    ${s.exported_1c ? '<span class="chip ok">в 1С</span>' : ''}</div><b>${money(s.amount)}</b></div>`).join('') : 'Пока нет';
};

// ===== МЕНЕДЖЕР: Отчёты =====
PAGES.reports = async function (from, to) {
  from = from || todayStr(); to = to || todayStr();
  const r = await api('GET', `/api/reports/sales?from=${from}&to=${to}`);
  view.innerHTML = `
  <div class="panel"><h2>Отчёт по продажам</h2>
    <div class="row">
      <label class="field"><span>С</span><input id="rpFrom" type="date" value="${from}"></label>
      <label class="field"><span>По</span><input id="rpTo" type="date" value="${to}"></label>
      <button class="btn btn-primary" id="rpGo">Показать</button>
    </div>
    <div class="cards">
      <div class="stat"><div class="lbl">Заказов</div><div class="big">${r.orders_count}</div></div>
      <div class="stat"><div class="lbl">Выручка</div><div class="big">${money(r.total)}</div></div>
      <div class="stat"><div class="lbl">Наличные</div><div class="big">${money(r.cash)}</div></div>
      <div class="stat"><div class="lbl">QR/Kaspi</div><div class="big">${money(r.qr)}</div></div>
      <div class="stat"><div class="lbl">Ушло в долг</div><div class="big" style="color:var(--warn)">${money(r.debt)}</div></div>
      <div class="stat"><div class="lbl">Себестоимость</div><div class="big">${money(r.cost_total)}</div></div>
      <div class="stat"><div class="lbl">Валовая маржа</div><div class="big" style="color:var(--ok)">${money(r.margin)}</div></div>
    </div>
    <h3>По позициям</h3>
    <div class="table-scroll"><table>
      <tr><th>Позиция</th><th class="num">Кол-во</th><th class="num">Сумма</th><th class="num">С/с за ед.</th></tr>
      ${r.by_product.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${money(p.sum)}</td><td class="num">${p.cost_unit === null ? '—' : money(p.cost_unit)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Нет данных</td></tr>'}
    </table></div>
    <h3>По экспедиторам</h3>
    <div class="table-scroll"><table>
      <tr><th>Экспедитор</th><th class="num">Заказов</th><th class="num">Сумма</th><th class="num">Принято денег</th><th class="num">В долг</th></tr>
      ${r.by_expeditor.map(e => `<tr><td>${esc(e.name)}</td><td class="num">${e.orders}</td><td class="num">${money(e.total)}</td><td class="num">${money(e.cash)}</td><td class="num">${money(e.debt)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Нет данных</td></tr>'}
    </table></div>
  </div>`;
  document.getElementById('rpGo').onclick = () => PAGES.reports(document.getElementById('rpFrom').value, document.getElementById('rpTo').value);
};

// ===== МЕНЕДЖЕР: Сотрудники =====
PAGES.staff = async function () {
  const users = await api('GET', '/api/users');
  const ROLE_RU = { manager: 'Менеджер', zavhoz: 'Завхоз', baker: 'Пекарь', expeditor: 'Экспедитор' };
  view.innerHTML = `
  <div class="panel"><h2>Новый сотрудник</h2>
    <div class="row">
      <label class="field"><span>ФИО</span><input id="stName"></label>
      <label class="field"><span>Логин</span><input id="stLogin"></label>
      <label class="field"><span>Пароль</span><input id="stPass"></label>
      <label class="field"><span>Роль</span><select id="stRole">
        <option value="baker">Пекарь</option><option value="zavhoz">Завхоз</option>
        <option value="expeditor">Экспедитор</option><option value="manager">Менеджер</option></select></label>
      <button class="btn btn-primary" id="stAdd">Создать</button>
    </div>
  </div>
  <div class="panel"><h2>Сотрудники</h2>
    ${users.map(u => `<div class="list-line">
      <div><b>${esc(u.name)}</b> <span class="muted">· ${u.username} · ${ROLE_RU[u.role]}</span></div>
      <div class="row" style="align-items:center">
        ${u.active ? `<button class="btn btn-sm st-off" data-id="${u.id}">Отключить</button>` : `<span class="chip warn">отключён</span> <button class="btn btn-ok btn-sm st-on" data-id="${u.id}">Включить</button>`}
      </div></div>`).join('')}
  </div>`;
  document.getElementById('stAdd').onclick = async () => {
    try {
      await api('POST', '/api/users', { name: document.getElementById('stName').value, username: document.getElementById('stLogin').value, password: document.getElementById('stPass').value, role: document.getElementById('stRole').value });
      toast('Сотрудник создан'); PAGES.staff();
    } catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('.st-off').forEach(b => b.onclick = async () => { await api('PUT', '/api/users/' + b.dataset.id, { active: false }); PAGES.staff(); });
  document.querySelectorAll('.st-on').forEach(b => b.onclick = async () => { await api('PUT', '/api/users/' + b.dataset.id, { active: true }); PAGES.staff(); });
};

// ---------- Старт ----------
(async function init() {
  try { ME = await api('GET', '/api/me'); } catch (e) { return; }
  document.getElementById('userName').textContent = ME.name;
  document.getElementById('logoutBtn').onclick = async () => { await api('POST', '/api/logout', {}); location.href = '/'; };
  currentTab = TABS[ME.role][0][0];
  renderTabs();
  PAGES[currentTab]();
})();
