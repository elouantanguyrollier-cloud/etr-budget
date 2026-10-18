'use strict';

/* =========================================================
   ETR BUDGET — données stockées uniquement sur l'appareil
   Montants en centimes (entiers) pour éviter les erreurs d'arrondi.
   ========================================================= */

const STORE_KEY = 'etr-budget-v1';

const DEFAULT_CATEGORIES = [
  ['🛒', 'Courses', 25000],
  ['🚗', 'Transport', 8000],
  ['🍔', 'Restos & sorties', 5000],
  ['💊', 'Santé', 2000],
  ['👕', 'Shopping', 3000],
  ['🏠', 'Maison', 2000],
  ['🎁', 'Imprévus', 3000],
  ['📦', 'Autre', 0],
];

let state;
let ui = { tab: 'home', offset: 0, opsFilter: 'all', budgetSeg: 'income' };

/* ---------------- Stockage ---------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function freshState() {
  return {
    version: 1,
    settings: { startDay: 1, theme: 'auto' },
    categories: DEFAULT_CATEGORIES.map(([emoji, name, budget]) => ({ id: uid(), emoji, name, budget })),
    incomes: [],
    fixed: [],
    transactions: [],
    goals: [],
    rules: {},
    createdAt: todayISO(),
    onboarded: false,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (!s.createdAt) s.createdAt = (s.transactions || []).map((t) => t.date).sort()[0] || todayISO();
      return Object.assign(freshState(), s, { settings: Object.assign({ startDay: 1, theme: 'auto' }, s.settings) });
    }
  } catch (e) { /* stockage indisponible : on repart de zéro */ }
  return freshState();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('⚠️ Impossible d’enregistrer sur cet appareil');
  }
}

if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

/* ---------------- Utilitaires ---------------- */

const eurFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eur0Fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur = (c) => eurFmt.format(c / 100);
const eurShort = (c) => (Math.abs(c) >= 100000 ? eur0Fmt.format(c / 100) : eur(c));

