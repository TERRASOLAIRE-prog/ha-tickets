/* Tickets Board - interface façon Monday pour Home Assistant */
'use strict';

// ------------------------------------------------------------------ utilitaires
const $ = (s, el = document) => el.querySelector(s);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.error || msg; } catch (e) { try { msg = await r.text(); } catch (_) {} }
    toast(msg || 'Erreur', true);
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = '', 2600);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('tickets.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tickets.' + k, JSON.stringify(v)); } catch (e) {} },
};

const PALETTE = ['#00c875', '#9cd326', '#cab641', '#ffcb00', '#fdab3d', '#ff642e', '#e2445c', '#ff158a', '#bb3354',
  '#a25ddc', '#784bd1', '#579bfc', '#0086c0', '#66ccff', '#037f4c', '#c4c4c4', '#808080', '#333333'];

const TYPES = {
  text: { label: 'Texte', icon: 'T', color: '#fdab3d' },
  number: { label: 'Nombre', icon: '#', color: '#ffcb00' },
  status: { label: 'Statut', icon: '◉', color: '#00c875' },
  dropdown: { label: 'Liste déroulante', icon: '☰', color: '#00a9ff' },
  date: { label: 'Date', icon: '📅', color: '#a25ddc' },
  person: { label: 'Personne', icon: '👤', color: '#579bfc' },
  checkbox: { label: 'Case à cocher', icon: '✓', color: '#e2445c' },
  link: { label: 'Lien', icon: '🔗', color: '#0086c0' },
  photo: { label: 'Photo', icon: '📷', color: '#ff642e' },
};

function initials(name) {
  return (name || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');
}
function hashColor(s) {
  let x = 0; for (const c of (s || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[x % 15];
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function todayISO() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }

// ------------------------------------------------------------------ état
const S = {
  boards: [], boardId: store.get('board', null), data: null, persons: [], services: [], me: null,
  search: '', personFilter: '', drawerItem: null, lastJson: '',
};
const colById = id => S.data.columns.find(c => String(c.id) === String(id));
const groupById = id => S.data.groups.find(g => String(g.id) === String(id));
const itemById = id => S.data.items.find(i => String(i.id) === String(id));

async function loadBoards() {
  S.boards = await api('GET', 'api/boards');
  if (!S.boards.find(b => b.id === S.boardId)) S.boardId = S.boards[0] ? S.boards[0].id : null;
}
async function loadBoard(silent) {
  if (!S.boardId) { S.data = null; render(); return; }
  const data = await api('GET', 'api/boards/' + S.boardId);
  const js = JSON.stringify(data);
  if (silent && js === S.lastJson) return;
  S.lastJson = js; S.data = data;
  render();
  if (S.drawerItem) renderDrawer();
}
async function refresh() { await loadBoard(); }

// Mutation sur un élément : rechargement complet si des automatisations peuvent réagir.
async function patchItem(item, body, opts = {}) {
  await api('PATCH', 'api/items/' + item.id, body);
  if (S.data.automations_count > 0 || body.group_id !== undefined || opts.reload) return refresh();
  if (body.name !== undefined) item.name = body.name;
  if (body.values) for (const [k, v] of Object.entries(body.values)) {
    if (v === null || v === '') delete item.values[k]; else item.values[k] = v;
  }
  S.lastJson = '';
  if (opts.rerender) { render(); if (S.drawerItem) renderDrawer(); }
}
function setVal(item, col, value, rerender = true) {
  return patchItem(item, { values: { [col.id]: value } }, { rerender });
}

// ------------------------------------------------------------------ popovers & modales
let currentPop = null;
function closePop() { if (currentPop) { currentPop.remove(); currentPop = null; } }
function popover(anchor, content, opts = {}) {
  closePop();
  const pop = h('div', { class: 'popover' + (opts.menu ? ' menu' : '') }, content);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2, top = r.bottom + 4;
  if (opts.align === 'left') left = r.left;
  left = Math.max(8, Math.min(left, innerWidth - pw - 8));
  if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  currentPop = pop;
  setTimeout(() => { const f = pop.querySelector('input:not([type=color]):not([type=file])'); if (f && !opts.nofocus) f.focus(); }, 10);
  return pop;
}
document.addEventListener('mousedown', e => {
  if (currentPop && !currentPop.contains(e.target)) closePop();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (currentPop) return closePop();
    const m = $('#overlay-root').lastElementChild; if (m) m.remove();
  }
});

function menu(anchor, entries) {
  const items = entries.filter(Boolean).map(e => e === '-' ? h('hr') :
    h('button', { class: e.danger ? 'danger' : '', onclick: () => { closePop(); e.action(); } }, h('span', null, e.icon || ''), e.label));
  popover(anchor, items, { menu: true, align: 'left' });
}

function modal(title, body, foot, opts = {}) {
  const root = $('#overlay-root');
  const back = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === back) close(); } });
  const close = () => { back.remove(); if (opts.onclose) opts.onclose(); };
  const m = h('div', { class: 'modal' + (opts.narrow ? ' narrow' : '') },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  back.appendChild(m); root.appendChild(back);
  return { close, el: m, body: $('.modal-body', m) };
}

function confirmBox(msg, onyes, label = 'Supprimer') {
  const m = modal('Confirmation', h('p', null, msg), [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Annuler'),
    h('button', { class: 'btn primary', style: { background: 'var(--danger)', borderColor: 'var(--danger)' },
      onclick: async () => { m.close(); await onyes(); } }, label)], { narrow: true });
}

function promptBox(title, value, onok, placeholder = '') {
  const inp = h('input', { class: 'inp', value, placeholder });
  const ok = async () => { const v = inp.value.trim(); if (!v) return; m.close(); await onok(v); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  const m = modal(title, inp, [h('button', { class: 'btn', onclick: () => m.close() }, 'Annuler'),
    h('button', { class: 'btn primary', onclick: ok }, 'Valider')], { narrow: true });
  setTimeout(() => { inp.focus(); inp.select(); }, 20);
}

function lightbox(src) {
  const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src }));
  document.body.appendChild(lb);
}

// ------------------------------------------------------------------ rendu principal
function render() {
  renderSidebar();
  const main = $('#main');
  main.innerHTML = '';
  if (!S.data) {
    main.appendChild(h('div', { class: 'empty' }, h('p', null, 'Aucun tableau.'),
      h('button', { class: 'btn primary', onclick: newBoard }, '+ Créer un tableau')));
    return;
  }
  main.appendChild(renderTopbar());
  const scroll = h('div', { class: 'board-scroll', id: 'board-scroll' });
  const grid = '8px var(--name-w) ' + S.data.columns.map(c => c.width + 'px').join(' ') + ' 56px';
  scroll.style.setProperty('--grid', grid);
  for (const g of S.data.groups) scroll.appendChild(renderGroup(g));
  scroll.appendChild(h('button', { class: 'btn', onclick: () => addGroup() }, '+ Ajouter un groupe'));
  main.appendChild(scroll);
  const sc = store.get('scroll.' + S.boardId, null);
  if (sc && S._restoreScroll !== false) { scroll.scrollLeft = sc[0]; scroll.scrollTop = sc[1]; }
  scroll.addEventListener('scroll', () => store.set('scroll.' + S.boardId, [scroll.scrollLeft, scroll.scrollTop]), { passive: true });
}

function renderSidebar() {
  const sb = $('#sidebar');
  sb.innerHTML = '';
  if (innerWidth <= 760 && !S.sidebarOpen) sb.classList.add('hidden'); else sb.classList.remove('hidden');
  sb.append(
    h('div', { class: 'brand' }, h('div', { class: 'brand-logo' }, '✓'), 'Tickets',
      h('span', { class: 'spacer' }), h('button', { class: 'icon-btn mobile-only', title: 'Masquer', onclick: () => { S.sidebarOpen = false; sb.classList.add('hidden'); } }, '«')),
    h('div', { class: 'side-title' }, 'Tableaux'),
    ...S.boards.map(b => h('button', {
      class: 'board-link' + (b.id === S.boardId ? ' active' : ''),
      onclick: async () => { S.boardId = b.id; store.set('board', b.id); S.sidebarOpen = false; S.drawerItem = null; await loadBoard(); },
    }, h('span', { class: 'ico' }, '▦'), b.name)),
    h('button', { class: 'board-link side-add', onclick: newBoard }, h('span', { class: 'ico' }, '+'), 'Nouveau tableau'),
  );
}

function newBoard() {
  promptBox('Nouveau tableau', '', async name => {
    const r = await api('POST', 'api/boards', { name });
    S.boardId = r.id; store.set('board', r.id);
    await loadBoards(); await loadBoard();
  }, 'Ex : Travaux maison');
}

function renderTopbar() {
  const b = S.data.board;
  const title = h('input', { class: 'board-title', value: b.name, size: Math.max(4, b.name.length),
    oninput: e => e.target.size = Math.max(4, e.target.value.length),
    onchange: async e => { await api('PATCH', 'api/boards/' + b.id, { name: e.target.value }); await loadBoards(); renderSidebar(); } });
  const desc = h('input', { class: 'board-desc', value: b.description || '', placeholder: 'Ajouter une description…',
    onchange: e => api('PATCH', 'api/boards/' + b.id, { description: e.target.value }) });

  const search = h('input', { class: 'search', type: 'search', placeholder: '🔍 Rechercher', value: S.search,
    oninput: e => { S.search = e.target.value; rerenderGroups(); } });

  const personCols = S.data.columns.filter(c => c.type === 'person');
  let pfilter = null;
  if (personCols.length) {
    const names = new Set();
    S.data.items.forEach(i => personCols.forEach(c => { if (i.values[c.id]) names.add(i.values[c.id]); }));
    pfilter = h('select', { class: 'filter', onchange: e => { S.personFilter = e.target.value; rerenderGroups(); } },
      h('option', { value: '' }, '👤 Tout le monde'),
      [...names].sort().map(n => h('option', { value: n, selected: S.personFilter === n }, n)));
  }

  const firstGroup = S.data.groups[0];
  return h('div', { class: 'topbar' },
    h('div', { class: 'title-row' },
      h('button', { class: 'icon-btn mobile-only', onclick: () => { S.sidebarOpen = true; $('#sidebar').classList.remove('hidden'); } }, '☰'),
      title, h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Options du tableau', onclick: e => boardMenu(e.currentTarget) }, '⋯')),
    desc,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: async () => {
        if (!firstGroup) return addGroup();
        const r = await api('POST', `api/groups/${firstGroup.id}/items`, { name: 'Nouvel élément' });
        await refresh(); openDrawer(r.id);
      } }, '+ ', h('span', { class: 'lbl' }, 'Nouvel élément')),
      search, pfilter,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => addColumnPicker(null) }, '▥ ', h('span', { class: 'lbl' }, 'Colonne')),
      h('button', { class: 'btn', onclick: () => addGroup() }, '▤ ', h('span', { class: 'lbl' }, 'Groupe')),
      h('button', { class: 'btn', onclick: openAutomations }, '⚡ ', h('span', { class: 'lbl' }, 'Automatisations'),
        S.data.automations_count ? h('span', { class: 'badge' }, S.data.automations_count) : null),
    ));
}

function boardMenu(anchor) {
  const b = S.data.board;
  menu(anchor, [
    { icon: '✎', label: 'Renommer', action: () => promptBox('Renommer le tableau', b.name, async v => { await api('PATCH', 'api/boards/' + b.id, { name: v }); await loadBoards(); await refresh(); }) },
    { icon: '⧉', label: 'Dupliquer le tableau', action: async () => { const r = await api('POST', `api/boards/${b.id}/duplicate`); S.boardId = r.id; store.set('board', r.id); await loadBoards(); await refresh(); toast('Tableau dupliqué'); } },
    { icon: '⇩', label: 'Exporter en CSV', action: exportCSV },
    '-',
    { icon: '🗑', label: 'Supprimer le tableau', danger: true, action: () => confirmBox(`Supprimer le tableau « ${b.name} » et tout son contenu ?`, async () => {
      await api('DELETE', 'api/boards/' + b.id); S.boardId = null; await loadBoards(); await refresh(); }) },
  ]);
}

function exportCSV() {
  const cols = S.data.columns;
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['Groupe', 'Élément', ...cols.map(c => c.name)].map(esc).join(';')];
  for (const g of S.data.groups) for (const i of S.data.items.filter(i => i.group_id === g.id))
    lines.push([g.name, i.name, ...cols.map(c => displayValue(c, i.values[c.id]))].map(esc).join(';'));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: S.data.board.name + '.csv' });
  document.body.appendChild(a); a.click(); a.remove();
}

function displayValue(col, v) {
  if (v === undefined || v === null || v === '') return '';
  switch (col.type) {
    case 'status': case 'dropdown': { const o = (col.settings.options || []).find(o => o.id === v); return o ? o.label : ''; }
    case 'checkbox': return v ? 'oui' : 'non';
    case 'link': return typeof v === 'object' ? v.url : v;
    case 'photo': return Array.isArray(v) ? v.length + ' photo(s)' : '';
    default: return String(v);
  }
}

function rerenderGroups() {
  const scroll = $('#board-scroll');
  if (!scroll) return;
  const left = scroll.scrollLeft, top = scroll.scrollTop;
  S._restoreScroll = false; render(); S._restoreScroll = true;
  const sc = $('#board-scroll'); sc.scrollLeft = left; sc.scrollTop = top;
  const s = $('.search'); if (s && S.search) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function itemVisible(item) {
  if (S.personFilter) {
    const pc = S.data.columns.filter(c => c.type === 'person');
    if (!pc.some(c => item.values[c.id] === S.personFilter)) return false;
  }
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  if (item.name.toLowerCase().includes(q)) return true;
  return S.data.columns.some(c => displayValue(c, item.values[c.id]).toLowerCase().includes(q));
}

// ------------------------------------------------------------------ groupes
let dragItem = null, dragCol = null;

function renderGroup(g) {
  const items = S.data.items.filter(i => i.group_id === g.id);
  const visible = items.filter(itemVisible);
  const collapsed = !!g.collapsed;
  const sec = h('section', { class: 'group' + (collapsed ? ' collapsed' : ''), style: { '--gc': g.color } });

  const name = h('input', { class: 'gname', value: g.name, size: Math.max(3, g.name.length),
    oninput: e => e.target.size = Math.max(3, e.target.value.length),
    onchange: e => api('PATCH', 'api/groups/' + g.id, { name: e.target.value }).then(refresh) });
  sec.appendChild(h('div', { class: 'group-head' },
    h('button', { class: 'icon-btn chev', onclick: async () => { await api('PATCH', 'api/groups/' + g.id, { collapsed: collapsed ? 0 : 1 }); refresh(); } }, '▾'),
    name, h('span', { class: 'gcount' }, `${items.length} élément${items.length > 1 ? 's' : ''}`),
    h('button', { class: 'icon-btn', onclick: e => groupMenu(e.currentTarget, g) }, '⋯')));
  if (collapsed) return sec;

  // en-tête des colonnes
  const head = h('div', { class: 'row head' }, h('div', { class: 'cell bar' }), h('div', { class: 'cell name' }, 'Élément'));
  S.data.columns.forEach(c => head.appendChild(renderColHead(c)));
  head.appendChild(h('div', { class: 'cell', title: 'Ajouter une colonne', onclick: e => addColumnPicker(e.currentTarget) }, '+'));
  sec.appendChild(head);

  // lignes
  for (const it of visible) sec.appendChild(renderRow(it, g));

  // ajout
  const addInp = h('input', { class: 'add-input', placeholder: '+ Ajouter un élément',
    onkeydown: async e => {
      if (e.key === 'Enter' && e.target.value.trim()) {
        await api('POST', `api/groups/${g.id}/items`, { name: e.target.value.trim() });
        await refresh();
        const again = document.querySelector(`[data-add="${g.id}"]`); if (again) again.focus();
      }
    }, 'data-add': g.id });
  const addRow = h('div', { class: 'row add-row', ondragover: e => { if (dragItem) e.preventDefault(); },
    ondrop: e => dropItem(e, g.id, items.length) },
    h('div', { class: 'cell bar' }), h('div', { class: 'cell name' }, addInp));
  S.data.columns.forEach(() => addRow.appendChild(h('div', { class: 'cell' })));
  addRow.appendChild(h('div', { class: 'cell' }));
  sec.appendChild(addRow);

  // résumé
  const sum = h('div', { class: 'row summary' }, h('div', { class: 'cell bar' }), h('div', { class: 'cell name' }));
  S.data.columns.forEach(c => sum.appendChild(renderSummary(c, items)));
  sum.appendChild(h('div', { class: 'cell' }));
  sec.appendChild(sum);
  return sec;
}

function groupMenu(anchor, g) {
  const idx = S.data.groups.indexOf(g);
  const moveGroup = async dir => {
    const ids = S.data.groups.map(x => x.id);
    const j = idx + dir; if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api('POST', `api/boards/${S.boardId}/groups/order`, { ids }); refresh();
  };
  menu(anchor, [
    { icon: '+', label: 'Ajouter un élément', action: async () => { const r = await api('POST', `api/groups/${g.id}/items`, { name: 'Nouvel élément' }); await refresh(); openDrawer(r.id); } },
    { icon: '✎', label: 'Renommer', action: () => promptBox('Renommer le groupe', g.name, async v => { await api('PATCH', 'api/groups/' + g.id, { name: v }); refresh(); }) },
    { icon: '🎨', label: 'Couleur', action: () => {
      popover(anchor, h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 28px)', gap: '6px' } },
        PALETTE.map(c => h('button', { style: { background: c, width: '28px', height: '28px', border: 0, borderRadius: '50%' },
          onclick: async () => { closePop(); await api('PATCH', 'api/groups/' + g.id, { color: c }); refresh(); } }))));
    } },
    idx > 0 && { icon: '↑', label: 'Monter le groupe', action: () => moveGroup(-1) },
    idx < S.data.groups.length - 1 && { icon: '↓', label: 'Descendre le groupe', action: () => moveGroup(1) },
    { icon: '▤', label: 'Nouveau groupe', action: () => addGroup() },
    '-',
    { icon: '🗑', label: 'Supprimer le groupe', danger: true, action: () => confirmBox(`Supprimer le groupe « ${g.name} » et ses éléments ?`, async () => { await api('DELETE', 'api/groups/' + g.id); refresh(); }) },
  ]);
}