function parseAmount(str) {
  if (str == null) return NaN;
  const clean = String(str).replace(/\s/g, '').replace('€', '').replace(',', '.');
  if (clean === '') return NaN;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const toInput = (c) => (c ? (c % 100 ? (c / 100).toFixed(2) : String(c / 100)).replace('.', ',') : '');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => isoDate(new Date());
const dayDiff = (a, b) => Math.round((b - a) / 86400000);

/* ---------------- Périodes ---------------- */

// Une période va du jour "startDay" d'un mois jusqu'à la veille du même jour le mois suivant.
function periodFor(offset = 0) {
  const sd = state.settings.startDay;
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth();
  if (now.getDate() < sd) m -= 1;
  m += offset;
  const start = new Date(y, m, sd);
  const end = new Date(y, m + 1, sd - 1);
  return { start, end, startISO: isoDate(start), endISO: isoDate(end), offset };
}

function periodLabel(p, short = false) {
  if (state.settings.startDay === 1) {
    return p.start.toLocaleDateString('fr-FR', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
  }
  if (short) return p.start.toLocaleDateString('fr-FR', { month: 'short' });
  const f = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `${f(p.start)} → ${f(p.end)}`;
}

// Date où tombe un élément récurrent (jour du mois) à l'intérieur d'une période
function recurringDate(p, day) {
  const s = p.start;
  for (let i = 0; i < 2; i++) {
    const y = s.getFullYear();
    const m = s.getMonth() + i;
    const last = new Date(y, m + 1, 0).getDate();
    const d = new Date(y, m, Math.min(day, last));
    if (d >= p.start && d <= p.end) return d;
  }
  return p.start;
}

/* ---------------- Calculs ---------------- */

function txInPeriod(p) {
  return state.transactions.filter((t) => t.date >= p.startISO && t.date <= p.endISO);
}

function compute(p) {
  const txs = txInPeriod(p);
  const recurringIncome = state.incomes.reduce((a, i) => a + i.amount, 0);
  const extraIncome = txs.filter((t) => t.type === 'income').reduce((a, t) => a + t.amount, 0);
  const income = recurringIncome + extraIncome;
  const fixed = state.fixed.reduce((a, f) => a + f.amount, 0);
  const saving = state.goals.reduce((a, g) => a + (g.monthly || 0), 0);
  const available = income - fixed - saving; // ce qu'on peut dépenser librement
  const expenses = txs.filter((t) => t.type === 'expense');
  const spent = expenses.reduce((a, t) => a + t.amount, 0);
  const left = available - spent;

  const byCat = {};
  for (const t of expenses) byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount;
  const budgeted = state.categories.reduce((a, c) => a + (c.budget || 0), 0);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let daysLeft = 0;
  let status = 'past';
  if (today >= p.start && today <= p.end) { daysLeft = dayDiff(today, p.end) + 1; status = 'current'; }
  else if (today < p.start) { daysLeft = dayDiff(p.start, p.end) + 1; status = 'future'; }
  const totalDays = dayDiff(p.start, p.end) + 1;

  return { txs, income, recurringIncome, extraIncome, fixed, saving, available, spent, left, byCat, budgeted, daysLeft, totalDays, status };
}

function envelopeState(cat, spent) {
  const budget = cat.budget || 0;
  const left = budget - spent;
  const ratio = budget > 0 ? spent / budget : (spent > 0 ? 2 : 0);
  let level = 'good';
  if (budget > 0 || spent > 0) {
    if (ratio > 1) level = 'crit';
    else if (ratio >= 0.8) level = 'warn';
  }
  return { budget, spent, left, ratio, level };
}

const catById = (id) => state.categories.find((c) => c.id === id) || { emoji: '📦', name: 'Sans catégorie', budget: 0, id };

state = load();

/* ---------------- Rendu ---------------- */

const $view = document.getElementById('view');

function render() {
  applyTheme();
  const p = periodFor(ui.offset);
  document.getElementById('periodLabel').textContent = periodLabel(p);
  document.getElementById('periodToday').hidden = ui.offset === 0;
  document.querySelector('.topbar').style.visibility = ui.tab === 'settings' ? 'hidden' : '';
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const views = { home: renderHome, ops: renderOps, budget: renderBudget, stats: renderStats, settings: renderSettings };
  $view.innerHTML = views[ui.tab](p);
}

function levelFor(left, available) {
  if (left < 0) return 'crit';
  if (available > 0 && left / available < 0.15) return 'warn';
  return 'good';
}

// Période entièrement antérieure à la première utilisation de l'appli
const beforeStart = (p) => p.endISO < state.createdAt;

function renderHome(p) {
  if (beforeStart(p)) {
    return `<div class="card empty">Tu n'utilisais pas encore ETR BUDGET pendant cette période.<br><br>
      <button class="btn secondary" data-action="today-period">Revenir au mois en cours</button></div>`;
  }
  const c = compute(p);
  const level = c.income === 0 && c.spent === 0 ? 'good' : levelFor(c.left, c.available);
  const perDay = c.daysLeft > 0 ? Math.floor(c.left / c.daysLeft) : 0;
  const usedPct = c.available > 0 ? Math.min(100, (c.spent / c.available) * 100) : (c.spent > 0 ? 100 : 0);
  let html = '';

  if (!state.onboarded && state.incomes.length === 0) {
    html += `
      <div class="card">
        <div style="font-size:20px;font-weight:700;margin-bottom:6px">Bienvenue 👋</div>
        <div class="help">Trois étapes pour démarrer :
          <ol>
            <li><b>Tes revenus</b> : salaire, aides, bourse…</li>
            <li><b>Tes charges fixes</b> : loyer, forfait, abonnements…</li>
            <li><b>Ta répartition</b> : épargne, PEA, puis enveloppes de dépenses</li>
          </ol>
          Ensuite, chaque dépense se range toute seule dans son enveloppe (voir Réglages → Saisie automatique).
        </div>
        <div style="margin-top:14px">
          <button class="btn" data-action="goto-budget" data-seg="income">Commencer</button>
          <button class="btn secondary" data-action="dismiss-onboarding">Plus tard</button>
        </div>
      </div>`;
  }

  // Carte principale
  let sub;
  if (c.status === 'current') {
    sub = `sur <strong class="num">${eur(c.available)}</strong> disponibles ce mois-ci`;
  } else if (c.status === 'past') {
    sub = c.left >= 0 ? `Mois terminé avec <strong>${eur(c.left)}</strong> d'avance 🎉` : `Mois terminé avec <strong>${eur(-c.left)}</strong> de dépassement`;
  } else {
    sub = `prévus sur <strong class="num">${eur(c.available)}</strong> disponibles`;
  }

  html += `
    <div class="card hero">
      <div class="hero-label">Reste à vivre</div>
      <div class="hero-amount num ${c.left < 0 ? 'neg' : ''}">${eur(c.left)}</div>
      <div class="hero-sub">${sub}</div>
      ${c.status !== 'past' ? `
        <div class="perday ${level === 'good' ? '' : level}">
          <div class="perday-amount num">${c.left > 0 ? eur(perDay) : '0 €'}</div>
          <div class="perday-text">${c.left > 0
            ? `par jour pendant <b>${c.daysLeft} jour${c.daysLeft > 1 ? 's' : ''}</b><br>jusqu'au ${p.end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
            : c.left < 0
              ? `<b>Budget dépassé.</b> Évite toute dépense non essentielle d'ici le ${p.end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}.`
              : c.income === 0 ? 'Ajoute tes revenus dans <b>Budget</b> pour calculer ton reste à vivre.' : "<b>Plus rien de disponible</b> jusqu'à la fin du mois."}</div>
        </div>` : ''}
      <div class="progress ${level === 'good' ? '' : level}"><span style="width:${usedPct}%"></span></div>
      <div class="progress-legend"><span>Dépensé ${eur(c.spent)}</span><span>${Math.round(usedPct)} %</span></div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Revenus</div><div class="kpi-value num">${eurShort(c.income)}</div></div>
      <div class="kpi"><div class="kpi-label">Charges fixes</div><div class="kpi-value num">${eurShort(c.fixed)}</div></div>
      <div class="kpi"><div class="kpi-label">Épargne prévue</div><div class="kpi-value num">${eurShort(c.saving)}</div></div>
      <div class="kpi"><div class="kpi-label">Dépenses</div><div class="kpi-value num">${eurShort(c.spent)}</div></div>
    </div>`;

  // Alertes
  const alerts = [];
  for (const cat of state.categories) {
    const e = envelopeState(cat, c.byCat[cat.id] || 0);
    if (e.level === 'crit' && e.spent > 0) alerts.push(`<div class="alert crit"><span class="ai">🚨</span><div><b>${esc(cat.emoji)} ${esc(cat.name)}</b> : dépassé de <b class="num">${eur(-e.left)}</b></div></div>`);
    else if (e.level === 'warn') alerts.push(`<div class="alert warn"><span class="ai">⚠️</span><div><b>${esc(cat.emoji)} ${esc(cat.name)}</b> : plus que <b class="num">${eur(e.left)}</b> (${Math.round(e.ratio * 100)} % utilisé)</div></div>`);
  }
  const toReview = c.txs.filter((t) => t.review).length;
  if (toReview) alerts.unshift(`<button class="alert info" style="width:100%;text-align:left" data-action="review"><span class="ai">❓</span><div><b>${toReview} dépense${toReview > 1 ? 's' : ''} automatique${toReview > 1 ? 's' : ''} à classer</b><br>Touche pour choisir l'enveloppe. Je retiendrai le commerçant.</div></button>`);
  const unassigned = c.available - c.budgeted;
  if (state.incomes.length > 0) {
    if (unassigned < 0) alerts.push(`<div class="alert crit"><span class="ai">🧮</span><div>Tes enveloppes dépassent ton disponible de <b class="num">${eur(-unassigned)}</b>. Réduis-en certaines dans Budget.</div></div>`);
    else if (unassigned > 0 && c.status !== 'past') alerts.push(`<div class="alert info"><span class="ai">💡</span><div><b class="num">${eur(unassigned)}</b> ne sont dans aucune enveloppe. Tu peux les mettre de côté ou les répartir.</div></div>`);
  }
  if (alerts.length) html += `<div class="section-title">Alertes</div>${alerts.join('')}`;

  // Prochains prélèvements
  if (c.status === 'current' && state.fixed.length) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const upcoming = state.fixed
      .map((f) => ({ f, d: recurringDate(p, f.day) }))
      .filter((x) => x.d >= today)
      .sort((a, b) => a.d - b.d);
    const upTotal = upcoming.reduce((a, x) => a + x.f.amount, 0);
    if (upcoming.length) {
      html += `<div class="section-title"><span>À venir · ${eur(upTotal)}</span></div><div class="list">`;
      html += upcoming.slice(0, 5).map(({ f, d }) => `
        <div class="row">
          <div class="row-icon">${esc(f.emoji || '📅')}</div>
          <div class="row-main"><div class="row-title">${esc(f.name)}</div>
          <div class="row-sub">${dayDiff(today, d) === 0 ? "aujourd'hui" : 'le ' + d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}</div></div>
          <div class="row-amount">−${eur(f.amount)}</div>
        </div>`).join('');
      html += `</div><div class="small muted" style="margin:6px 4px 0">Déjà déduits de ton reste à vivre.</div>`;
    }
  }

  // Dernières opérations
  const recent = [...c.txs].sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created)).slice(0, 5);
  html += `<div class="section-title"><span>Dernières opérations</span>${c.txs.length > 5 ? '<button data-tab-link="ops">Tout voir</button>' : ''}</div>`;
  html += recent.length ? `<div class="list">${recent.map(txRow).join('')}</div>`
    : `<div class="list"><div class="empty">Aucune opération pour cette période.<br>Touche <b>+</b> pour ajouter une dépense.</div></div>`;
  return html;
}