function addGroup() {
  promptBox('Nouveau groupe', '', async name => { await api('POST', `api/boards/${S.boardId}/groups`, { name }); refresh(); }, 'Ex : Cette semaine');
}

// ------------------------------------------------------------------ colonnes
function renderColHead(c) {
  const cell = h('div', { class: 'cell col-head', draggable: 'true', title: TYPES[c.type].label,
    onclick: e => { if (!e.target.classList.contains('resizer')) columnMenu(cell, c); },
    ondragstart: e => { dragCol = c; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'col'); },
    ondragend: () => { dragCol = null; },
    ondragover: e => { if (dragCol && dragCol !== c) { e.preventDefault(); cell.classList.add('drop-left'); } },
    ondragleave: () => cell.classList.remove('drop-left'),
    ondrop: async e => {
      e.preventDefault(); cell.classList.remove('drop-left');
      if (!dragCol || dragCol === c) return;
      const ids = S.data.columns.map(x => x.id).filter(id => id !== dragCol.id);
      ids.splice(ids.indexOf(c.id), 0, dragCol.id);
      await api('POST', `api/boards/${S.boardId}/columns/order`, { ids }); refresh();
    } },
  h('span', { class: 'col-head-label' }, c.name));
  const rz = h('div', { class: 'resizer', onmousedown: e => startResize(e, c), onclick: e => e.stopPropagation() });
  cell.appendChild(rz);
  return cell;
}

function startResize(e, c) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startW = c.width;
  const scroll = $('#board-scroll');
  const move = ev => {
    c.width = Math.max(70, Math.min(600, startW + ev.clientX - startX));
    scroll.style.setProperty('--grid', '8px var(--name-w) ' + S.data.columns.map(x => x.width + 'px').join(' ') + ' 56px');
  };
  const up = async () => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    await api('PATCH', 'api/columns/' + c.id, { width: c.width });
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

function columnMenu(anchor, c) {
  const idx = S.data.columns.indexOf(c);
  const moveCol = async dir => {
    const ids = S.data.columns.map(x => x.id); const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api('POST', `api/boards/${S.boardId}/columns/order`, { ids }); refresh();
  };
  menu(anchor, [
    { icon: '⚙', label: 'Paramètres de la colonne', action: () => columnSettings(c) },
    idx > 0 && { icon: '←', label: 'Déplacer à gauche', action: () => moveCol(-1) },
    idx < S.data.columns.length - 1 && { icon: '→', label: 'Déplacer à droite', action: () => moveCol(1) },
    { icon: '↔', label: 'Largeur…', action: () => promptBox('Largeur (px)', String(c.width), async v => { await api('PATCH', 'api/columns/' + c.id, { width: parseInt(v) || 150 }); refresh(); }) },
    '-',
    { icon: '🗑', label: 'Supprimer la colonne', danger: true, action: () => confirmBox(`Supprimer la colonne « ${c.name} » et ses données ?`, async () => { await api('DELETE', 'api/columns/' + c.id); refresh(); }) },
  ]);
}

function addColumnPicker(anchor) {
  const grid = h('div', { class: 'type-grid' }, Object.entries(TYPES).map(([t, d]) =>
    h('button', { class: 'type-btn', onclick: () => { m.close(); createColumn(t); } },
      h('span', { class: 'type-ico', style: { background: d.color } }, d.icon), d.label)));
  const m = modal('Ajouter une colonne', grid, null, { narrow: true });
}

function createColumn(type) {
  promptBox('Nom de la colonne', TYPES[type].label, async name => {
    const r = await api('POST', `api/boards/${S.boardId}/columns`, { name, type });
    await refresh();
    if (type === 'status' || type === 'dropdown') columnSettings(colById(r.id));
  });
}

function columnSettings(c) {
  const st = JSON.parse(JSON.stringify(c.settings || {}));
  const name = h('input', { class: 'inp', value: c.name });
  const body = h('div', null, h('div', { class: 'field' }, h('label', null, 'Nom'), name),
    h('div', { class: 'hint', style: { marginBottom: '12px' } }, 'Type : ' + TYPES[c.type].label));

  if (c.type === 'status' || c.type === 'dropdown') {
    st.options = st.options || [];
    const list = h('div');
    const draw = () => {
      list.innerHTML = '';
      st.options.forEach((o, i) => list.appendChild(h('div', { class: 'opt-row' },
        h('input', { type: 'color', value: o.color, oninput: e => o.color = e.target.value }),
        h('input', { class: 'inp', value: o.label, oninput: e => o.label = e.target.value }),
        h('button', { class: 'icon-btn', disabled: i === 0, onclick: () => { st.options.splice(i - 1, 0, st.options.splice(i, 1)[0]); draw(); } }, '↑'),
        h('button', { class: 'icon-btn', onclick: () => { st.options.splice(i, 1); draw(); } }, '✕'))));
    };
    draw();
    body.append(h('div', { class: 'field' }, h('label', null, 'Étiquettes'), list,
      h('button', { class: 'btn small', onclick: () => {
        st.options.push({ id: 'o' + Date.now().toString(36), label: 'Nouvelle étiquette', color: PALETTE[st.options.length % PALETTE.length] }); draw();
      } }, '+ Ajouter une étiquette')));
    if (c.type === 'status') body.append(h('div', { class: 'field' }, h('label', null, 'Étiquette « terminée » (pour le résumé)'),
      h('select', { class: 'sel', onchange: e => st.done = e.target.value },
        h('option', { value: '' }, '—'), st.options.map(o => h('option', { value: o.id, selected: st.done === o.id }, o.label)))));
  }
  if (c.type === 'person') {
    const ta = h('textarea', { class: 'inp', value: (st.people || []).join('\n'), oninput: e => st.people = e.target.value.split('\n').map(s => s.trim()).filter(Boolean) });
    body.append(h('div', { class: 'field' }, h('label', null, 'Personnes supplémentaires (une par ligne)'), ta,
      h('div', { class: 'hint' }, 'Les personnes Home Assistant (entités person.*) sont proposées automatiquement.')));
  }
  if (c.type === 'number') {
    body.append(h('div', { class: 'field' }, h('label', null, 'Unité'),
      h('input', { class: 'inp', value: st.unit || '', placeholder: '€, h, km…', oninput: e => st.unit = e.target.value })));
  }
  const m = modal('Paramètres : ' + c.name, body, [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Annuler'),
    h('button', { class: 'btn primary', onclick: async () => {
      await api('PATCH', 'api/columns/' + c.id, { name: name.value.trim() || c.name, settings: st }); m.close(); refresh();
    } }, 'Enregistrer')], { narrow: true });
}

function renderSummary(c, items) {
  if (c.type === 'status' || c.type === 'dropdown') {
    const counts = {};
    items.forEach(i => { const v = i.values[c.id] || ''; counts[v] = (counts[v] || 0) + 1; });
    if (!items.length) return h('div', { class: 'cell' });
    const bar = h('div', { class: 'dist' });
    const opts = c.settings.options || [];
    [...opts, { id: '', label: 'Vide', color: '#c4c4c4' }].forEach(o => {
      if (counts[o.id]) bar.appendChild(h('span', { title: `${o.label} : ${counts[o.id]}/${items.length}`,
        style: { width: (counts[o.id] / items.length * 100) + '%', background: o.color } }));
    });
    return h('div', { class: 'cell has' }, bar);
  }
  if (c.type === 'number') {
    const vals = items.map(i => i.values[c.id]).filter(v => typeof v === 'number');
    if (!vals.length) return h('div', { class: 'cell' });
    const s = vals.reduce((a, b) => a + b, 0);
    return h('div', { class: 'cell has' }, h('span', { class: 'sum' }, (Math.round(s * 100) / 100).toLocaleString('fr-FR') + ' ' + (c.settings.unit || ''), h('br'), h('small', null, 'somme')));
  }
  if (c.type === 'checkbox') {
    const n = items.filter(i => i.values[c.id]).length;
    return items.length ? h('div', { class: 'cell has' }, h('span', { class: 'sum' }, `${n}/${items.length}`)) : h('div', { class: 'cell' });
  }
  return h('div', { class: 'cell' });
}

// ------------------------------------------------------------------ lignes & cellules
function renderRow(it, g) {
  const row = h('div', { class: 'row item', 'data-id': it.id,
    ondragover: e => { if (dragItem && dragItem !== it) { e.preventDefault(); row.classList.add('drop-before'); } },
    ondragleave: () => row.classList.remove('drop-before'),
    ondrop: e => { row.classList.remove('drop-before'); const list = S.data.items.filter(i => i.group_id === g.id && i !== dragItem); dropItem(e, g.id, list.indexOf(it)); } });
  const handle = h('span', { class: 'handle', draggable: 'true', title: 'Glisser pour déplacer',
    ondragstart: e => { dragItem = it; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'item'); },
    ondragend: () => { dragItem = null; row.classList.remove('dragging'); } }, '⋮⋮');
  const name = h('input', { class: 'name-input', value: it.name, onchange: e => patchItem(it, { name: e.target.value }) });
  const open = h('button', { class: 'open-btn' + (it.updates_count ? ' has' : ''), title: 'Ouvrir', onclick: () => openDrawer(it.id) },
    '💬', it.updates_count ? String(it.updates_count) : '');
  row.append(h('div', { class: 'cell bar' }), h('div', { class: 'cell name' }, handle, name, open));
  S.data.columns.forEach(c => row.appendChild(h('div', { class: 'cell' }, renderCell(it, c))));
  row.appendChild(h('div', { class: 'cell' }, h('button', { class: 'icon-btn', onclick: e => itemMenu(e.currentTarget, it) }, '⋯')));
  return row;
}

async function dropItem(e, groupId, index) {
  e.preventDefault();
  if (!dragItem) return;
  const it = dragItem; dragItem = null;
  await api('PATCH', 'api/items/' + it.id, { group_id: groupId, index: Math.max(0, index) });
  refresh();
}

function itemMenu(anchor, it) {
  menu(anchor, [
    { icon: '↗', label: 'Ouvrir', action: () => openDrawer(it.id) },
    { icon: '⧉', label: 'Dupliquer', action: async () => { await api('POST', `api/items/${it.id}/duplicate`); refresh(); } },
    ...S.data.groups.filter(g => g.id !== it.group_id).map(g => ({ icon: '→', label: 'Déplacer vers ' + g.name,
      action: async () => { await api('PATCH', 'api/items/' + it.id, { group_id: g.id }); refresh(); } })),
    '-',
    { icon: '🗑', label: 'Supprimer', danger: true, action: () => confirmBox(`Supprimer « ${it.name} » ?`, async () => { await api('DELETE', 'api/items/' + it.id); refresh(); }) },
  ]);
}

function renderCell(it, c) {
  const v = it.values[c.id];
  switch (c.type) {
    case 'text':
      return h('input', { class: 'c-text', value: v || '', onchange: e => setVal(it, c, e.target.value, false) });
    case 'number':
      return h('input', { class: 'c-number', type: 'number', step: 'any', inputmode: 'decimal', value: v ?? '',
        onchange: e => setVal(it, c, e.target.value === '' ? null : parseFloat(e.target.value), true) });
    case 'status': case 'dropdown': {
      const o = (c.settings.options || []).find(o => o.id === v);
      const el = c.type === 'status'
        ? h('div', { class: 'c-status' + (o ? '' : ' empty'), style: o ? { background: o.color } : null }, o ? o.label : '')
        : h('div', { class: 'c-click' }, o ? h('span', { class: 'c-tag', style: { background: o.color } }, o.label) : h('span', { class: 'c-placeholder' }, '+'));
      el.addEventListener('click', () => statusPicker(el, it, c));
      return el;
    }
    case 'date': {
      let cls = 'c-date';
      if (!v) cls += ' empty-date';
      else if (!isDone(it)) { const t = todayISO(); if (v < t) cls += ' overdue'; else if (v === t) cls += ' soon'; }
      return h('input', { class: cls, type: 'date', value: v || '', title: v ? '' : 'Choisir une date', onchange: e => setVal(it, c, e.target.value || null, true) });
    }
    case 'person': {
      const el = h('div', { class: 'c-click' }, v ? [avatar(v), h('span', { class: 'pname' }, v)] : h('span', { class: 'c-placeholder' }, '👤'));
      el.addEventListener('click', () => personPicker(el, it, c));
      return el;
    }
    case 'checkbox':
      return h('input', { class: 'c-check', type: 'checkbox', checked: !!v, onchange: e => setVal(it, c, e.target.checked, true) });
    case 'link': {
      const url = v && (typeof v === 'object' ? v.url : v);
      const text = v && typeof v === 'object' && v.text ? v.text : url;
      const el = h('div', { class: 'c-click' }, url ? h('a', { class: 'link-text', href: url, target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation() }, text) : h('span', { class: 'c-placeholder' }, '🔗'));
      el.addEventListener('click', () => linkEditor(el, it, c));
      return el;
    }
    case 'photo': {
      const list = Array.isArray(v) ? v : [];
      const el = h('div', { class: 'c-click' }, list.length
        ? h('div', { class: 'thumbs' }, list.slice(0, 2).map(f => h('img', { class: 'thumb', src: 'photos/' + f, loading: 'lazy' })),
          list.length > 2 ? h('span', { class: 'more' }, '+' + (list.length - 2)) : null)
        : h('span', { class: 'c-placeholder' }, '📷'));
      el.addEventListener('click', () => photoPopover(el, it, c));
      return el;
    }
  }
  return h('span');
}