function txRow(t) {
  const cat = t.type === 'income' ? { emoji: '💶', name: 'Revenu' } : catById(t.categoryId);
  const date = parseISO(t.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `
    <button class="row" data-action="edit-tx" data-id="${t.id}">
      <div class="row-icon">${esc(cat.emoji)}</div>
      <div class="row-main">
        <div class="row-title">${esc(t.note || cat.name)}</div>
        <div class="row-sub">${t.review ? '<span class="tag">à classer</span> ' : t.auto ? '⚡ ' : ''}${t.note ? esc(cat.name) + ' · ' : ''}${date}</div>
      </div>
      <div class="row-amount ${t.type === 'income' ? 'in' : ''}">${t.type === 'income' ? '+' : '−'}${eur(t.amount)}</div>
    </button>`;
}

function renderOps(p) {
  const c = compute(p);
  let txs = [...c.txs];
  const f = ui.opsFilter;
  if (f === 'income') txs = txs.filter((t) => t.type === 'income');
  else if (f === 'review') txs = txs.filter((t) => t.review);
  else if (f !== 'all') txs = txs.filter((t) => t.type === 'expense' && t.categoryId === f);
  txs.sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));

  const used = new Set(c.txs.filter((t) => t.type === 'expense').map((t) => t.categoryId));
  let html = `<div class="chips">
    <button class="chip ${f === 'all' ? 'on' : ''}" data-action="ops-filter" data-f="all">Tout</button>
    ${c.txs.some((t) => t.review) || f === 'review' ? `<button class="chip ${f === 'review' ? 'on' : ''}" data-action="ops-filter" data-f="review">❓ À classer</button>` : ''}
    ${state.categories.filter((cat) => used.has(cat.id)).map((cat) => `<button class="chip ${f === cat.id ? 'on' : ''}" data-action="ops-filter" data-f="${cat.id}">${esc(cat.emoji)} ${esc(cat.name)}</button>`).join('')}
    ${c.extraIncome ? `<button class="chip ${f === 'income' ? 'on' : ''}" data-action="ops-filter" data-f="income">💶 Revenus</button>` : ''}
  </div>`;

  const total = txs.reduce((a, t) => a + (t.type === 'income' ? t.amount : -t.amount), 0);
  html += `<div class="small muted" style="margin:0 4px 4px">${txs.length} opération${txs.length > 1 ? 's' : ''} · total <span class="num">${total > 0 ? '+' : total < 0 ? '−' : ''}${eur(Math.abs(total))}</span></div>`;

  if (!txs.length) return html + `<div class="list"><div class="empty">Rien ici pour l'instant.</div></div>`;

  let lastDate = '';
  let open = false;
  for (const t of txs) {
    if (t.date !== lastDate) {
      if (open) html += '</div>';
      const d = parseISO(t.date);
      const diff = dayDiff(d, parseISO(todayISO()));
      const label = diff === 0 ? "Aujourd'hui" : diff === 1 ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      html += `<div class="day-head">${label}</div><div class="list">`;
      open = true;
      lastDate = t.date;
    }
    html += txRow(t);
  }
  return html + '</div>';
}

function renderBudget(p) {
  const c = compute(p);
  const seg = ui.budgetSeg;
  let html = `<div class="seg">
    <button class="${seg === 'income' ? 'on' : ''}" data-action="budget-seg" data-seg="income">① Revenus</button>
    <button class="${seg === 'fixed' ? 'on' : ''}" data-action="budget-seg" data-seg="fixed">② Charges</button>
    <button class="${seg === 'goals' ? 'on' : ''}" data-action="budget-seg" data-seg="goals">③ Épargne</button>
    <button class="${seg === 'env' ? 'on' : ''}" data-action="budget-seg" data-seg="env">④ Dépenses</button>
  </div>`;
  html += repartitionCard(c);

  if (seg === 'env') {
    html += `<div class="section-title"><span>Enveloppes de dépenses</span><button data-action="add-cat">+ Ajouter</button></div>
      <div class="small muted" style="margin:-4px 4px 8px">Combien tu t'autorises par mois dans chaque catégorie. Chaque dépense se range dans son enveloppe.</div><div class="list">`;
    html += state.categories.map((cat) => {
      const e = envelopeState(cat, c.byCat[cat.id] || 0);
      const pct = e.budget > 0 ? Math.min(100, e.ratio * 100) : (e.spent > 0 ? 100 : 0);
      return `<button class="env" data-action="edit-cat" data-id="${cat.id}">
        <div class="env-top">
          <div class="row-icon">${esc(cat.emoji)}</div>
          <div class="env-name">${esc(cat.name)}</div>
          <div class="env-left ${e.level === 'good' ? '' : e.level}">${e.budget > 0 || e.spent > 0 ? (e.left >= 0 ? eur(e.left) : '−' + eur(-e.left)) : '—'}</div>
        </div>
        <div class="progress ${e.level === 'good' ? '' : e.level}"><span style="width:${pct}%"></span></div>
        <div class="env-meta"><span>Dépensé ${eur(e.spent)}</span><span>${e.budget > 0 ? 'sur ' + eur(e.budget) : 'pas de budget'}</span></div>
      </button>`;
    }).join('');
    html += '</div>';
  }

  if (seg === 'income') {
    const incTotal = state.incomes.reduce((a, i) => a + i.amount, 0);
    html += `<div class="section-title"><span>Sources de revenus · ${eur(incTotal)}/mois</span><button data-action="add-income">+ Ajouter</button></div>`;
    html += `<div class="list">${state.incomes.length ? state.incomes.slice().sort((a, b) => a.day - b.day).map((i) => recurringRow(i, 'income', p)).join('') : '<div class="empty">Ajoute toutes tes sources de revenus :<br>salaire, APL, bourse, prime d\'activité, job étudiant…</div>'}</div>`;
    if (!state.incomes.length) html += quickAdds('income', [['💼', 'Salaire'], ['🏠', 'APL'], ['🎓', 'Bourse'], ['➕', "Prime d'activité"], ['👨‍👩‍👦', 'Aide familiale']]);
    html += `<div class="small muted" style="margin:8px 4px">Comptés automatiquement chaque mois. Un revenu exceptionnel (remboursement, vente…) s'ajoute avec le bouton <b>+</b>.</div>`;
    if (state.incomes.length) html += `<button class="btn secondary" style="margin-top:12px" data-action="budget-seg" data-seg="fixed">Étape suivante : charges fixes →</button>`;
  }

  if (seg === 'fixed') {
    const fixTotal = state.fixed.reduce((a, f) => a + f.amount, 0);
    html += `<div class="section-title"><span>Charges fixes · ${eur(fixTotal)}/mois</span><button data-action="add-fixed">+ Ajouter</button></div>`;
    html += `<div class="list">${state.fixed.length ? state.fixed.slice().sort((a, b) => a.day - b.day).map((f) => recurringRow(f, 'fixed', p)).join('') : '<div class="empty">Tout ce qui tombe chaque mois sans que tu choisisses :<br>loyer, électricité, forfait, assurance, abonnements…</div>'}</div>`;
    if (!state.fixed.length) html += quickAdds('fixed', [['🏠', 'Loyer'], ['⚡', 'Électricité'], ['📱', 'Forfait mobile'], ['🌐', 'Box internet'], ['🛡️', 'Assurance'], ['🎬', 'Abonnements']]);
    html += `<button class="btn secondary" style="margin-top:12px" data-action="budget-seg" data-seg="goals">Étape suivante : épargne & placements →</button>`;
  }

  if (seg === 'goals') {
    const monthly = state.goals.reduce((a, g) => a + (g.monthly || 0), 0);
    html += `<div class="section-title"><span>Épargne & placements · ${eur(monthly)}/mois</span><button data-action="add-goal">+ Ajouter</button></div>`;
    if (!state.goals.length) {
      html += `<div class="list"><div class="empty">Choisis combien tu mets de côté chaque mois et où :<br>Livret A, PEA, fonds d'urgence, projet…<br>Ces sommes sont réservées <b>avant</b> de calculer ton reste à vivre.</div></div>`;
      html += quickAdds('goal', [['🆘', "Fonds d'urgence"], ['🏦', 'Livret A'], ['📈', 'PEA'], ['💰', 'LDDS'], ['🌴', 'Vacances'], ['🚗', 'Permis / voiture']]);
    } else {
      html += `<div class="list">${state.goals.map((g) => {
        const hasTarget = g.target > 0;
        const pct = hasTarget ? Math.min(100, (g.saved / g.target) * 100) : 0;
        const rest = Math.max(0, g.target - g.saved);
        const months = hasTarget && g.monthly > 0 ? Math.ceil(rest / g.monthly) : null;
        const kind = g.kind === 'invest' ? 'Placement' : 'Épargne';
        return `<button class="env" data-action="edit-goal" data-id="${g.id}">
          <div class="env-top">
            <div class="row-icon">${esc(g.emoji || '🎯')}</div>
            <div class="env-name">${esc(g.name)} <span class="tag">${kind}</span></div>
            <div class="env-left num">${eur(g.saved)}</div>
          </div>
          ${hasTarget ? `<div class="progress"><span style="width:${pct}%;background:var(--bar)"></span></div>` : ''}
          <div class="env-meta"><span>${eur(g.monthly || 0)}/mois</span><span>${hasTarget ? (rest === 0 ? 'Objectif atteint 🎉' : `${Math.round(pct)} % de ${eur(g.target)}${months ? ` · ~${months} mois` : ''}`) : 'sans objectif'}</span></div>
        </button>`;
      }).join('')}</div>
      <div class="small muted" style="margin:8px 4px">Touche une ligne pour enregistrer un versement ou modifier.</div>`;
    }
    html += `<button class="btn secondary" style="margin-top:12px" data-action="budget-seg" data-seg="env">Étape suivante : enveloppes de dépenses →</button>`;
  }
  return html;
}