function isDone(it) {
  return S.data.columns.some(c => c.type === 'status' && c.settings.done && it.values[c.id] === c.settings.done);
}

function avatar(name, sm) {
  const p = S.persons.find(p => p.name === name);
  const st = { background: hashColor(name) };
  if (p && p.picture) Object.assign(st, { backgroundImage: `url(${p.picture})` });
  return h('span', { class: 'avatar' + (sm ? ' sm' : ''), style: st, title: name }, p && p.picture ? '' : initials(name));
}

function statusPicker(anchor, it, c) {
  const opts = c.settings.options || [];
  const content = h('div', null,
    h('div', { class: 'status-list' }, opts.map(o => h('button', { class: 'status-opt', style: { background: o.color },
      onclick: () => { closePop(); setVal(it, c, o.id, true); } }, o.label)),
      h('button', { class: 'status-opt clear', onclick: () => { closePop(); setVal(it, c, null, true); } }, 'Effacer')),
    h('div', { class: 'pop-foot' }, h('button', { class: 'btn small ghost', onclick: () => { closePop(); columnSettings(c); } }, '✎ Modifier les étiquettes')));
  popover(anchor, content);
}

function personList(c) {
  const names = new Set(S.persons.map(p => p.name));
  (c.settings.people || []).forEach(n => names.add(n));
  return [...names];
}

function personPicker(anchor, it, c) {
  const cur = it.values[c.id];
  const inp = h('input', { class: 'inp', placeholder: 'Rechercher ou saisir un nom' });
  const list = h('div');
  const draw = () => {
    const q = inp.value.toLowerCase();
    list.innerHTML = '';
    personList(c).filter(n => n.toLowerCase().includes(q)).forEach(n => list.appendChild(
      h('button', { class: 'person-opt' + (n === cur ? ' sel' : ''), onclick: () => { closePop(); setVal(it, c, n, true); } }, avatar(n, true), n)));
    if (inp.value.trim() && !personList(c).some(n => n.toLowerCase() === q))
      list.appendChild(h('button', { class: 'person-opt', onclick: () => { closePop(); setVal(it, c, inp.value.trim(), true); } }, '+ ', `Utiliser « ${inp.value.trim()} »`));
    if (cur) list.appendChild(h('button', { class: 'person-opt', style: { color: 'var(--muted)' }, onclick: () => { closePop(); setVal(it, c, null, true); } }, '✕ Retirer'));
  };
  inp.addEventListener('input', draw);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value.trim()) { closePop(); setVal(it, c, inp.value.trim(), true); } });
  draw();
  popover(anchor, h('div', { style: { display: 'grid', gap: '6px', minWidth: '230px' } }, inp, list));
}

function linkEditor(anchor, it, c) {
  const v = it.values[c.id];
  const url = h('input', { class: 'inp', placeholder: 'https://…', value: v ? (typeof v === 'object' ? v.url : v) : '' });
  const text = h('input', { class: 'inp', placeholder: 'Texte affiché (optionnel)', value: v && typeof v === 'object' ? v.text || '' : '' });
  const save = () => { closePop(); const u = url.value.trim(); setVal(it, c, u ? { url: /^[a-z]+:/i.test(u) ? u : 'https://' + u, text: text.value.trim() } : null, true); };
  [url, text].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
  popover(anchor, h('div', { style: { display: 'grid', gap: '8px', minWidth: '260px' } }, url, text,
    h('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
      v ? h('button', { class: 'btn small', onclick: () => { closePop(); setVal(it, c, null, true); } }, 'Retirer') : null,
      h('button', { class: 'btn small primary', onclick: save }, 'OK'))));
}

// ------------------------------------------------------------------ photos
async function resizeImage(file, max = 1600) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch (e) { return file; }
}

async function uploadPhotos(it, c, files) {
  if (!files || !files.length) return;
  toast('Envoi de ' + files.length + ' photo(s)…');
  const fd = new FormData();
  for (const f of files) fd.append('file', await resizeImage(f), f.name || 'photo.jpg');
  await api('POST', `api/items/${it.id}/photos/${c.id}`, fd);
  toast('Photo ajoutée ✓');
  await refresh();
}

function photoButtons(it, c, after) {
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' },
    onchange: async e => { await uploadPhotos(it, c, e.target.files); if (after) after(); } });
  const gal = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' },
    onchange: async e => { await uploadPhotos(it, c, e.target.files); if (after) after(); } });
  return h('div', { class: 'photo-actions' }, cam, gal,
    h('button', { class: 'btn small primary', onclick: () => cam.click() }, '📷 Prendre une photo'),
    h('button', { class: 'btn small', onclick: () => gal.click() }, '🖼 Galerie / fichier'));
}

function photoGrid(it, c, after) {
  const list = Array.isArray(it.values[c.id]) ? it.values[c.id] : [];
  if (!list.length) return h('div', { class: 'hint' }, 'Aucune photo.');
  return h('div', { class: 'photo-grid' }, list.map(f => h('div', { class: 'ph' },
    h('img', { src: 'photos/' + f, loading: 'lazy', onclick: () => lightbox('photos/' + f) }),
    h('button', { class: 'del', title: 'Supprimer', onclick: () => confirmBox('Supprimer cette photo ?', async () => {
      await api('DELETE', `api/items/${it.id}/photos/${c.id}/${f}`); await refresh(); if (after) after();
    }) }, '✕'))));
}

function photoPopover(anchor, it, c) {
  popover(anchor, h('div', { style: { width: '300px', maxWidth: '100%' } },
    h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, c.name + ' — ' + it.name),
    photoGrid(it, c, () => closePop()), photoButtons(it, c, () => closePop())), { nofocus: true });
}

// ------------------------------------------------------------------ fiche élément (drawer)
function openDrawer(id) { S.drawerItem = id; renderDrawer(); }
function closeDrawer() { S.drawerItem = null; const d = $('#drawer-wrap'); if (d) d.remove(); }

async function renderDrawer() {
  const it = itemById(S.drawerItem);
  let wrap = $('#drawer-wrap');
  if (!it) { closeDrawer(); return; }
  const full = await api('GET', 'api/items/' + it.id);
  const scrollTop = wrap ? $('.drawer-body', wrap).scrollTop : 0;
  if (wrap) wrap.remove();
  wrap = h('div', { id: 'drawer-wrap' });
  const title = h('input', { class: 'drawer-title', value: it.name, onchange: e => patchItem(it, { name: e.target.value }, { rerender: true }) });
  const fields = h('div', { class: 'dfields' },
    h('div', { class: 'dl' }, '▤ Groupe'),
    h('div', { class: 'dv' }, h('select', { class: 'sel', style: { border: 0, borderRadius: 0 },
      onchange: async e => { await api('PATCH', 'api/items/' + it.id, { group_id: parseInt(e.target.value) }); refresh(); } },
      S.data.groups.map(g => h('option', { value: g.id, selected: g.id === it.group_id }, g.name)))),
    S.data.columns.filter(c => c.type !== 'photo').map(c => [
      h('div', { class: 'dl' }, h('span', null, TYPES[c.type].icon), c.name),
      h('div', { class: 'dv' }, renderCell(it, c))]));
  const photoSections = S.data.columns.filter(c => c.type === 'photo').map(c => h('div', null,
    h('div', { class: 'section-title' }, '📷 ' + c.name), photoGrid(it, c), photoButtons(it, c)));

  const ta = h('textarea', { class: 'inp', placeholder: 'Écrire une mise à jour…' });
  const updates = h('div', null,
    h('div', { class: 'section-title' }, '💬 Mises à jour'),
    ta, h('div', { style: { display: 'flex', justifyContent: 'flex-end', margin: '6px 0 12px' } },
      h('button', { class: 'btn primary small', onclick: async () => {
        if (!ta.value.trim()) return;
        await api('POST', `api/items/${it.id}/updates`, { text: ta.value.trim() }); await refresh(); renderDrawer();
      } }, 'Publier')),
    full.updates.map(u => h('div', { class: 'update' },
      h('div', { class: 'update-head' }, avatar(u.author || '?', true), h('b', null, u.author), h('span', { class: 'when' }, fmtDate(u.ts)),
        h('button', { class: 'icon-btn', style: { width: '22px', height: '22px', fontSize: '12px' }, onclick: async () => { await api('DELETE', 'api/updates/' + u.id); await refresh(); renderDrawer(); } }, '✕')),
      h('div', { class: 'update-text' }, u.text))));

  const drawer = h('div', { class: 'drawer' },
    h('div', { class: 'drawer-head' }, title,
      h('button', { class: 'icon-btn', title: 'Options', onclick: e => itemMenu(e.currentTarget, it) }, '⋯'),
      h('button', { class: 'icon-btn', onclick: closeDrawer }, '✕')),
    h('div', { class: 'drawer-body' }, fields, photoSections, updates,
      h('div', { class: 'hint', style: { marginTop: '16px' } }, `Créé le ${fmtDate(it.created)} · modifié le ${fmtDate(it.updated)} · #${it.id}`)));
  wrap.append(h('div', { class: 'drawer-back', onclick: closeDrawer }), drawer);
  document.body.appendChild(wrap);
  $('.drawer-body', wrap).scrollTop = scrollTop;
}

// ------------------------------------------------------------------ automatisations
const TRIGGERS = {
  item_created: 'Quand un élément est créé',
  column_changed: 'Quand une colonne change',
  moved_to_group: 'Quand un élément est déplacé vers un groupe',
  date_arrived: 'Quand une date arrive',
};
const ACTIONS = {
  set_column: 'Modifier une colonne',
  move_to_group: 'Déplacer vers un groupe',
  notify: 'Envoyer une notification (téléphone…)',
  persistent_notification: 'Notification dans Home Assistant',
  ha_service: 'Appeler un service / action HA',
  fire_event: 'Déclencher un événement HA',
  add_update: 'Ajouter une mise à jour (commentaire)',
  duplicate_item: "Dupliquer l'élément",
  delete_item: "Supprimer l'élément",
};
const OPS = { eq: 'est', neq: "n'est pas", empty: 'est vide', not_empty: "n'est pas vide", contains: 'contient' };

async function openAutomations() {
  const m = modal('⚡ Automatisations', h('div', null, 'Chargement…'), null);
  let tab = 'list';
  const draw = async () => {
    const data = await api('GET', `api/boards/${S.boardId}/automations`);
    m.body.innerHTML = '';
    m.body.appendChild(h('div', { class: 'tabs' },
      h('button', { class: 'tab' + (tab === 'list' ? ' active' : ''), onclick: () => { tab = 'list'; draw(); } }, `Automatisations (${data.automations.length})`),
      h('button', { class: 'tab' + (tab === 'log' ? ' active' : ''), onclick: () => { tab = 'log'; draw(); } }, 'Historique')));
    if (tab === 'log') {
      m.body.appendChild(data.log.length ? h('div', null, data.log.map(l => h('div', { class: 'log-row' + (l.ok ? '' : ' err') },
        h('span', { class: 'ts' }, fmtDate(l.ts)), h('span', null, (l.ok ? '✓ ' : '✕ ') + `${l.automation || '?'} → ${l.item || '#' + l.item_id} : ${l.message}`))))
        : h('div', { class: 'hint' }, 'Aucune exécution pour le moment.'));
      return;
    }
    m.body.appendChild(h('div', { class: 'section-title', style: { marginTop: 0 } }, 'Recettes rapides'));
    m.body.appendChild(h('div', { class: 'recipes' }, recipes().map(r =>
      h('button', { class: 'recipe', onclick: () => editAutomation(r.auto, draw) }, r.label))));
    m.body.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', margin: '8px 0 10px' } },
      h('div', { class: 'section-title', style: { margin: 0, flex: 1 } }, 'Mes automatisations'),
      h('button', { class: 'btn primary', onclick: () => editAutomation(null, draw) }, '+ Créer')));
    if (!data.automations.length) m.body.appendChild(h('div', { class: 'hint' }, 'Aucune automatisation. Choisissez une recette ou créez-en une.'));
    data.automations.forEach(a => m.body.appendChild(h('div', { class: 'auto-card' + (a.enabled ? '' : ' off') },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: a.enabled,
        onchange: async e => { await api('PATCH', 'api/automations/' + a.id, { enabled: e.target.checked }); draw(); } }), h('span')),
      h('div', { class: 'auto-sentence' }, h('div', { class: 'auto-name' }, a.name), h('div', { html: describeAuto(a) })),
      h('button', { class: 'icon-btn', title: 'Modifier', onclick: () => editAutomation(a, draw) }, '✎'),
      h('button', { class: 'icon-btn', title: 'Supprimer', onclick: () => confirmBox(`Supprimer « ${a.name} » ?`, async () => { await api('DELETE', 'api/automations/' + a.id); draw(); refresh(); }) }, '🗑'))));
  };
  await draw();
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function valueLabel(col, v) {
  if (!col) return esc(v);
  if (v === '' || v === undefined || v === null || v === '__any__') return "n'importe quelle valeur";
  if (col.type === 'checkbox') return v === true || v === 'true' ? 'coché' : 'décoché';
  if (col.type === 'date') return v === 'today' ? "aujourd'hui" : /^[+-]\d+$/.test(v) ? `aujourd'hui ${v} j` : esc(v);
  return esc(displayValue(col, v) || v);
}

function describeAuto(a) {
  const t = a.trigger || {};
  const col = colById(t.column_id);
  let s = '';
  if (t.type === 'item_created') s = 'Quand <b>un élément est créé</b>';
  else if (t.type === 'column_changed') s = `Quand <b>${esc(col ? col.name : '?')}</b> devient <b>${valueLabel(col, t.value)}</b>`;
  else if (t.type === 'moved_to_group') s = `Quand un élément est déplacé vers <b>${esc((groupById(t.group_id) || {}).name || '?')}</b>`;
  else if (t.type === 'date_arrived') {
    const o = parseInt(t.offset_days || 0);
    s = `Quand <b>${esc(col ? col.name : '?')}</b> arrive${o ? ` (${Math.abs(o)} j ${o < 0 ? 'avant' : 'après'})` : ''} à <b>${esc(t.time || '09:00')}</b>`;
  }
  (a.conditions || []).forEach(c => {
    const cc = c.column_id === 'group' ? { name: 'Groupe', type: 'group' } : colById(c.column_id);
    const val = c.column_id === 'group' ? esc((groupById(c.value) || {}).name) : valueLabel(cc, c.value);
    s += `, et si <b>${esc(cc ? cc.name : '?')}</b> ${OPS[c.op] || c.op}${['empty', 'not_empty'].includes(c.op) ? '' : ' <b>' + val + '</b>'}`;
  });
  s += ' → ' + (a.actions || []).map(x => {
    const c = colById(x.column_id);
    switch (x.type) {
      case 'set_column': return `mettre <b>${esc(c ? c.name : '?')}</b> à <b>${valueLabel(c, x.value)}</b>`;
      case 'move_to_group': return `déplacer vers <b>${esc((groupById(x.group_id) || {}).name || '?')}</b>`;
      case 'notify': return `notifier <b>${esc(x.service || 'notify.notify')}</b>`;
      case 'persistent_notification': return 'créer une <b>notification HA</b>';
      case 'ha_service': return `appeler <b>${esc(x.service)}</b>`;
      case 'fire_event': return `déclencher l'événement <b>${esc(x.event || 'ha_tickets')}</b>`;
      case 'add_update': return 'ajouter une <b>mise à jour</b>';
      case 'duplicate_item': return "<b>dupliquer</b> l'élément";
      case 'delete_item': return "<b>supprimer</b> l'élément";
    }
    return x.type;
  }).join(', puis ');
  return s;
}