function quickAdds(kind, items) {
  return `<div class="small muted" style="margin:12px 4px 6px">Ajout rapide :</div><div class="chips" style="flex-wrap:wrap">${items.map(([e, n]) =>
    `<button class="chip" data-action="quick-${kind}" data-emoji="${esc(e)}" data-name="${esc(n)}">${e} ${esc(n)}</button>`).join('')}</div>`;
}

// Comment les revenus du mois sont répartis
function repartitionCard(c) {
  if (!c.income) return '';
  const envBudget = c.budgeted;
  const free = c.income - c.fixed - c.saving - envBudget;
  const rows = [
    ['Charges fixes', c.fixed],
    ['Épargne & placements', c.saving],
    ['Enveloppes de dépenses', envBudget],
  ];
  if (free !== 0) rows.push([free > 0 ? 'Non attribué' : 'Trop attribué', free]);
  return `<div class="card" style="padding:14px">
    <div style="display:flex;justify-content:space-between;margin-bottom:12px"><b>Répartition de tes revenus</b><b class="num">${eur(c.income)}</b></div>
    ${rows.map(([label, v]) => {
      const pct = Math.round((Math.abs(v) / c.income) * 100);
      const neg = v < 0;
      return `<div class="hbar" data-tip="${esc(label)} : ${eur(Math.abs(v))} (${pct} % des revenus)">
        <div class="hbar-top"><span>${label}</span><span class="num" style="${neg ? 'color:var(--crit)' : ''}"><b>${neg ? '−' : ''}${eur(Math.abs(v))}</b> <span class="muted">${pct} %</span></span></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.min(100, pct)}%;${neg ? 'background:var(--crit-bar)' : ''}"></div></div>
      </div>`;
    }).join('')}
  </div>`;
}

function recurringRow(item, kind, p) {
  const d = recurringDate(p, item.day);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const passed = d <= today;
  const label = kind === 'income' ? (passed ? 'reçu' : 'à venir') : (passed ? 'prélevé' : 'à venir');
  return `<button class="row" data-action="edit-${kind}" data-id="${item.id}">
    <div class="row-icon">${esc(item.emoji || (kind === 'income' ? '💶' : '📅'))}</div>
    <div class="row-main"><div class="row-title">${esc(item.name)}</div>
      <div class="row-sub">le ${item.day} du mois ${ui.offset === 0 ? `· <span class="tag ${passed ? 'done' : ''}">${label}</span>` : ''}</div></div>
    <div class="row-amount ${kind === 'income' ? 'in' : ''}">${kind === 'income' ? '+' : '−'}${eur(item.amount)}</div>
  </button>`;
}

function renderStats(p) {
  const c = compute(p);
  let html = '';

  // Dépenses par catégorie (barres horizontales, triées)
  const rows = Object.entries(c.byCat).map(([id, v]) => ({ cat: catById(id), v })).sort((a, b) => b.v - a.v);
  const max = rows.length ? rows[0].v : 0;
  html += `<div class="section-title">Dépenses par catégorie</div><div class="card">`;
  if (!rows.length) html += `<div class="empty" style="padding:12px">Pas encore de dépenses sur cette période.</div>`;
  else {
    html += rows.map(({ cat, v }) => {
      const share = c.spent ? Math.round((v / c.spent) * 100) : 0;
      const budgetTxt = cat.budget ? ` · budget ${eur(cat.budget)}` : '';
      return `<div class="hbar" data-tip="${esc(cat.name)} : ${eur(v)} (${share} %)${budgetTxt}">
        <div class="hbar-top"><span>${esc(cat.emoji)} ${esc(cat.name)}</span><span class="num"><b>${eur(v)}</b> <span class="muted">${share} %</span></span></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${max ? (v / max) * 100 : 0}%"></div></div>
      </div>`;
    }).join('');
  }
  html += `</div>`;

  // Chiffres clés
  const elapsed = c.status === 'current' ? c.totalDays - c.daysLeft + 1 : c.totalDays;
  const avg = elapsed > 0 ? Math.round(c.spent / elapsed) : 0;
  const biggest = c.txs.filter((t) => t.type === 'expense').sort((a, b) => b.amount - a.amount)[0];
  const projected = c.status === 'current' ? avg * c.totalDays : c.spent;
  html += `<div class="section-title">Chiffres clés</div><div class="stat-grid">
    <div class="kpi"><div class="kpi-label">Moyenne / jour</div><div class="kpi-value num">${eur(avg)}</div></div>
    <div class="kpi"><div class="kpi-label">${c.status === 'current' ? 'Projection fin de mois' : 'Total dépensé'}</div><div class="kpi-value num" style="color:${projected > c.available ? 'var(--crit)' : 'inherit'}">${eurShort(projected)}</div></div>
    <div class="kpi"><div class="kpi-label">Nb de dépenses</div><div class="kpi-value num">${c.txs.filter((t) => t.type === 'expense').length}</div></div>
    <div class="kpi"><div class="kpi-label">Plus grosse dépense</div><div class="kpi-value num">${biggest ? eurShort(biggest.amount) : '—'}</div></div>
  </div>`;
  if (c.status === 'current' && projected > c.available && c.spent > 0) {
    html += `<div class="alert warn" style="margin-top:8px"><span class="ai">📈</span><div>À ce rythme tu dépasserais de <b class="num">${eur(projected - c.available)}</b> en fin de mois. Vise <b class="num">${eur(Math.max(0, Math.floor(c.left / Math.max(1, c.daysLeft))))}</b>/jour.</div></div>`;
  }

  // Historique 6 périodes
  const hist = [];
  for (let i = 5; i >= 0; i--) {
    const pp = periodFor(p.offset - i);
    if (beforeStart(pp)) continue;
    const cc = compute(pp);
    hist.push({ p: pp, spent: cc.spent, available: cc.available, current: i === 0 });
  }
  const hmax = Math.max(1, ...hist.map((h) => Math.max(h.spent, h.available)));
  html += `<div class="section-title">Dépenses des derniers mois</div><div class="card">
    <div class="vchart">${hist.map((h) => {
      const over = h.available > 0 && h.spent > h.available;
      return `<div class="vcol ${h.current ? 'current' : ''} ${over ? 'over' : ''}" data-tip="${esc(periodLabel(h.p))} : ${eur(h.spent)} dépensés sur ${eur(h.available)} disponibles">
        <div class="vval">${h.spent ? eur0Fmt.format(h.spent / 100) : ''}</div>
        <div class="vbar" style="height:${(h.spent / hmax) * 100}%"></div>
      </div>`;
    }).join('')}</div>
    <div class="vlabels">${hist.map((h) => `<span>${esc(periodLabel(h.p, true))}</span>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--accent)"></i>Mois affiché</span><span><i style="background:var(--bar)"></i>Mois précédents</span><span><i style="background:var(--crit-bar)"></i>Au-delà du disponible</span></div>
  </div>`;
  return html;
}

function renderSettings() {
  const s = state.settings;
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  return `
    <div style="font-size:28px;font-weight:750;margin:4px 4px 12px">Réglages</div>
    <div class="list">
      <div class="setting-row"><span>Thème</span>
        <select data-setting="theme">
          <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Comme le téléphone</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Clair</option>
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Sombre</option>
        </select></div>
      <div class="setting-row"><div><div>Début du mois budgétaire</div><div class="small muted">Ex. le jour où tu reçois ton salaire</div></div>
        <select data-setting="startDay">${days.map((d) => `<option value="${d}" ${s.startDay === d ? 'selected' : ''}>le ${d}</option>`).join('')}</select></div>
    </div>

    <div class="section-title">Sauvegarde</div>
    <div class="card help">
      Tes données restent <b>uniquement sur ce téléphone</b>. Fais une sauvegarde de temps en temps (dans Fichiers ou iCloud Drive) pour ne rien perdre.
      <div style="margin-top:12px">
        <button class="btn" data-action="export-json">💾 Sauvegarder mes données</button>
        <button class="btn secondary" data-action="import-json">📂 Restaurer une sauvegarde</button>
        <button class="btn secondary" data-action="export-csv">📄 Exporter en tableur (CSV)</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>

    <div class="section-title">⚡ Saisie automatique (Apple Pay)</div>
    <div class="card help">
      À chaque paiement avec Apple Pay, l'iPhone peut envoyer la dépense ici toute seule : elle est rangée dans la bonne enveloppe d'après le commerçant (Lidl → Courses, etc.). Quand je ne connais pas un commerçant, je te demande une fois puis je m'en souviens.
      <ol>
        <li>Ouvre l'app <b>Raccourcis</b>, onglet <b>Automatisation</b>, puis <b>+</b></li>
        <li>Choisis <b>Transaction</b>, sélectionne ta carte, coche <b>Exécuter immédiatement</b>, puis <b>Suivant</b></li>
        <li>Crée une automatisation vide et ajoute l'action <b>Encoder l'URL</b> : touche le champ et choisis la variable <b>Marchand</b></li>
        <li>Ajoute l'action <b>Ouvrir les URL</b> et colle ce lien, puis remplace <code>MONTANT</code> par la variable <b>Montant</b> et <code>MARCHAND</code> par <b>Texte encodé en URL</b> :</li>
      </ol>
      <div class="input small num" style="margin-top:10px;overflow-wrap:anywhere;word-break:break-all;user-select:all;-webkit-user-select:all">${esc(autoUrl())}</div>
      <button class="btn secondary" style="margin-top:8px" data-action="copy-url" data-url="${esc(autoUrl())}">Copier le lien</button>
      <div class="hint" style="margin-top:10px">Ça fonctionne seulement pour les paiements <b>Apple Pay</b> (iPhone ou Apple Watch). La carte physique, les retraits et les prélèvements ne passent pas par là : ajoute-les avec le bouton <b>+</b>.</div>
    </div>

    <div class="section-title">Installer sur l'iPhone</div>
    <div class="card help">
      <ol style="margin:0">
        <li>Ouvre cette page dans <b>Safari</b></li>
        <li>Touche <b>Partager</b> (carré avec une flèche), puis <b>« Sur l'écran d'accueil »</b></li>
        <li><b>Important pour la saisie automatique</b> : <b>désactive</b> l'option <b>« Ouvrir en tant qu'app web »</b>. Sinon l'icône garde des données séparées de Safari, et les dépenses Apple Pay ne s'afficheraient pas.</li>
      </ol>
    </div>

    <div class="section-title">Zone sensible</div>
    <div class="list"><button class="row" data-action="reset" style="color:var(--crit);justify-content:center">Tout effacer</button></div>
    <div class="small muted" style="text-align:center;margin-top:20px">ETR BUDGET · v1.0</div>`;
}

function autoUrl() {
  return `${location.origin}${location.pathname}#ajout?montant=MONTANT&marchand=MARCHAND`;
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0d0d0d' : '#f6f6f3'));
}

/* ---------------- Feuilles (formulaires) ---------------- */

const $sheet = document.getElementById('sheet');
const $backdrop = document.getElementById('backdrop');

function openSheet(title, body, onSubmit) {
  $sheet.innerHTML = `<div class="sheet-grip"></div>
    <div class="sheet-head"><h2>${title}</h2><button data-action="close-sheet">Annuler</button></div>
    <form id="sheetForm" novalidate>${body}</form>`;
  $sheet.hidden = false;
  $backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  const form = document.getElementById('sheetForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (onSubmit(new FormData(form), form) !== false) closeSheet();
  });
  const first = form.querySelector('[autofocus]');
  if (first) setTimeout(() => first.focus(), 60);
  return form;
}

function closeSheet() {
  $sheet.hidden = true;
  $backdrop.hidden = true;
  $sheet.innerHTML = '';
  document.body.style.overflow = '';
}

function invalid(form, name, msg) {
  const el = form.querySelector(`[name="${name}"]`);
  if (el) { el.focus(); el.style.borderColor = 'var(--crit)'; }
  toast(msg);
  return false;
}