function recipes() {
  const st = S.data.columns.find(c => c.type === 'status');
  const date = S.data.columns.find(c => c.type === 'date');
  const person = S.data.columns.find(c => c.type === 'person');
  const groups = S.data.groups;
  const last = groups[groups.length - 1];
  const out = [];
  if (st && last) {
    const done = (st.settings.options || []).find(o => o.id === st.settings.done) || (st.settings.options || []).find(o => /termin|fait|done/i.test(o.label));
    if (done) out.push({ label: `Quand ${st.name} devient « ${done.label} », déplacer vers « ${last.name} »`,
      auto: { name: 'Terminé → archiver', trigger: { type: 'column_changed', column_id: st.id, value: done.id }, conditions: [], actions: [{ type: 'move_to_group', group_id: last.id }] } });
  }
  if (date) out.push({ label: `Quand ${date.name} arrive, m'envoyer une notification`,
    auto: { name: 'Rappel échéance', trigger: { type: 'date_arrived', column_id: date.id, offset_days: 0, time: '09:00' }, conditions: [],
      actions: [{ type: 'notify', service: 'notify.notify', title: '⏰ Échéance aujourd\'hui', message: '{item} ({tableau}) arrive à échéance' + (person ? ' — {' + person.name + '}' : '') }] } });
  if (st) out.push({ label: `Quand un élément est créé, mettre ${st.name} à « ${((st.settings.options || [])[0] || {}).label || '…'} »`,
    auto: { name: 'Statut par défaut', trigger: { type: 'item_created' }, conditions: [], actions: [{ type: 'set_column', column_id: st.id, value: ((st.settings.options || [])[0] || {}).id }] } });
  if (st && date) out.push({ label: `Quand ${st.name} change, mettre ${date.name} à aujourd'hui`,
    auto: { name: 'Date de mise à jour', trigger: { type: 'column_changed', column_id: st.id, value: '' }, conditions: [], actions: [{ type: 'set_column', column_id: date.id, value: 'today' }] } });
  out.push({ label: 'Quand un élément est créé, notifier Home Assistant',
    auto: { name: 'Nouveau ticket', trigger: { type: 'item_created' }, conditions: [], actions: [{ type: 'persistent_notification', title: 'Nouveau ticket', message: '{item} a été ajouté dans {tableau} / {groupe}' }] } });
  return out;
}

// Sélecteur de valeur adapté au type de colonne
function valueEditor(col, value, onchange, mode) {
  if (!col) return h('input', { class: 'inp', value: value ?? '', oninput: e => onchange(e.target.value) });
  const anyOpt = mode === 'trigger' ? [h('option', { value: '' }, "n'importe quelle valeur")] : [];
  if (col.type === 'status' || col.type === 'dropdown') {
    if (value === undefined && mode !== 'trigger') onchange((col.settings.options || [])[0]?.id || '');
    return h('select', { class: 'sel', onchange: e => onchange(e.target.value) }, anyOpt,
      mode === 'set' ? h('option', { value: '' }, '(vide)') : null,
      (col.settings.options || []).map(o => h('option', { value: o.id, selected: o.id === value }, o.label)));
  }
  if (col.type === 'checkbox') {
    if (value === undefined && mode !== 'trigger') onchange('true');
    return h('select', { class: 'sel', onchange: e => onchange(e.target.value) }, anyOpt,
      h('option', { value: 'true', selected: String(value) === 'true' }, 'coché'),
      h('option', { value: 'false', selected: String(value) === 'false' }, 'décoché'));
  }
  if (col.type === 'person') {
    const id = 'dl' + Math.random().toString(36).slice(2);
    return [h('input', { class: 'inp', list: id, value: value ?? '', placeholder: mode === 'trigger' ? "n'importe qui" : 'Nom', oninput: e => onchange(e.target.value) }),
      h('datalist', { id }, personList(col).map(n => h('option', { value: n })))];
  }
  if (col.type === 'date' && mode === 'set') {
    const id = 'dl' + Math.random().toString(36).slice(2);
    return [h('input', { class: 'inp', list: id, value: value ?? 'today', placeholder: 'today, +3, 2026-12-31', oninput: e => onchange(e.target.value) }),
      h('datalist', { id }, ['today', '+1', '+3', '+7', '+14', '+30'].map(n => h('option', { value: n })))];
  }
  if (col.type === 'photo') return h('span', { class: 'hint' }, mode === 'trigger' ? 'à chaque ajout/suppression' : 'non modifiable');
  return h('input', { class: 'inp', value: value ?? '', placeholder: mode === 'trigger' ? "n'importe quelle valeur" : 'Valeur ({item}, {Colonne}…)', oninput: e => onchange(e.target.value) });
}

function sel(options, value, onchange, extra = {}) {
  return h('select', Object.assign({ class: 'sel', onchange: e => onchange(e.target.value) }, extra),
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}

async function editAutomation(auto, after) {
  if (!S.services.length) S.services = await api('GET', 'api/ha/services').catch(() => []);
  const a = auto ? JSON.parse(JSON.stringify(auto)) : { name: '', enabled: true, trigger: { type: 'column_changed' }, conditions: [], actions: [{ type: 'set_column' }] };
  const cols = S.data.columns;
  const colOpts = cols.map(c => [c.id, c.name]);
  const grpOpts = S.data.groups.map(g => [g.id, g.name]);
  const body = h('div');

  const draw = () => {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'field' }, h('label', null, 'Nom'),
      h('input', { class: 'inp', value: a.name, placeholder: 'Ex : Ticket terminé → archive', oninput: e => a.name = e.target.value })));

    // Déclencheur
    const t = a.trigger;
    const tb = h('div', { class: 'builder-block' }, h('div', { class: 'blabel' }, h('span', { class: 'k' }, 'QUAND'), 'Déclencheur'));
    tb.appendChild(h('div', { class: 'brow' }, sel(Object.entries(TRIGGERS), t.type, v => { a.trigger = { type: v }; draw(); })));
    if (t.type === 'column_changed') {
      const usable = cols;
      if (!t.column_id && usable[0]) t.column_id = usable[0].id;
      const col = colById(t.column_id);
      tb.appendChild(h('div', { class: 'brow' }, sel(usable.map(c => [c.id, c.name]), t.column_id, v => { t.column_id = parseInt(v); t.value = ''; draw(); }),
        h('span', null, 'devient'), valueEditor(col, t.value, v => t.value = v, 'trigger')));
    }
    if (t.type === 'moved_to_group') {
      if (!t.group_id && grpOpts[0]) t.group_id = grpOpts[0][0];
      tb.appendChild(h('div', { class: 'brow' }, sel(grpOpts, t.group_id, v => t.group_id = parseInt(v))));
    }
    if (t.type === 'date_arrived') {
      const dcols = cols.filter(c => c.type === 'date');
      if (!dcols.length) tb.appendChild(h('div', { class: 'hint' }, '⚠ Ajoutez d’abord une colonne Date.'));
      else {
        if (!t.column_id) t.column_id = dcols[0].id;
        if (t.offset_days === undefined) t.offset_days = 0;
        if (!t.time) t.time = '09:00';
        const o = parseInt(t.offset_days) || 0;
        tb.appendChild(h('div', { class: 'brow' },
          sel(dcols.map(c => [c.id, c.name]), t.column_id, v => t.column_id = parseInt(v)),
          h('input', { class: 'inp w-sm', type: 'number', min: 0, value: Math.abs(o), onchange: e => { const n = Math.abs(parseInt(e.target.value) || 0); t.offset_days = (parseInt(t.offset_days) < 0 ? -n : n); } }),
          sel([['before', 'jour(s) avant'], ['after', 'jour(s) après']], o < 0 ? 'before' : 'after', v => { const n = Math.abs(parseInt(t.offset_days) || 0); t.offset_days = v === 'before' ? -n : n; }),
          h('span', null, 'à'), h('input', { class: 'inp w-sm', type: 'time', value: t.time, onchange: e => t.time = e.target.value })));
        tb.appendChild(h('div', { class: 'hint' }, 'Vérifié chaque minute. 0 jour = le jour même.'));
      }
    }
    body.appendChild(tb);

    // Conditions
    const cb = h('div', { class: 'builder-block' }, h('div', { class: 'blabel' }, h('span', { class: 'k if' }, 'SI'), 'Conditions (optionnel)'));
    a.conditions.forEach((c, i) => {
      const isGroup = c.column_id === 'group';
      const col = isGroup ? null : colById(c.column_id);
      cb.appendChild(h('div', { class: 'brow' },
        sel([['group', 'Groupe'], ...colOpts], c.column_id, v => { c.column_id = v === 'group' ? 'group' : parseInt(v); c.value = undefined; draw(); }),
        sel(Object.entries(isGroup ? { eq: 'est', neq: "n'est pas" } : OPS), c.op, v => { c.op = v; draw(); }),
        ['empty', 'not_empty'].includes(c.op) ? null :
          isGroup ? (c.value === undefined && (c.value = grpOpts[0]?.[0]), sel(grpOpts, c.value, v => c.value = parseInt(v)))
            : valueEditor(col, c.value, v => c.value = v, 'cond'),
        h('button', { class: 'icon-btn', onclick: () => { a.conditions.splice(i, 1); draw(); } }, '✕')));
    });
    cb.appendChild(h('button', { class: 'btn small', onclick: () => { a.conditions.push({ column_id: cols[0] ? cols[0].id : 'group', op: 'eq' }); draw(); } }, '+ Ajouter une condition'));
    body.appendChild(cb);

    // Actions
    const ab = h('div', { class: 'builder-block' }, h('div', { class: 'blabel' }, h('span', { class: 'k then' }, 'ALORS'), 'Actions'));
    const svcList = 'svc' + Math.random().toString(36).slice(2);
    const notifList = 'ntf' + Math.random().toString(36).slice(2);
    ab.appendChild(h('datalist', { id: svcList }, S.services.map(s => h('option', { value: s }))));
    ab.appendChild(h('datalist', { id: notifList }, S.services.filter(s => s.startsWith('notify.')).map(s => h('option', { value: s }))));
    a.actions.forEach((x, i) => {
      const box = h('div', { class: 'action-box' });
      box.appendChild(h('div', { class: 'brow' }, sel(Object.entries(ACTIONS), x.type, v => { a.actions[i] = { type: v }; draw(); }),
        h('button', { class: 'icon-btn', onclick: () => { a.actions.splice(i, 1); draw(); } }, '✕')));
      if (x.type === 'set_column') {
        const settable = cols.filter(c => c.type !== 'photo');
        if (!x.column_id && settable[0]) x.column_id = settable[0].id;
        const col = colById(x.column_id);
        box.appendChild(h('div', { class: 'brow' }, sel(settable.map(c => [c.id, c.name]), x.column_id, v => { x.column_id = parseInt(v); x.value = undefined; draw(); }),
          h('span', null, 'à'), valueEditor(col, x.value, v => x.value = v, 'set')));
      }
      if (x.type === 'move_to_group' || x.type === 'duplicate_item') {
        if (!x.group_id && x.type === 'move_to_group') x.group_id = grpOpts[0]?.[0];
        box.appendChild(h('div', { class: 'brow' }, sel((x.type === 'duplicate_item' ? [['', 'Même groupe']] : []).concat(grpOpts), x.group_id || '', v => x.group_id = v ? parseInt(v) : null)));
      }
      if (x.type === 'notify') {
        box.appendChild(h('div', { class: 'brow' }, h('input', { class: 'inp', list: notifList, value: x.service || '', placeholder: 'notify.mobile_app_mon_telephone', oninput: e => x.service = e.target.value })));
        box.appendChild(h('div', { class: 'brow' }, h('input', { class: 'inp', value: x.title || '', placeholder: 'Titre', oninput: e => x.title = e.target.value })));
        box.appendChild(h('textarea', { class: 'inp', value: x.message || '', placeholder: 'Message, ex : {item} est passé à {Statut}', oninput: e => x.message = e.target.value }));
      }
      if (x.type === 'persistent_notification') {
        box.appendChild(h('div', { class: 'brow' }, h('input', { class: 'inp', value: x.title || '', placeholder: 'Titre', oninput: e => x.title = e.target.value })));
        box.appendChild(h('textarea', { class: 'inp', value: x.message || '', placeholder: 'Message', oninput: e => x.message = e.target.value }));
      }
      if (x.type === 'ha_service') {
        box.appendChild(h('div', { class: 'brow' }, h('input', { class: 'inp', list: svcList, value: x.service || '', placeholder: 'light.turn_on', oninput: e => x.service = e.target.value })));
        box.appendChild(h('textarea', { class: 'inp', value: x.data || '', placeholder: '{"entity_id": "light.bureau"}', oninput: e => x.data = e.target.value }));
        box.appendChild(h('div', { class: 'hint' }, 'Données au format JSON. Les valeurs texte acceptent les variables.'));
      }
      if (x.type === 'fire_event') {
        box.appendChild(h('div', { class: 'brow' }, h('input', { class: 'inp', value: x.event || 'ha_tickets', oninput: e => x.event = e.target.value })));
        box.appendChild(h('div', { class: 'hint' }, 'Utilisable comme déclencheur « Événement » dans les automatisations HA. Données : item, board, group, values…'));
      }
      if (x.type === 'add_update') {
        box.appendChild(h('textarea', { class: 'inp', value: x.text || '', placeholder: 'Texte de la mise à jour', oninput: e => x.text = e.target.value }));
      }
      ab.appendChild(box);
    });
    ab.appendChild(h('button', { class: 'btn small', onclick: () => { a.actions.push({ type: 'set_column' }); draw(); } }, '+ Ajouter une action'));
    body.appendChild(ab);
    body.appendChild(h('div', { class: 'hint', html:
      'Variables : <code>{item}</code> <code>{groupe}</code> <code>{tableau}</code> <code>{date}</code> <code>{id}</code> et <code>{Nom de colonne}</code> (ex : <code>{Statut}</code>, <code>{Responsable}</code>).' }));
  };
  draw();

  const m = modal(auto && auto.id ? 'Modifier l’automatisation' : 'Nouvelle automatisation', body, [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Annuler'),
    h('button', { class: 'btn primary', onclick: async () => {
      if (!a.actions.length) return toast('Ajoutez au moins une action', true);
      if (a.trigger.type === 'column_changed' && !a.trigger.column_id) return toast('Choisissez une colonne', true);
      if (!a.name.trim()) a.name = new DOMParser().parseFromString(describeAuto(a), 'text/html').body.textContent.slice(0, 80);
      if (a.id) await api('PUT', 'api/automations/' + a.id, a);
      else await api('POST', `api/boards/${S.boardId}/automations`, a);
      m.close(); toast('Automatisation enregistrée ✓'); await refresh(); if (after) after();
    } }, 'Enregistrer')]);
}

// ------------------------------------------------------------------ démarrage
async function init() {
  try {
    S.me = await api('GET', 'api/me');
    await loadBoards();
    await loadBoard();
    api('GET', 'api/ha/persons').then(p => { S.persons = p || []; if (S.data) render(); }).catch(() => {});
  } catch (e) {
    $('#main').innerHTML = '<div class="empty">Impossible de charger les données.</div>';
  }
  // rafraîchissement périodique (multi-utilisateurs, automatisations planifiées)
  setInterval(() => {
    const ae = document.activeElement;
    const busy = currentPop || $('#overlay-root').children.length || dragItem || dragCol ||
      (ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName));
    if (!busy && !document.hidden) loadBoard(true).catch(() => {});
  }, 15000);
  addEventListener('resize', () => { if (S.data) renderSidebar(); });
}
init();