function txSheet(tx) {
  const editing = !!tx;
  const t = tx || { type: 'expense', amount: 0, categoryId: state.categories[0]?.id, note: '', date: defaultTxDate() };
  const body = `
    <div class="seg" id="typeSeg">
      <button type="button" class="${t.type === 'expense' ? 'on' : ''}" data-type="expense">Dépense</button>
      <button type="button" class="${t.type === 'income' ? 'on' : ''}" data-type="income">Revenu ponctuel</button>
    </div>
    <input type="hidden" name="type" value="${t.type}">
    <div class="field"><input class="input amount-input num" name="amount" inputmode="decimal" placeholder="0,00 €" value="${toInput(t.amount)}" autocomplete="off" ${editing ? '' : 'autofocus'}></div>
    <div class="field" id="catField" ${t.type === 'income' ? 'hidden' : ''}>
      <span class="field-label">Enveloppe</span>
      <div class="cat-grid">${state.categories.map((c) => `
        <button type="button" class="cat-opt ${c.id === t.categoryId ? 'on' : ''}" data-cat="${c.id}"><span>${esc(c.emoji)}</span><span>${esc(c.name)}</span></button>`).join('')}
      </div>
      <input type="hidden" name="categoryId" value="${esc(t.categoryId || '')}">
      <div class="hint" id="catHint"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Note</label><input class="input" name="note" value="${esc(t.note)}" placeholder="ex. Lidl" maxlength="60"></div>
      <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${t.date}"></div>
    </div>
    <button class="btn" type="submit">${editing ? 'Enregistrer' : 'Ajouter'}</button>
    ${editing ? `<button class="btn danger" type="button" data-action="delete-tx" data-id="${t.id}">Supprimer l'opération</button>` : ''}`;

  const form = openSheet(editing ? "Modifier l'opération" : 'Nouvelle opération', body, (fd, f) => {
    const amount = parseAmount(fd.get('amount'));
    if (!(amount > 0)) return invalid(f, 'amount', 'Entre un montant');
    const type = fd.get('type');
    const date = fd.get('date') || todayISO();
    const data = { type, amount, categoryId: type === 'expense' ? fd.get('categoryId') : null, note: fd.get('note').trim(), date };
    if (type === 'expense' && data.note) state.rules[merchantKey(data.note)] = data.categoryId;
    if (editing) { Object.assign(tx, data); delete tx.review; }
    else state.transactions.push({ id: uid(), created: new Date().toISOString(), ...data });
    save();
    render();
    if (type === 'expense') feedbackAfterExpense(data);
    else toast(`+${eur(amount)} ajouté à tes revenus`);
  });

  const hint = () => {
    const id = form.categoryId.value;
    const cat = catById(id);
    const p = periodFor(0);
    const spent = compute(p).byCat[id] || 0;
    const editingSame = editing && tx.type === 'expense' && tx.categoryId === id && tx.date >= p.startISO ? tx.amount : 0;
    const left = (cat.budget || 0) - spent + editingSame;
    document.getElementById('catHint').textContent = cat.budget ? `Il reste ${eur(left)} dans ${cat.name} ce mois-ci` : '';
  };
  hint();
  form.querySelectorAll('#typeSeg button').forEach((b) => b.addEventListener('click', () => {
    form.type.value = b.dataset.type;
    form.querySelectorAll('#typeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    document.getElementById('catField').hidden = b.dataset.type === 'income';
  }));
  form.querySelectorAll('.cat-opt').forEach((b) => b.addEventListener('click', () => {
    form.categoryId.value = b.dataset.cat;
    form.querySelectorAll('.cat-opt').forEach((x) => x.classList.toggle('on', x === b));
    hint();
  }));
}

function defaultTxDate() {
  // Si on regarde une autre période, proposer une date dans celle-ci
  if (ui.offset === 0) return todayISO();
  return periodFor(ui.offset).startISO;
}

function feedbackAfterExpense(tx) {
  const p = periodFor(0);
  if (tx.date < p.startISO || tx.date > p.endISO) { toast(`−${eur(tx.amount)} enregistré`); return; }
  const c = compute(p);
  const cat = catById(tx.categoryId);
  const e = envelopeState(cat, c.byCat[cat.id] || 0);
  if (e.budget > 0 && e.left < 0) toast(`🚨 ${cat.name} dépassé de ${eur(-e.left)}`, 4000);
  else if (e.level === 'warn') toast(`⚠️ Plus que ${eur(e.left)} dans ${cat.name}`, 3500);
  else if (c.left < 0) toast(`🚨 Budget du mois dépassé de ${eur(-c.left)}`, 4000);
  else toast(`✓ ${eur(tx.amount)} · reste ${eur(Math.floor(c.left / Math.max(1, c.daysLeft)))}/jour`);
}

function recurringSheet(kind, item, preset) {
  const editing = !!item;
  const isIncome = kind === 'income';
  const list = isIncome ? state.incomes : state.fixed;
  const it = item || Object.assign({ name: '', amount: 0, day: 1, emoji: isIncome ? '💶' : '📅' }, preset);
  const body = `
    <div class="field-row emoji">
      <div class="field"><label>Icône</label><input class="input emoji-input" name="emoji" value="${esc(it.emoji)}" maxlength="4"></div>
      <div class="field"><label>Nom</label><input class="input" name="name" value="${esc(it.name)}" placeholder="${isIncome ? 'ex. Salaire' : 'ex. Loyer'}" maxlength="40" ${editing || preset ? '' : 'autofocus'}></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Montant mensuel</label><input class="input num" name="amount" inputmode="decimal" placeholder="0,00" value="${toInput(it.amount)}" ${preset ? 'autofocus' : ''}></div>
      <div class="field"><label>Jour du mois</label><input class="input num" name="day" inputmode="numeric" type="number" min="1" max="31" value="${it.day}"></div>
    </div>
    <button class="btn" type="submit">${editing ? 'Enregistrer' : 'Ajouter'}</button>
    ${editing ? `<button class="btn danger" type="button" data-action="delete-${kind}" data-id="${it.id}">Supprimer</button>` : ''}`;
  openSheet(`${editing ? 'Modifier' : 'Ajouter'} ${isIncome ? 'un revenu' : 'une charge fixe'}`, body, (fd, f) => {
    const name = fd.get('name').trim();
    const amount = parseAmount(fd.get('amount'));
    const day = Math.min(31, Math.max(1, parseInt(fd.get('day'), 10) || 1));
    if (!name) return invalid(f, 'name', 'Donne-lui un nom');
    if (!(amount > 0)) return invalid(f, 'amount', 'Entre un montant');
    const data = { name, amount, day, emoji: fd.get('emoji').trim() || (isIncome ? '💶' : '📅') };
    if (editing) Object.assign(item, data);
    else list.push({ id: uid(), ...data });
    state.onboarded = true;
    save(); render();
    toast(editing ? 'Modifié' : 'Ajouté');
  });
}

function catSheet(cat) {
  const editing = !!cat;
  const c = cat || { emoji: '🏷️', name: '', budget: 0 };
  const body = `
    <div class="field-row emoji">
      <div class="field"><label>Icône</label><input class="input emoji-input" name="emoji" value="${esc(c.emoji)}" maxlength="4"></div>
      <div class="field"><label>Nom</label><input class="input" name="name" value="${esc(c.name)}" placeholder="ex. Courses" maxlength="30" ${editing ? '' : 'autofocus'}></div>
    </div>
    <div class="field"><label>Budget mensuel</label><input class="input num" name="budget" inputmode="decimal" placeholder="0,00" value="${toInput(c.budget)}">
      <div class="hint">Laisse vide pour suivre sans limite.</div></div>
    <button class="btn" type="submit">${editing ? 'Enregistrer' : 'Ajouter'}</button>
    ${editing ? `<button class="btn danger" type="button" data-action="delete-cat" data-id="${c.id}">Supprimer l'enveloppe</button>` : ''}`;
  openSheet(editing ? "Modifier l'enveloppe" : 'Nouvelle enveloppe', body, (fd, f) => {
    const name = fd.get('name').trim();
    if (!name) return invalid(f, 'name', 'Donne-lui un nom');
    const raw = fd.get('budget').trim();
    const budget = raw ? parseAmount(raw) : 0;
    if (Number.isNaN(budget) || budget < 0) return invalid(f, 'budget', 'Montant invalide');
    const data = { name, budget, emoji: fd.get('emoji').trim() || '🏷️' };
    if (editing) Object.assign(cat, data);
    else state.categories.push({ id: uid(), ...data });
    save(); render();
  });
}

function goalSheet(goal, preset) {
  const editing = !!goal;
  const g = goal || Object.assign({ emoji: '🎯', name: '', target: 0, saved: 0, monthly: 0, kind: 'epargne' }, preset);
  const body = `
    ${editing ? `
      <div class="card" style="background:var(--surface-2);border:0;box-shadow:none">
        <div class="field" style="margin-bottom:10px"><label>Versement ou retrait</label>
          <input class="input num" name="deposit" inputmode="decimal" placeholder="ex. 20 ou -15"></div>
        <button class="btn" type="button" data-action="goal-deposit" data-id="${g.id}">Enregistrer le versement</button>
      </div>` : ''}
    <div class="field-row emoji">
      <div class="field"><label>Icône</label><input class="input emoji-input" name="emoji" value="${esc(g.emoji)}" maxlength="4"></div>
      <div class="field"><label>Nom</label><input class="input" name="name" value="${esc(g.name)}" placeholder="ex. Fonds d'urgence" maxlength="40" ${editing || preset ? '' : 'autofocus'}></div>
    </div>
    <div class="field"><label>Type</label>
      <select class="input" name="kind">
        <option value="epargne" ${g.kind !== 'invest' ? 'selected' : ''}>Épargne (livret, fonds d'urgence, projet)</option>
        <option value="invest" ${g.kind === 'invest' ? 'selected' : ''}>Placement (PEA, assurance-vie, crypto…)</option>
      </select></div>
    <div class="field-row">
      <div class="field"><label>Objectif (facultatif)</label><input class="input num" name="target" inputmode="decimal" value="${toInput(g.target)}" placeholder="aucun"></div>
      <div class="field"><label>Montant actuel</label><input class="input num" name="saved" inputmode="decimal" value="${toInput(g.saved)}" placeholder="0,00"></div>
    </div>
    <div class="field"><label>Mettre de côté chaque mois</label><input class="input num" name="monthly" inputmode="decimal" value="${toInput(g.monthly)}" placeholder="0,00" ${preset ? 'autofocus' : ''}>
      <div class="hint">Ce montant est retiré de ton reste à vivre pour être sûr de le garder.</div></div>
    <button class="btn ${editing ? 'secondary' : ''}" type="submit">${editing ? 'Enregistrer les modifications' : 'Créer l\'objectif'}</button>
    ${editing ? `<button class="btn danger" type="button" data-action="delete-goal" data-id="${g.id}">Supprimer l'objectif</button>` : ''}`;
  openSheet(editing ? `${esc(g.emoji)} ${esc(g.name)}` : 'Nouvel objectif', body, (fd, f) => {
    const name = fd.get('name').trim();
    if (!name) return invalid(f, 'name', 'Donne-lui un nom');
    const target = fd.get('target').trim() ? parseAmount(fd.get('target')) : 0;
    const saved = fd.get('saved').trim() ? parseAmount(fd.get('saved')) : 0;
    const monthly = fd.get('monthly').trim() ? parseAmount(fd.get('monthly')) : 0;
    if (Number.isNaN(target)) return invalid(f, 'target', 'Montant invalide');
    if (Number.isNaN(saved)) return invalid(f, 'saved', 'Montant invalide');
    if (Number.isNaN(monthly)) return invalid(f, 'monthly', 'Montant invalide');
    const data = { name, kind: fd.get('kind'), target: Math.max(0, target), saved: Math.max(0, saved), monthly: Math.max(0, monthly), emoji: fd.get('emoji').trim() || '🎯' };
    if (editing) Object.assign(goal, data);
    else state.goals.push({ id: uid(), ...data });
    save(); render();
  });
}

function confirmSheet(title, text, label, onYes) {
  openSheet(title, `<p class="help" style="margin-top:0">${text}</p>
    <button class="btn" type="submit" style="background:var(--crit-bar);color:#fff">${label}</button>
    <button class="btn secondary" type="button" data-action="close-sheet">Annuler</button>`, () => { onYes(); });
}

/* ---------------- Saisie automatique (Raccourcis iOS) ----------------
   Une automatisation « Transaction » de l'app Raccourcis ouvre :
   <adresse>#ajout?montant=12,50&marchand=Lidl
   La dépense est ajoutée et rangée dans l'enveloppe du commerçant. */

const MERCHANT_HINTS = [
  [/lidl|aldi|carrefour|leclerc|auchan|intermarch|monoprix|franprix|super ?u\b|hyper ?u\b|casino|picard|netto|biocoop|grand frais|g20|spar|proxi|naturalia/i, 'Courses'],
  [/total|esso|\bbp\b|shell|avia|sncf|ratp|\buber\b(?! ?eats)|bolt|heetch|blablacar|navigo|essence|carbu|station|parking|indigo|p[ée]age|vinci|tcl|tisseo|keolis|transdev|lime|dott/i, 'Transport'],
  [/mc ?do|mcdonald|burger|kfc|uber ?eats|deliveroo|just ?eat|starbucks|restau|resto|brasserie|\bbar\b|caf[ée]|pizza|sushi|kebab|boulang|paul\b|subway|o'?tacos|cin[ée]ma|path[ée]|ugc|gaumont/i, 'Restos & sorties'],
  [/pharma|doctolib|m[ée]decin|dentiste|optic|kin[ée]|laboratoire|h[ôo]pital/i, 'Santé'],
  [/amazon|zara|h ?& ?m|decathlon|fnac|darty|primark|vinted|shein|kiabi|uniqlo|sephora|nocib|celio|jules|zalando|boulanger|apple/i, 'Shopping'],
  [/ikea|leroy|castorama|\baction\b|bricomarch|bricorama|but\b|conforama|gifi|maisons du monde/i, 'Maison'],
];

function merchantKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
}

function guessCategory(merchant) {
  const key = merchantKey(merchant);
  if (key && state.rules[key] && state.categories.some((c) => c.id === state.rules[key])) return state.rules[key];
  // Règle apprise sur un nom proche (ex. « LIDL 1234 PARIS » ↔ « lidl »)
  const first = key.split(' ')[0];
  for (const [k, id] of Object.entries(state.rules)) {
    if (first && k.split(' ')[0] === first && state.categories.some((c) => c.id === id)) return id;
  }
  for (const [re, name] of MERCHANT_HINTS) {
    if (re.test(merchant)) {
      const cat = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (cat) return cat.id;
    }
  }
  return null;
}

function prettyMerchant(m) {
  const t = String(m || '').trim().replace(/\s+/g, ' ');
  if (t && t === t.toUpperCase()) return t.toLowerCase().replace(/(^|[\s'-])\S/g, (x) => x.toUpperCase());
  return t;
}

function handleIncomingLink() {
  const h = location.hash;
  if (!h.startsWith('#ajout')) return;
  const params = new URLSearchParams(h.slice(h.indexOf('?') + 1));
  history.replaceState(null, '', location.pathname + location.search);
  const amount = Math.abs(parseAmount(params.get('montant') || params.get('amount')));
  if (!(amount > 0)) { toast("⚠️ Montant reçu illisible, ajoute la dépense à la main"); return; }
  const merchant = prettyMerchant(params.get('marchand') || params.get('merchant') || '');
  const categoryId = guessCategory(merchant);
  const fallback = state.categories.find((c) => /autre/i.test(c.name)) || state.categories[state.categories.length - 1];
  const tx = {
    id: uid(), created: new Date().toISOString(), type: 'expense', amount,
    categoryId: categoryId || fallback?.id || null, note: merchant.slice(0, 60), date: todayISO(), auto: true,
  };
  if (!categoryId) tx.review = true;
  state.transactions.push(tx);
  save();
  ui.tab = 'home'; ui.offset = 0;
  render();
  if (tx.review) {
    txSheet(tx);
    toast(`⚡ ${eur(amount)} ${merchant ? 'chez ' + merchant : ''} · choisis l'enveloppe`, 3500);
  } else {
    feedbackAfterExpense(tx);
  }
}

window.addEventListener('hashchange', handleIncomingLink);

/* ---------------- Sauvegarde / export ---------------- */

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportJSON() {
  download(`budget-sauvegarde-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
}

function exportCSV() {
  const rows = [['Date', 'Type', 'Catégorie', 'Note', 'Montant']];
  for (const t of [...state.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date, t.type === 'income' ? 'Revenu' : 'Dépense', t.type === 'income' ? '' : catById(t.categoryId).name, t.note || '',
      ((t.type === 'income' ? 1 : -1) * t.amount / 100).toFixed(2).replace('.', ',')]);
  }
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  download(`budget-operations-${todayISO()}.csv`, csv, 'text/csv');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.categories) || !Array.isArray(data.transactions)) throw new Error('format');
      confirmSheet('Restaurer cette sauvegarde ?', `Elle contient ${data.transactions.length} opérations. Tes données actuelles seront remplacées.`, 'Restaurer', () => {
        state = Object.assign(freshState(), data);
        save(); render();
        toast('✓ Sauvegarde restaurée');
      });
    } catch (e) {
      toast("Ce fichier n'est pas une sauvegarde valide");
    }
  };
  reader.readAsText(file);
}

/* ---------------- Toast & tooltip ---------------- */

let toastTimer;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const $tip = document.getElementById('tooltip');
let tipTimer;
function showTip(el, x, y) {
  $tip.textContent = el.dataset.tip;
  $tip.hidden = false;
  const w = $tip.offsetWidth;
  const left = Math.min(window.innerWidth - w / 2 - 8, Math.max(w / 2 + 8, x));
  $tip.style.left = left + 'px';
  $tip.style.top = y + 'px';
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => { $tip.hidden = true; }, 2500);
}
$view.addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el && e.pointerType === 'mouse') showTip(el, e.clientX, e.clientY - 6);
});
$view.addEventListener('pointerout', (e) => {
  if (e.pointerType === 'mouse' && e.target.closest('[data-tip]')) $tip.hidden = true;
});

/* ---------------- Événements ---------------- */

function find(list, id) { return list.find((x) => x.id === id); }
function remove(list, id) { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); }

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    ui.tab = tabBtn.dataset.tab;
    render(); window.scrollTo(0, 0);
    return;
  }
  const tabLink = e.target.closest('[data-tab-link]');
  if (tabLink) { ui.tab = tabLink.dataset.tabLink; render(); window.scrollTo(0, 0); return; }

  const tipEl = e.target.closest('[data-tip]');
  if (tipEl) showTip(tipEl, e.clientX, e.clientY - 6);

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  const a = el.dataset.action;

  switch (a) {
    case 'prev-period': ui.offset--; render(); break;
    case 'next-period': ui.offset++; render(); break;
    case 'today-period': ui.offset = 0; render(); break;
    case 'add-tx': txSheet(); break;
    case 'edit-tx': txSheet(find(state.transactions, id)); break;
    case 'delete-tx':
      remove(state.transactions, id); save(); closeSheet(); render(); toast('Opération supprimée');
      break;
    case 'close-sheet': closeSheet(); break;
    case 'ops-filter': ui.opsFilter = el.dataset.f; render(); break;
    case 'review': ui.tab = 'ops'; ui.opsFilter = 'review'; render(); break;
    case 'budget-seg': ui.budgetSeg = el.dataset.seg; render(); break;
    case 'goto-budget': ui.tab = 'budget'; ui.budgetSeg = el.dataset.seg; render(); break;
    case 'dismiss-onboarding': state.onboarded = true; save(); render(); break;
    case 'add-cat': catSheet(); break;
    case 'edit-cat': catSheet(find(state.categories, id)); break;
    case 'delete-cat': {
      const used = state.transactions.some((t) => t.categoryId === id);
      const cat = find(state.categories, id);
      closeSheet();
      confirmSheet(`Supprimer ${esc(cat.name)} ?`, used ? 'Les opérations de cette enveloppe seront gardées mais passeront en « Sans catégorie ».' : 'Cette enveloppe sera supprimée.', 'Supprimer', () => {
        remove(state.categories, id); save(); render();
      });
      break;
    }
    case 'add-income': recurringSheet('income'); break;
    case 'edit-income': recurringSheet('income', find(state.incomes, id)); break;
    case 'delete-income': remove(state.incomes, id); save(); closeSheet(); render(); break;
    case 'add-fixed': recurringSheet('fixed'); break;
    case 'edit-fixed': recurringSheet('fixed', find(state.fixed, id)); break;
    case 'delete-fixed': remove(state.fixed, id); save(); closeSheet(); render(); break;
    case 'add-goal': goalSheet(); break;
    case 'quick-income': recurringSheet('income', null, { name: el.dataset.name, emoji: el.dataset.emoji }); break;
    case 'quick-fixed': recurringSheet('fixed', null, { name: el.dataset.name, emoji: el.dataset.emoji }); break;
    case 'quick-goal': goalSheet(null, { name: el.dataset.name, emoji: el.dataset.emoji, kind: /PEA/.test(el.dataset.name) ? 'invest' : 'epargne' }); break;
    case 'copy-url':
      navigator.clipboard.writeText(el.dataset.url).then(() => toast('✓ Lien copié'), () => toast('Copie impossible, sélectionne le texte'));
      break;
    case 'edit-goal': goalSheet(find(state.goals, id)); break;
    case 'delete-goal': remove(state.goals, id); save(); closeSheet(); render(); break;
    case 'goal-deposit': {
      const g = find(state.goals, id);
      const amt = parseAmount(document.querySelector('[name="deposit"]').value);
      if (Number.isNaN(amt) || amt === 0) { toast('Entre un montant'); break; }
      g.saved = Math.max(0, g.saved + amt);
      save(); closeSheet(); render();
      toast(g.target > 0 && g.saved >= g.target ? `🎉 Objectif ${g.name} atteint !` : `${amt > 0 ? '+' : ''}${eur(amt)} · ${eur(g.saved)} épargnés`);
      break;
    }
    case 'export-json': exportJSON(); break;
    case 'export-csv': exportCSV(); break;
    case 'import-json': document.getElementById('importFile').click(); break;
    case 'reset':
      confirmSheet('Tout effacer ?', 'Toutes tes opérations, enveloppes, revenus et objectifs seront supprimés de ce téléphone. Pense à faire une sauvegarde avant.', 'Tout effacer', () => {
        state = freshState(); save(); ui.offset = 0; ui.tab = 'home'; render();
      });
      break;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'importFile' && e.target.files[0]) { importJSON(e.target.files[0]); e.target.value = ''; return; }
  const key = e.target.dataset.setting;
  if (key) {
    state.settings[key] = key === 'startDay' ? parseInt(e.target.value, 10) : e.target.value;
    save(); render();
  }
});

$backdrop.addEventListener('click', closeSheet);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $sheet.hidden) render(); });

render();
handleIncomingLink();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
