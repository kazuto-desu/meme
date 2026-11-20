'use strict';

/* =====================================================================
 * 中央競馬 予想ノート
 *  - 出走馬データ → 能力指数 → 推定勝率（オッズと合成）→ 印・買い目
 *  - 着順確率は Harville モデル（2・3着は Benter 補正）で算出
 *  - データは localStorage に保存
 * ===================================================================== */

const STORAGE_KEY = 'keiba-yosou-v1';

const VENUES = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];
const MARK_ORDER = ['◎', '○', '▲', '△', '☆'];

const WEIGHT_DEFS = [
  { key: 'form',     label: '近走成績',     def: 20 },
  { key: 'rating',   label: 'レイティング(RT)', def: 12, note: '競馬ブックの RT。出走馬の中での相対評価' },
  { key: 'speed',    label: 'スピード指数', def: 12, note: '直近3走の上位2つの平均。出走馬の中での相対評価' },
  { key: 'agari',    label: '上がり(末脚)', def: 10 },
  { key: 'jockey',   label: '騎手',         def: 12 },
  { key: 'dist',     label: '距離適性',     def: 12 },
  { key: 'course',   label: 'コース適性',   def: 8 },
  { key: 'mud',      label: '道悪適性',     def: 6, note: '稍重以上で効きが強まります' },
  { key: 'train',    label: '調教',         def: 8 },
  { key: 'camp',     label: '厩舎コメント', def: 8 },
  { key: 'frame',    label: '枠順バイアス', def: 5 },
  { key: 'kg',       label: '斤量',         def: 4 },
  { key: 'bw',       label: '馬体重増減',   def: 4 },
  { key: 'interval', label: 'ローテ間隔',   def: 4 },
  { key: 'market',   label: 'オッズ重視度', def: 40, max: 100, unit: '%', note: '推定勝率に市場（単勝オッズ）の評価をどれだけ混ぜるか' },
  { key: 'sharp',    label: '指数のメリハリ', def: 9, min: 3, max: 18, note: '大きいほど指数上位に勝率が集中します' },
];

const DEFAULT_WEIGHTS = Object.fromEntries(WEIGHT_DEFS.map(w => [w.key, w.def]));

/* ---------------- 保存 ---------------- */

let db = load();

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    return { races: d.races || [], weights: { ...DEFAULT_WEIGHTS, ...(d.weights || {}) }, seeded: !!d.seeded };
  } catch {
    return { races: [], weights: { ...DEFAULT_WEIGHTS } };
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* 容量超過などは無視 */ }
  }, 200);
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---------------- ユーティリティ ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = v => {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (p, d = 1) => (p * 100).toFixed(d) + '%';
const yen = n => Math.round(n).toLocaleString('ja-JP') + '円';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------------- データモデル ---------------- */

function newHorse(n) {
  return {
    id: uid(), num: n, name: '', jockey: '', kg: null, odds: null,
    form: '', agari: null, jrank: 3, dist: 3, course: 3, mud: 3,
    train: 'B', bw: null, weeks: null, scratched: false,
    rt: null, si: null, cpu: '', style: '', sexAge: '', stable: '', record: '', sire: '',
    camp: 3, mark: '', comment: '', campHits: '', trainNote: '', trainHits: '', past: [], place: '', pop: null,
  };
}

function newRace() {
  return {
    id: uid(), date: today(), venue: '東京', rnum: 11, name: '',
    surface: 'turf', dist: 1600, going: '良', grade: 'G1', bias: 'auto',
    horses: Array.from({ length: 8 }, (_, i) => newHorse(i + 1)),
    result: null, honmei: null, updated: Date.now(),
  };
}

/** JRA の枠番割り当て（頭数 > 8 のときは外枠から 2 頭ずつ） */
function wakuOf(n, field) {
  if (field <= 8) return n;
  const base = Math.floor(field / 8);
  const extra = field % 8;
  const smallWaku = 8 - extra; // base 頭の枠の数
  if (n <= smallWaku * base) return Math.ceil(n / base);
  return smallWaku + Math.ceil((n - smallWaku * base) / (base + 1));
}

/** コース形態からの枠バイアス推定（一般的な傾向のざっくりした目安） */
function autoBias(race) {
  const { venue, surface, dist } = race;
  if (surface === 'turf') {
    if (venue === '新潟' && dist <= 1000) return ['outer', '新潟芝1000mの直線競馬は外枠有利'];
    if (['札幌', '函館', '福島', '小倉'].includes(venue)) return ['inner', '小回りコースは内枠・先行有利の傾向'];
    if (venue === '中山' && dist <= 2000) return ['inner', '中山芝の小回りは内枠有利の傾向'];
    if (['京都', '阪神'].includes(venue) && dist <= 1400) return ['inner', '短距離の内回りは内枠有利の傾向'];
    return ['flat', '大箱・外回りコースは枠の有利不利が小さめ'];
  }
  if (venue === '東京' && dist === 1600) return ['outer', '東京ダ1600mは芝スタートで外枠有利の傾向'];
  if (dist <= 1400) return ['outer', 'ダート短距離は砂を被りにくい外枠有利の傾向'];
  return ['flat', 'ダート中距離は枠の影響が小さめ'];
}

function effectiveBias(race) {
  return race.bias === 'auto' ? autoBias(race)[0] : race.bias;
}

/* ---------------- 予想ロジック ---------------- */

function finishValue(tok) {
  if (/中|除|取|失|止/.test(tok)) return 0.05;
  const f = parseInt(tok, 10);
  if (!Number.isFinite(f) || f < 1) return null;
  if (f === 1) return 1;
  if (f === 2) return 0.82;
  if (f === 3) return 0.7;
  if (f === 4) return 0.56;
  if (f === 5) return 0.48;
  if (f <= 9) return 0.3;
  return 0.15;
}

function formValue(form) {
  const toks = String(form || '').split(/[-ー－\/,、\s]+/).filter(Boolean).slice(0, 5);
  const rec = [0.35, 0.27, 0.2, 0.12, 0.06];
  let s = 0, w = 0;
  toks.forEach((t, i) => {
    const v = finishValue(t);
    if (v !== null) { s += v * rec[i]; w += rec[i]; }
  });
  return w ? s / w : 0.4; // 初出走などデータなしはやや低め
}

function agariValue(r) {
  if (r === null) return 0.5;
  if (r <= 1) return 1;
  if (r === 2) return 0.85;
  if (r === 3) return 0.72;
  if (r <= 5) return 0.55;
  if (r <= 9) return 0.35;
  return 0.2;
}

const five = v => (v === null || v === undefined || v === '') ? 0.5 : clamp((Number(v) - 1) / 4, 0, 1);
const trainValue = t => ({ A: 1, B: 0.67, C: 0.33, D: 0 }[t] ?? 0.67);

function bwValue(d) {
  if (d === null) return 0.7;
  const a = Math.abs(d);
  if (a <= 6) return 1;
  if (a >= 20) return 0.2;
  return 1 - (a - 6) / 14 * 0.8;
}

function intervalValue(w) {
  if (w === null) return 0.7;
  if (w <= 1) return 0.55;
  if (w <= 2) return 0.75;
  if (w <= 10) return 1;
  if (w <= 16) return 0.6;
  if (w <= 26) return 0.45;
  return 0.35;
}

const GOING_MUD = { '良': 0.3, '稍重': 1, '重': 1.6, '不良': 2.2 };

/**
 * レースを予想する。
 * @returns {{rows: Array, active: Array, marketUsed: boolean, harville: object}}
 */
function predict(race, W) {
  const field = race.horses.length;
  const active = race.horses.filter(h => !h.scratched && h.num);
  if (active.length < 2) return { rows: [], active, marketUsed: false };

  const bias = effectiveBias(race);
  const kgs = active.map(h => num(h.kg)).filter(v => v !== null);
  const kgMean = kgs.length ? kgs.reduce((a, b) => a + b, 0) / kgs.length : null;
  const mudW = W.mud * (GOING_MUD[race.going] ?? 1);

  // 出走馬内の相対値（最小0〜最大1、データなしは 0.4）
  const rel = key => {
    const vals = active.map(h => num(h[key])).filter(v => v !== null);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return h => {
      const v = num(h[key]);
      if (v === null || vals.length < 2) return vals.length < 2 ? 0.5 : 0.4;
      return hi > lo ? (v - lo) / (hi - lo) : 0.5;
    };
  };
  const relRt = rel('rt'), relSi = rel('si');

  const factorWeights = {
    rating: W.rating ?? 0, speed: W.speed ?? 0,
    form: W.form, agari: W.agari, jockey: W.jockey, dist: W.dist, course: W.course,
    mud: mudW, train: W.train, frame: W.frame, kg: W.kg, bw: W.bw, interval: W.interval, camp: W.camp ?? 0,
  };
  const wSum = Object.values(factorWeights).reduce((a, b) => a + b, 0) || 1;

  const rows = active.map(h => {
    const pos = field > 1 ? (h.num - 1) / (field - 1) : 0.5;
    const kg = num(h.kg);
    const v = {
      form: formValue(h.form),
      agari: agariValue(num(h.agari)),
      jockey: five(h.jrank),
      dist: five(h.dist),
      course: five(h.course),
      mud: five(h.mud),
      train: trainValue(h.train),
      frame: bias === 'inner' ? 1 - pos : bias === 'outer' ? pos : 0.5,
      kg: kg === null || kgMean === null ? 0.5 : clamp(0.5 - (kg - kgMean) * 0.12, 0, 1),
      bw: bwValue(num(h.bw)),
      interval: intervalValue(num(h.weeks)),
      camp: five(h.camp ?? 3),
      rating: relRt(h),
      speed: relSi(h),
    };
    let s = 0;
    for (const k in factorWeights) s += factorWeights[k] * v[k];
    return { h, v, score: s / wSum };
  });

  // 能力指数 → モデル勝率（ソフトマックス）
  const maxS = Math.max(...rows.map(r => r.score));
  const ex = rows.map(r => Math.exp(W.sharp * (r.score - maxS)));
  const exSum = ex.reduce((a, b) => a + b, 0);
  rows.forEach((r, i) => { r.pModel = ex[i] / exSum; });

  // 市場確率（単勝オッズの逆数を正規化＝控除率を除去）
  const marketUsed = rows.every(r => num(r.h.odds) > 1) && W.market > 0;
  if (marketUsed) {
    const inv = rows.map(r => 1 / num(r.h.odds));
    const invSum = inv.reduce((a, b) => a + b, 0);
    rows.forEach((r, i) => { r.pMarket = inv[i] / invSum; });
  }
  const a = marketUsed ? W.market / 100 : 0;
  rows.forEach(r => { r.p = (1 - a) * r.pModel + a * (r.pMarket ?? 0); });

  // 指数を偏差値風（平均50）に
  const mean = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((s, r) => s + (r.score - mean) ** 2, 0) / rows.length) || 1;
  rows.forEach(r => { r.index = 50 + 10 * (r.score - mean) / sd; });

  const harville = buildHarville(rows.map(r => r.p));
  rows.forEach((r, i) => {
    r.pPlace = harville.place[i];
    const o = num(r.h.odds);
    r.ev = o ? r.p * o : null;
  });

  // 印
  const order = [...rows].sort((x, y) => y.p - x.p);
  // 手動で付けた印（h.mark）を優先し、残りの印を勝率順に割り当てる
  const taken = new Set(order.map(r => r.h.mark).filter(Boolean));
  const pool = ['◎', '○', '▲'].filter(m => !taken.has(m));
  let triangles = 2;
  order.forEach((r, i) => {
    r.rank = i + 1;
    r.manual = !!r.h.mark;
    if (r.manual) { r.mark = r.h.mark; return; }
    r.autoMark = pool.length ? pool.shift() : triangles-- > 0 ? '△' : '';
    r.mark = r.autoMark;
  });
  const ana = taken.has('☆') ? null : order
    .filter(r => !r.manual && r.rank >= 4 && r.ev !== null && r.ev >= 1.0 && num(r.h.odds) >= 10)
    .sort((x, y) => y.ev - x.ev)[0];
  if (ana) ana.mark = '☆';

  return { rows: order, active, marketUsed, harville, idx: rows };
}

/**
 * Harville モデルで着順確率を計算する。
 * 2着・3着は Benter (1994) の補正（p^0.81, p^0.65）で人気薄の過小評価を緩和。
 */
function buildHarville(p) {
  const n = p.length;
  const norm = arr => { const s = arr.reduce((a, b) => a + b, 0); return arr.map(x => x / s); };
  const p2 = norm(p.map(x => Math.pow(x, 0.81)));
  const p3 = norm(p.map(x => Math.pow(x, 0.65)));

  const exacta = Array.from({ length: n }, () => new Float64Array(n));
  const tri = new Map(); // "i,j,k" 順序付き
  const place = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pij = p[i] * p2[j] / (1 - p2[i]);
      exacta[i][j] = pij;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const pijk = pij * p3[k] / (1 - p3[i] - p3[j]);
        tri.set(i * 400 + j * 20 + k, pijk);
        place[i] += pijk; place[j] += pijk; place[k] += pijk;
      }
    }
  }
  return { p, exacta, tri, place, n };
}

const triKey = (i, j, k) => i * 400 + j * 20 + k;

function comboProb(H, type, idx) {
  const [i, j, k] = idx;
  switch (type) {
    case 'tansho': return H.p[i];
    case 'fukusho': return H.place[i];
    case 'umatan': return H.exacta[i][j];
    case 'umaren': return H.exacta[i][j] + H.exacta[j][i];
    case 'wide': {
      let s = 0;
      for (let x = 0; x < H.n; x++) {
        if (x === i || x === j) continue;
        for (const [a, b, c] of [[i, j, x], [j, i, x], [i, x, j], [j, x, i], [x, i, j], [x, j, i]]) s += H.tri.get(triKey(a, b, c)) || 0;
      }
      return s;
    }
    case 'sanrentan': return H.tri.get(triKey(i, j, k)) || 0;
    case 'sanrenpuku': {
      let s = 0;
      for (const [a, b, c] of [[i, j, k], [i, k, j], [j, i, k], [j, k, i], [k, i, j], [k, j, i]]) s += H.tri.get(triKey(a, b, c)) || 0;
      return s;
    }
  }
  return 0;
}

function topCombos(pred, type, limit = 15) {
  const { idx: rows, harville: H } = pred;
  const n = rows.length;
  const out = [];
  const push = (ids) => out.push({ ids, nums: ids.map(i => rows[i].h.num), p: comboProb(H, type, ids) });
  if (type === 'umaren' || type === 'wide') {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) push([i, j]);
  } else if (type === 'umatan') {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) push([i, j]);
  } else if (type === 'sanrenpuku') {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) push([i, j, k]);
  } else if (type === 'sanrentan') {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) if (i !== j && j !== k && i !== k) push([i, j, k]);
  }
  out.forEach(c => { if (type === 'umaren' || type === 'wide' || type === 'sanrenpuku') c.nums.sort((a, b) => a - b); });
  return out.sort((a, b) => b.p - a.p).slice(0, limit);
}

/** 予算を的中率比例で 100 円単位に配分（最低 100 円／点） */
function allocate(tickets, amount) {
  let units = Math.floor(amount / 100);
  if (units <= 0 || !tickets.length) return [];
  let list = [...tickets].sort((a, b) => b.p - a.p);
  if (units < list.length) list = list.slice(0, units);
  const pSum = list.reduce((s, t) => s + t.p, 0) || 1;
  const rest = units - list.length;
  const raw = list.map(t => rest * t.p / pSum);
  const base = raw.map(Math.floor);
  let left = rest - base.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => base[i]++);
  return list.map((t, i) => ({ ...t, yen: (base[i] + 1) * 100 }));
}

function recommend(pred, budget) {
  const rows = pred.idx;
  const pos = r => rows.indexOf(r);
  const hon = pred.rows.find(r => r.mark === '◎') || pred.rows.find(r => r.mark !== '消');
  if (!hon) return [];
  const byMark = m => pred.rows.filter(r => r.mark === m && r !== hon);
  const taiko = [...byMark('○'), ...byMark('▲')];
  const himo = [...taiko, ...byMark('△'), ...byMark('☆')];

  const bundles = [];
  const H = pred.harville;

  // 1. 単勝 or 複勝
  const tanOk = hon.ev !== null && hon.ev >= 1;
  bundles.push({
    title: tanOk ? `単勝 ◎${hon.h.num}` : `複勝 ◎${hon.h.num}`,
    desc: tanOk ? '本命の単勝期待値が 1.0 以上。素直に単勝で。' : '本命の単勝に妙味が薄いため複勝で手堅く。',
    share: 0.1,
    tickets: [{ label: tanOk ? '単勝' : '複勝', nums: [hon.h.num], p: tanOk ? hon.p : hon.pPlace }],
  });

  // 2. 馬連 ◎ 流し
  if (himo.length) {
    bundles.push({
      title: `馬連 ◎${hon.h.num} 流し`,
      desc: `相手：${himo.map(r => r.mark + r.h.num).join(' ')}`,
      share: 0.3,
      tickets: himo.map(r => ({ label: '馬連', nums: [hon.h.num, r.h.num].sort((a, b) => a - b), p: comboProb(H, 'umaren', [pos(hon), pos(r)]) })),
    });
  }

  // 3. 3連複 ◎ 1頭軸流し
  if (himo.length >= 2) {
    const t = [];
    for (let a = 0; a < himo.length; a++) for (let b = a + 1; b < himo.length; b++) {
      t.push({ label: '3連複', nums: [hon.h.num, himo[a].h.num, himo[b].h.num].sort((x, y) => x - y), p: comboProb(H, 'sanrenpuku', [pos(hon), pos(himo[a]), pos(himo[b])]) });
    }
    bundles.push({ title: `3連複 ◎${hon.h.num} 1頭軸流し`, desc: `相手：${himo.map(r => r.mark + r.h.num).join(' ')}`, share: 0.4, tickets: t });
  }

  // 4. 3連単 ◎1着固定 → ○▲ → 印
  if (taiko.length && himo.length >= 2) {
    const t = [];
    for (const s of taiko) for (const th of himo) {
      if (th === s) continue;
      t.push({ label: '3連単', nums: [hon.h.num, s.h.num, th.h.num], ordered: true, p: comboProb(H, 'sanrentan', [pos(hon), pos(s), pos(th)]) });
    }
    bundles.push({ title: `3連単 フォーメーション`, desc: `1着 ◎${hon.h.num} → 2着 ${taiko.map(r => r.mark + r.h.num).join(' ')} → 3着 ${himo.map(r => r.mark + r.h.num).join(' ')}`, share: 0.2, tickets: t });
  }

  const totalShare = bundles.reduce((s, b) => s + b.share, 0);
  bundles.forEach(b => {
    b.alloc = allocate(b.tickets, Math.floor(budget * b.share / totalShare / 100) * 100);
    b.amount = b.alloc.reduce((s, t) => s + t.yen, 0);
    b.hit = b.alloc.reduce((s, t) => s + t.p, 0);
  });
  return bundles;
}

/* ---------------- 画面遷移 ---------------- */

let current = null; // 表示中のレース

let view = { name: 'list', id: null };

function route() {
  const m = view.name === 'list' ? null : [null, view.name, view.id];
  const race = m && db.races.find(r => r.id === m[2]);
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#nav-back').classList.toggle('hidden', !race);
  if (!race) {
    current = null;
    $('#appbar-title').textContent = '🏇 中央競馬 予想ノート';
    $('#list').classList.add('active');
    renderList();
  } else if (m[1] === 'edit') {
    current = race;
    $('#appbar-title').textContent = 'レース編集';
    $('#edit').classList.add('active');
    renderEdit();
  } else {
    current = race;
    $('#appbar-title').textContent = raceTitle(race);
    $('#predict').classList.add('active');
    renderPredict();
  }
  window.scrollTo(0, 0);
}

/** 画面切り替え：go('list') / go('edit', id) / go('race', id) */
const go = (name, id = null) => { view = { name, id }; route(); };

/* ---------------- 確認ダイアログ・通知（alert/confirm の代わり） ---------------- */

function ask(message, okLabel = 'OK') {
  const dlg = $('#ask-dialog');
  $('#ask-msg').textContent = message;
  $('#ask-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function raceTitle(r) {
  return `${r.venue}${r.rnum ? r.rnum + 'R' : ''} ${r.name || '(レース名未設定)'}`;
}
function raceMeta(r) {
  const active = r.horses.filter(h => !h.scratched).length;
  return `${r.date || ''}　${r.surface === 'turf' ? '芝' : 'ダ'}${r.dist}m　${r.going}　${r.grade}　${active}頭`;
}

/* ---------------- 一覧 ---------------- */

function renderList() {
  const races = [...db.races].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updated - a.updated);
  const ul = $('#race-list');
  ul.innerHTML = races.map(r => {
    let right = '<span class="muted">結果未入力</span>';
    if (r.result?.order?.[0]) {
      const bet = r.result.bet || 0, pay = r.result.pay || 0;
      const hon = r.honmei;
      const hit = hon && r.result.order.slice(0, 3).includes(hon);
      right = `${hon ? (r.result.order[0] === hon ? '◎1着' : hit ? '◎複勝圏' : '◎着外') : ''}`
        + (bet ? `<br><span class="${pay >= bet ? 'plus' : 'minus'}">${pay - bet >= 0 ? '+' : ''}${(pay - bet).toLocaleString()}円</span>` : '');
    }
    return `<li><button data-id="${r.id}">
      <span class="t">${esc(raceTitle(r))}</span>
      <span class="r">${right}</span>
      <span class="s">${esc(raceMeta(r))}</span>
    </button></li>`;
  }).join('');
  $('#race-empty').classList.toggle('hidden', races.length > 0);
  renderStats();
}

function renderStats() {
  const done = db.races.filter(r => r.result?.order?.[0]);
  const withHon = done.filter(r => r.honmei);
  const win = withHon.filter(r => r.result.order[0] === r.honmei).length;
  const place = withHon.filter(r => r.result.order.slice(0, 3).includes(r.honmei)).length;
  const bet = done.reduce((s, r) => s + (r.result.bet || 0), 0);
  const pay = done.reduce((s, r) => s + (r.result.pay || 0), 0);
  const roi = bet ? pay / bet : null;
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  $('#stats').innerHTML = [
    stat('記録レース', `${done.length}<small class="muted"> / ${db.races.length}</small>`),
    stat('◎ 勝率', withHon.length ? pct(win / withHon.length, 0) : '—'),
    stat('◎ 複勝率', withHon.length ? pct(place / withHon.length, 0) : '—'),
    stat('回収率', roi === null ? '—' : pct(roi, 0), roi === null ? '' : roi >= 1 ? 'plus' : 'minus'),
    stat('収支', bet ? `${pay - bet >= 0 ? '+' : ''}${(pay - bet).toLocaleString()}円` : '—', bet ? (pay >= bet ? 'plus' : 'minus') : ''),
  ].join('');
}

/* ---------------- 編集 ---------------- */

function renderEdit() {
  const r = current;
  $('#r-date').value = r.date || '';
  $('#r-venue').value = r.venue;
  $('#r-num').value = r.rnum ?? '';
  $('#r-name').value = r.name || '';
  $('#r-surface').value = r.surface;
  $('#r-dist').value = r.dist ?? '';
  $('#r-going').value = r.going;
  $('#r-grade').value = r.grade;
  $('#r-bias').value = r.bias;
  updateBiasNote();
  renderHorseRows();
}

function updateBiasNote() {
  const [b, why] = autoBias(current);
  const label = { inner: '内枠有利', outer: '外枠有利', flat: 'フラット' }[b];
  $('#bias-note').textContent = current.bias === 'auto' ? `推定：${label}（${why}）` : '';
}

function wakuBadge(n, field) {
  const w = wakuOf(n, field);
  return `<span class="waku" style="background:var(--w${w});color:var(--w${w}i)" title="${w}枠">${n}</span>`;
}

function renderHorseRows() {
  const r = current;
  const field = r.horses.length;
  $('#horse-count').textContent = `${r.horses.filter(h => !h.scratched).length}頭 / 登録${field}頭`;
  const opt = (vals, sel) => vals.map(v => `<option${String(v) === String(sel) ? ' selected' : ''}>${v}</option>`).join('');
  $('#horse-table tbody').innerHTML = r.horses.map(h => `
    <tr data-id="${h.id}" class="${h.scratched ? 'scratched' : ''}">
      <td>${wakuBadge(h.num, field)}</td>
      <td><input class="w-name" data-f="name" value="${esc(h.name)}" placeholder="馬名"></td>
      <td><input class="w-jockey" data-f="jockey" value="${esc(h.jockey)}" placeholder="騎手"></td>
      <td><input class="w-sm" data-f="kg" type="number" step="0.5" inputmode="decimal" value="${h.kg ?? ''}"></td>
      <td><input class="w-sm" data-f="odds" type="number" step="0.1" min="1" inputmode="decimal" value="${h.odds ?? ''}"></td>
      <td><input class="w-form" data-f="form" value="${esc(h.form)}" placeholder="1-3-5"></td>
      <td><input class="w-sm" data-f="rt" type="number" step="0.1" inputmode="decimal" value="${h.rt ?? ''}"></td>
      <td><input class="w-xs" data-f="si" type="number" inputmode="numeric" value="${h.si ?? ''}"></td>
      <td><input class="w-xs" data-f="agari" type="number" min="1" max="18" inputmode="numeric" value="${h.agari ?? ''}"></td>
      <td><select data-f="jrank">${opt([1, 2, 3, 4, 5], h.jrank)}</select></td>
      <td><select data-f="dist">${opt([1, 2, 3, 4, 5], h.dist)}</select></td>
      <td><select data-f="course">${opt([1, 2, 3, 4, 5], h.course)}</select></td>
      <td><select data-f="mud">${opt([1, 2, 3, 4, 5], h.mud)}</select></td>
      <td><select data-f="train">${opt(['A', 'B', 'C', 'D'], h.train)}</select></td>
      <td><select data-f="camp">${opt([1, 2, 3, 4, 5], h.camp ?? 3)}</select></td>
      <td><input class="w-xs" data-f="bw" type="number" step="2" inputmode="numeric" value="${h.bw ?? ''}" placeholder="±"></td>
      <td><input class="w-xs" data-f="weeks" type="number" min="0" inputmode="numeric" value="${h.weeks ?? ''}"></td>
      <td><input data-f="scratched" type="checkbox"${h.scratched ? ' checked' : ''} aria-label="出走取消"></td>
      <td><button class="del" data-del="${h.id}" aria-label="削除">×</button></td>
    </tr>`).join('');
}

const NUM_FIELDS = new Set(['kg', 'odds', 'agari', 'bw', 'weeks', 'jrank', 'dist', 'course', 'mud', 'camp', 'rt', 'si']);

function touch() { current.updated = Date.now(); save(); }

function renumber() { current.horses.forEach((h, i) => { h.num = i + 1; }); }

/* ---------------- 予想画面 ---------------- */

let betType = 'umaren';

function renderPredict() {
  const r = current;
  $('#race-head').innerHTML = `<p class="title">${esc(raceTitle(r))}</p><p class="meta">${esc(raceMeta(r))}　枠：${{ inner: '内有利', outer: '外有利', flat: 'フラット' }[effectiveBias(r)]}</p>`;
  renderWeights();
  renderResultForm();
  refreshPrediction();
}

let lastPred = null;

function refreshPrediction() {
  const r = current;
  const pred = predict(r, db.weights);
  lastPred = pred;
  const tbody = $('#pred-table tbody');
  if (!pred.rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">出走馬が2頭以上必要です。</td></tr>';
    $('#reco').innerHTML = '';
    $('#combo-list').innerHTML = '';
    return;
  }
  // データの欠け（一部の馬だけ過去走がないと、その馬が不当に低く／高く評価される）
  const noPast = pred.rows.filter(x => !x.h.form && x.h.rt == null && x.h.si == null);
  const noOdds = pred.rows.filter(x => num(x.h.odds) == null);
  const warns = [];
  if (noPast.length && noPast.length < pred.rows.length) warns.push(`過去走データがない馬が${noPast.length}頭います（${noPast.map(x => x.h.num).sort((a, b) => a - b).join("・")}番）。出馬表を全頭分取り込むと正確になります。`);
  if (noOdds.length) warns.push(`単勝オッズがない馬が${noOdds.length}頭います。オッズ合成と期待値は全頭そろうと有効になります。`);
  if (pred.rows.some(x => x.h.oddsKind === '予測')) warns.push('オッズは予測オッズです。発売後に実際のオッズを取り込み直してください。');
  $('#pred-warn').innerHTML = warns.map(esc).join('<br>');
  $('#pred-warn').hidden = !warns.length;

  const field = r.horses.length;
  const maxP = Math.max(...pred.rows.map(x => x.p));
  const markOpts = (x) => ['', '◎', '○', '▲', '△', '☆', '消'].map(m =>
    `<option value="${m}"${(x.manual ? x.h.mark : '') === m ? ' selected' : ''}>${m === '' ? (x.manual ? '自動' : (x.mark || '・')) : m}</option>`).join('');
  tbody.innerHTML = pred.rows.map(x => `
    <tr class="${x.mark === '消' ? 'erased' : ''}">
      <td class="mark"><select class="mark-sel${x.manual ? ' manual' : ''}" data-mark="${x.h.id}" aria-label="${x.h.num}番の印">${markOpts(x)}</select></td>
      <td>${wakuBadge(x.h.num, field)}</td>
      <td class="name"><button class="name-btn" data-detail="${x.h.id}" aria-expanded="${openDetails.has(x.h.id)}">${esc(x.h.name || '(未入力)')}${hasInfo(x.h) ? ' <span class="info-dot" title="取り込んだ情報あり">●</span>' : ''}</button><span class="muted small">${esc(x.h.jockey || '')}</span></td>
      <td class="num">${x.index.toFixed(1)}</td>
      <td class="num"><span class="bar"><i style="width:${(x.p / maxP * 100).toFixed(0)}%"></i></span>${pct(x.p)}</td>
      <td class="num">${pct(x.pPlace, 0)}</td>
      <td class="num col-odds">${num(x.h.odds) ? num(x.h.odds).toFixed(1) + (x.h.oddsApprox ? '+' : '') : '—'}</td>
      <td class="num ${x.ev === null ? '' : x.ev >= 1 ? 'ev-plus' : 'ev-minus'}">${x.ev === null ? '—' : x.ev.toFixed(2)}</td>
    </tr>
    <tr class="detail"${openDetails.has(x.h.id) ? '' : ' hidden'} data-detail-row="${x.h.id}"><td colspan="8">${detailHtml(x)}</td></tr>`).join('');

  // 本命を記録（成績集計用）
  const hon = pred.rows.find(x => x.mark === '◎');
  if (hon && r.honmei !== hon.h.num && !r.result?.order?.[0]) { r.honmei = hon.h.num; save(); }

  renderReco();
  renderCombos();
}

const openDetails = new Set();

function hasInfo(h) {
  return !!(h.comment || h.trainNote || h.trainHits || (h.past && h.past.length));
}

function detailHtml(x) {
  const h = x.h;
  const goingShort = g => ({ '稍重': '稍', '不良': '不' }[g] || g || '');
  const past = (h.past || []).slice(0, 5).map(p => `
    <li><span class="muted">${esc(p.date || '')}</span> ${esc(p.venue || '')} ${esc(p.race || '')}${p.grade ? `(${esc(p.grade)})` : ''} ${p.surface === 'turf' ? '芝' : p.surface === 'dirt' ? 'ダ' : ''}${p.dist || ''} ${goingShort(p.going)}
      <b>${p.finish === undefined ? '—' : p.finish === '中' ? '中止' : p.finish + '着'}</b>${p.field ? `/${p.field}頭` : ''}${p.pop ? ` ${p.pop}人` : ''}
      ${p.margin !== undefined ? `<span class="muted">${p.finish === 1 ? '+' : ''}${p.margin}秒</span>` : ''}
      ${p.agari ? `上り${p.agari}${p.agariRank ? `(${p.agariRank}位)` : ''}` : ''}${p.pos4 ? ` 4角${esc(p.pos4)}` : ''}${p.si ? ` <b>S${p.si}</b>` : ''}${p.weight ? ` ${p.weight}kg` : ''}${p.jockey ? ` <span class="muted">${esc(p.jockey)} ${p.kg ?? ''}</span>` : ''}</li>`).join('');
  const prof = [h.sexAge, h.sire ? `父${h.sire}` : '', h.stable, h.record ? `通算${h.record}` : '', h.style ? `脚質:${h.style}` : '', h.rt ? `RT${h.rt}` : '', h.cpu ? `CPU${h.cpu}` : '']
    .filter(Boolean).map(esc).join('　');
  const f = x.v || {};
  const factor = (label, v) => `<span class="chip">${label} <b>${Math.round((v ?? 0.5) * 100)}</b></span>`;
  return `<div class="detail-body">
    ${prof ? `<p class="small">${prof}</p>` : ''}
    <div class="chips">${factor('RT', f.rating)}${factor('S指数', f.speed)}${factor('近走', f.form)}${factor('末脚', f.agari)}${factor('騎手', f.jockey)}${factor('距離', f.dist)}${factor('コース', f.course)}${factor('道悪', f.mud)}${factor('調教', f.train)}${factor('陣営', f.camp)}${factor('枠', f.frame)}${factor('ローテ', f.interval)}</div>
    ${past ? `<div><h4>過去走</h4><ul class="past">${past}</ul></div>` : ''}
    <div><h4>調教 <span class="grade">${esc(h.train || 'B')}</span></h4>
      ${h.trainNote ? `<p>${esc(h.trainNote)}</p>` : ''}${h.trainHits ? `<p class="muted small">根拠：${esc(h.trainHits)}</p>` : ''}${!h.trainNote && !h.trainHits ? '<p class="muted small">未取り込み</p>' : ''}</div>
    <div><h4>厩舎コメント <span class="grade">${h.camp ?? 3}</span></h4>
      ${h.comment ? `<p>${esc(h.comment)}</p>` : '<p class="muted small">未取り込み</p>'}${h.campHits ? `<p class="muted small">根拠：${esc(h.campHits)}</p>` : ''}</div>
    ${h.place || h.pop ? `<p class="small">複勝 ${esc(h.place || '—')}　${h.pop ? h.pop + '番人気' : ''}</p>` : ''}
  </div>`;
}

function renderReco() {
  if (!lastPred?.rows.length) return;
  const budget = Math.max(0, num($('#budget').value) || 0);
  const bundles = recommend(lastPred, budget);
  const note = lastPred.marketUsed ? '' : '<p class="muted small">※ 単勝オッズが未入力の馬がいるため、オッズ合成・期待値判定なしで計算しています。</p>';
  if (!bundles.length) { $('#reco').innerHTML = note; return; }
  const total = bundles.reduce((s, b) => s + b.amount, 0);
  $('#reco').innerHTML = note + bundles.map(b => `
    <div class="reco-card">
      <div class="h"><span>${esc(b.title)}</span><span class="amt">${b.alloc.length}点 ${yen(b.amount)}</span></div>
      <div class="d">${esc(b.desc)}　／　推定的中率 ${pct(b.hit)}</div>
      <div class="tickets">${b.alloc.map(t => `<span class="ticket"><b>${t.nums.join(t.ordered ? '→' : '-')}</b>${t.yen}円</span>`).join('') || '<span class="muted small">予算不足</span>'}</div>
    </div>`).join('') + `<p class="reco-total">合計 <b>${yen(total)}</b>（予算 ${yen(budget)}）</p>`;
}

function renderCombos() {
  if (!lastPred?.rows.length) return;
  const field = current.horses.length;
  const ordered = betType === 'umatan' || betType === 'sanrentan';
  const list = topCombos(lastPred, betType, 15);
  $('#combo-list').innerHTML = list.map(c => `
    <li>
      <span class="nums">${c.nums.map(n => wakuBadge(n, field)).join(`<span class="sep">${ordered ? '→' : '-'}</span>`)}</span>
      <span class="p">${pct(c.p, c.p < 0.01 ? 2 : 1)}</span>
      <span class="o">理論 ${c.p > 0 ? (1 / c.p).toFixed(1) : '—'}倍</span>
    </li>`).join('');
}

function renderWeights() {
  $('#weights').innerHTML = WEIGHT_DEFS.map(w => `
    <label>${w.label}
      <input type="range" min="${w.min ?? 0}" max="${w.max ?? 40}" step="1" data-w="${w.key}" value="${db.weights[w.key]}">
      <output>${db.weights[w.key]}${w.unit || ''}</output>
    </label>${w.note ? `<p class="note">${w.note}</p>` : ''}`).join('');
}

function renderResultForm() {
  const res = current.result || {};
  const o = res.order || [];
  $('#res-1').value = o[0] ?? '';
  $('#res-2').value = o[1] ?? '';
  $('#res-3').value = o[2] ?? '';
  $('#res-bet').value = res.bet ?? '';
  $('#res-pay').value = res.pay ?? '';
  renderResultSummary();
}

function renderResultSummary() {
  const res = current.result;
  const el = $('#res-summary');
  if (!res?.order?.[0]) { el.textContent = '結果を入力すると一覧の成績に集計されます。'; return; }
  const hon = current.honmei;
  const pos = hon ? res.order.indexOf(hon) : -1;
  const honText = hon ? (pos === 0 ? '◎ 1着 🎉' : pos > 0 ? `◎ ${pos + 1}着` : '◎ 着外') : '';
  const diff = (res.pay || 0) - (res.bet || 0);
  el.innerHTML = `${honText}${res.bet ? `　収支 <b class="${diff >= 0 ? 'plus' : 'minus'}">${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円</b>（回収率 ${pct((res.pay || 0) / res.bet, 0)}）` : ''}`;
}

/* ---------------- 貼り付け取り込み ---------------- */

function previewTable(head, rows) {
  if (!rows.length) return '<p class="muted small">馬ごとのデータを見つけられませんでした。種類を手動で選ぶか、馬名が入った範囲をコピーし直してください。</p>';
  return `<div class="table-wrap"><table class="preview"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderImportPreview(res) {
  const st = r => r.matchId ? '<span class="tag">更新</span>' : r.name ? '<span class="tag new">新規</span>' : '<span class="tag skip">対象なし</span>';
  const d = r => r.data;
  const cols = {
    past: [['騎手', r => esc(d(r).jockey || '')], ['斤量', r => d(r).kg ?? ''], ['RT', r => d(r).rt ?? ''], ['近走', r => esc(d(r).form || '')], ['SI', r => d(r).si ?? ''], ['距離', r => d(r).dist ?? ''], ['コース', r => d(r).course ?? ''], ['道悪', r => d(r).mud ?? ''], ['間隔週', r => d(r).weeks ?? ''], ['走数', r => (d(r).past || []).length]],
    train: [['評価', r => `<b>${d(r).train}</b>`], ['根拠', r => `<span class="small">${esc(d(r).trainHits)}</span>`], ['短評', r => `<span class="small wrap">${esc(d(r).trainNote)}</span>`]],
    comment: [['陣営', r => `<b>${d(r).camp}</b>`], ['根拠', r => `<span class="small">${esc(d(r).campHits)}</span>`], ['コメント', r => `<span class="small wrap">${esc(d(r).comment)}</span>`]],
    odds: [['単勝', r => d(r).odds == null ? '' : d(r).odds + (d(r).oddsApprox ? '倍以上' : '') + (d(r).oddsKind ? `<span class="muted small">（${d(r).oddsKind}）</span>` : '')], ['複勝', r => esc(d(r).place || '')], ['人気', r => d(r).pop ?? '']],
  }[res.type];
  return `<p class="small">判別：<b>${res.label}</b>　${res.rows.length}頭分を検出</p>` +
    previewTable(['番', '馬名', '', ...cols.map(c => c[0])], res.rows.map(r => [r.num ?? '—', esc(r.name || ''), st(r), ...cols.map(c => c[1](r))]));
}

const RACE_FIELD_LABEL = { date: '日付', venue: '競馬場', rnum: 'R', name: 'レース名', grade: '格', surface: '芝/ダ', dist: '距離', going: '馬場' };

function raceInfoPreview(res) {
  const info = res.raceInfo || {};
  const keys = Object.keys(info);
  if (!keys.length) return '';
  // 今の設定と違う項目だけ強調
  const diff = keys.filter(k => String(current[k] ?? '') !== String(info[k]));
  return `<div class="raceinfo-box">
    <label class="check"><input type="checkbox" id="imp-raceinfo" checked> レース情報も反映する</label>
    <p class="small"><b>${esc(res.raceInfoText)}</b></p>
    ${diff.length ? `<p class="muted small">変更される項目：${diff.map(k => RACE_FIELD_LABEL[k]).join('・')}</p>` : '<p class="muted small">現在の設定と同じです</p>'}
  </div>`;
}

function applyRaceInfo(info) {
  ['date', 'venue', 'rnum', 'name', 'grade', 'surface', 'dist', 'going'].forEach(k => {
    if (info[k] !== undefined && info[k] !== null && info[k] !== '') current[k] = info[k];
  });
}

const IMPORT_FIELDS = ['oddsApprox', 'oddsKind', 'rt', 'si', 'cpu', 'style', 'sexAge', 'stable', 'record', 'sire', 'form', 'agari', 'weeks', 'dist', 'course', 'mud', 'train', 'trainNote', 'trainHits', 'comment', 'camp', 'campHits', 'odds', 'place', 'pop', 'past'];

function applyImport(res) {
  let added = 0, updated = 0;
  // 空欄の初期行だけなら置き換える
  if (current.horses.every(h => !h.name) && res.rows.some(r => r.name && !r.matchId)) current.horses = [];
  res.rows.forEach(row => {
    let h = row.matchId && current.horses.find(x => x.id === row.matchId);
    if (h) updated++;
    else {
      if (!row.name || current.horses.length >= 18) return;
      h = newHorse(row.num || current.horses.length + 1);
      current.horses.push(h);
      added++;
    }
    if (!h.name && row.name) h.name = row.name;
    const d = row.data;
    IMPORT_FIELDS.forEach(k => { if (d[k] !== undefined && d[k] !== null && d[k] !== '') h[k] = d[k]; });
    // 出馬表由来の斤量・騎手は当日のものなので上書き、それ以外は空欄のときだけ
    if (d.kg && (d.fromSyutuba || h.kg == null)) h.kg = d.kg;
    if (d.jockey && (d.fromSyutuba || !h.jockey)) h.jockey = d.jockey;
  });
  // 名前もデータもない空欄行は取り除く
  if (current.horses.some(h => h.name)) {
    current.horses = current.horses.filter(h => h.name || h.odds != null || h.form || h.jockey);
  }
  const nums = current.horses.map(h => h.num);
  if (nums.every(Boolean) && new Set(nums).size === nums.length) current.horses.sort((a, b) => a.num - b.num);
  else renumber();
  return { added, updated };
}

/* ---------------- 一括貼り付け（簡易） ---------------- */

function parsePaste(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    let cols = line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : line.split(/\s+/);
    cols = cols.map(c => c.trim());
    if (/^馬番|^番$/.test(cols[0])) continue; // ヘッダー行
    let n = num(cols[0]);
    if (n === null || !/^\d+$/.test(cols[0])) { cols.unshift(''); n = null; }
    const [, name = '', jockey = '', kg = '', odds = '', form = ''] = cols;
    const h = newHorse(n);
    Object.assign(h, { name, jockey, kg: num(kg), odds: num(odds), form });
    out.push(h);
  }
  return out;
}

/* ---------------- サンプル ---------------- */

function sampleRace() {
  const r = newRace();
  Object.assign(r, { name: 'サンプル記念（例）', venue: '東京', rnum: 11, surface: 'turf', dist: 2400, going: '良', grade: 'G1' });
  const data = [
    // 名前, 騎手, 斤量, 単勝, 近走, 上り順, 騎手力, 距離, コース, 道悪, 調教, 体重±, 間隔
    ['アオゾラロード', '青木', 58, 3.1, '1-1-2', 1, 5, 5, 4, 3, 'A', 2, 8],
    ['ベニカゼ', '赤井', 58, 6.8, '2-3-1', 2, 4, 4, 5, 2, 'B', -4, 6],
    ['シロガネノツバサ', '白石', 56, 8.5, '1-4-3', 3, 4, 3, 3, 4, 'A', 0, 5],
    ['クロマティック', '黒田', 58, 12.4, '3-2-5', 4, 3, 4, 4, 3, 'B', 6, 10],
    ['キンイロノユメ', '金子', 58, 4.6, '2-1-1', 2, 5, 3, 3, 3, 'B', 10, 14],
    ['ミドリノカゼ', '緑川', 56, 25.0, '5-6-2', 3, 3, 4, 3, 5, 'A', -2, 4],
    ['ムラサキシキブ', '紫藤', 58, 18.7, '4-3-6', 5, 3, 4, 3, 2, 'C', 4, 8],
    ['ハイイロオオカミ', '灰谷', 58, 45.2, '8-7-9', 8, 2, 3, 2, 3, 'C', -8, 3],
    ['チャイロノコウマ', '茶屋', 58, 32.1, '6-5-4', 6, 2, 4, 3, 3, 'B', 0, 7],
    ['モモイロペガサス', '桃井', 56, 14.9, '3-1-7', 1, 3, 5, 4, 2, 'A', 2, 9],
    ['ルリイロアゲハ', '瑠璃', 58, 60.3, '9-11-8', 9, 2, 2, 3, 4, 'D', 12, 20],
    ['ギンノヤジリ', '銀林', 58, 21.5, '2-8-4', 4, 4, 3, 3, 3, 'B', -2, 6],
    ['コハクノヒカリ', '琥珀', 58, 88.0, '10-12-6', 11, 1, 3, 2, 2, 'C', 0, 30],
    ['アカネソラ', '茜', 58, 38.6, '4-9-5', 7, 3, 4, 3, 3, 'B', 4, 5],
    ['ヒスイノウタ', '翡翠', 56, 10.2, '1-2-8', 2, 4, 4, 3, 3, 'B', 0, 7],
    ['サンゴショウ', '珊瑚', 58, 120.5, '12-14-10', 13, 1, 2, 2, 3, 'C', -6, 2],
  ];
  r.horses = data.map((d, i) => {
    const h = newHorse(i + 1);
    [h.name, h.jockey, h.kg, h.odds, h.form, h.agari, h.jrank, h.dist, h.course, h.mud, h.train, h.bw, h.weeks] = d;
    return h;
  });
  return r;
}

/* ---------------- イベント ---------------- */

function init() {
  $('#r-venue').innerHTML = VENUES.map(v => `<option>${v}</option>`).join('');

  $('#nav-back').addEventListener('click', () => go('list'));

  // 一覧
  $('#new-race').addEventListener('click', () => {
    const r = newRace();
    db.races.push(r); save();
    go('edit', r.id);
  });
  $('#new-from-paste').addEventListener('click', () => {
    const r = newRace();
    r.name = '';
    db.races.push(r); save();
    go('edit', r.id);
    $('#open-paste').click();
  });
  $('#load-sample').addEventListener('click', () => {
    const r = sampleRace();
    db.races.push(r); save();
    go('race', r.id);
  });
  $('#race-list').addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) go('race', b.dataset.id);
  });

  $('#export-json').addEventListener('click', () => {
    $('#export-text').value = JSON.stringify(db);
    $('#export-dialog').showModal();
  });
  $('#export-copy').addEventListener('click', async () => {
    const ta = $('#export-text');
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('コピーしました。メモ帳などに貼り付けて保存してください。');
    } catch {
      ta.focus(); ta.select();
      toast('自動コピーできませんでした。選択された文字を長押し／Ctrl+C でコピーしてください。');
    }
  });
  $('#export-download').addEventListener('click', () => {
    const blob = new Blob([$('#export-text').value], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `keiba-yosou-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const importText = text => {
    try {
      const d = JSON.parse(text);
      if (!Array.isArray(d.races)) throw new Error('レースのデータが見つかりません');
      const ids = new Set(db.races.map(r => r.id));
      const add = d.races.filter(r => r && r.id && Array.isArray(r.horses) && !ids.has(r.id));
      db.races.push(...add);
      if (d.weights) db.weights = { ...DEFAULT_WEIGHTS, ...d.weights };
      save(); renderList();
      toast(`${add.length} 件のレースを読み込みました。`);
    } catch (err) {
      toast('読み込めませんでした：' + err.message);
    }
  };
  $('#import-paste').addEventListener('click', () => { $('#import-text').value = ''; $('#import-dialog').showModal(); });
  $('#import-dialog').addEventListener('close', () => {
    if ($('#import-dialog').returnValue === 'ok') importText($('#import-text').value);
  });
  $('#import-json').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) importText(await f.text());
    e.target.value = '';
  });

  // 編集：レース条件
  const bindRace = (sel, key, conv = v => v) => $(sel).addEventListener('input', e => {
    current[key] = conv(e.target.value);
    touch(); updateBiasNote();
  });
  bindRace('#r-date', 'date');
  bindRace('#r-venue', 'venue');
  bindRace('#r-num', 'rnum', num);
  bindRace('#r-name', 'name');
  bindRace('#r-surface', 'surface');
  bindRace('#r-dist', 'dist', num);
  bindRace('#r-going', 'going');
  bindRace('#r-grade', 'grade');
  bindRace('#r-bias', 'bias');

  // 編集：出走馬
  const tbody = $('#horse-table tbody');
  const onHorse = e => {
    const el = e.target.closest('[data-f]');
    if (!el) return;
    const h = current.horses.find(x => x.id === el.closest('tr').dataset.id);
    const f = el.dataset.f;
    if (f === 'scratched') {
      h.scratched = el.checked;
      el.closest('tr').classList.toggle('scratched', h.scratched);
      $('#horse-count').textContent = `${current.horses.filter(x => !x.scratched).length}頭 / 登録${current.horses.length}頭`;
    } else {
      h[f] = NUM_FIELDS.has(f) ? num(el.value) : el.value;
      if (f === 'odds') { h.oddsApprox = false; h.oddsKind = ''; }
    }
    touch();
  };
  tbody.addEventListener('input', onHorse);
  tbody.addEventListener('change', onHorse);
  tbody.addEventListener('click', async e => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const h = current.horses.find(x => x.id === b.dataset.del);
    if (h.name && !(await ask(`${h.num}番 ${h.name} を削除しますか？（後ろの馬番は1つずつ繰り上がります）`, '削除'))) return;
    current.horses = current.horses.filter(x => x.id !== b.dataset.del);
    renumber(); touch(); renderHorseRows();
  });
  $('#add-horse').addEventListener('click', () => {
    if (current.horses.length >= 18) { toast('JRA のフルゲートは最大18頭です。'); return; }
    current.horses.push(newHorse(current.horses.length + 1));
    touch(); renderHorseRows();
    $('#horse-table tbody tr:last-child input[data-f=name]').focus();
  });

  // 貼り付け取り込み（競馬ブック等）
  const dlg = $('#paste-dialog');
  let impType = 'auto';
  let impResult = null;
  const IMP_HELP = {
    auto: '貼り付けた内容から種類（過去走・調教・厩舎コメント・オッズ）を自動で判別します。',
    past: '出馬表（馬柱）ページをまるごとコピーして貼り付け。着順・距離・コース・道悪の成績、上がり順位、レース間隔、斤量を集計します。出走馬が未登録なら馬名も登録します。',
    train: '調教ページを貼り付け。短評の言葉、併せ馬の先着／遅れ、ラスト1F、矢印から調教評価（A〜D）を付けます。',
    comment: '厩舎の話（談話）を貼り付け。前向き・後ろ向きの言葉から陣営評価（1〜5）を付けます。',
    odds: 'オッズページを貼り付け。単勝・複勝・人気を取り込みます（「馬番 単勝」だけの行でも可）。',
    simple: '1行1頭「馬番 馬名 騎手 斤量 単勝 近走」の形式で出走馬を登録します。',
  };
  const setImpType = t => {
    impType = t;
    $$('#imp-type button').forEach(b => b.classList.toggle('on', b.dataset.type === t));
    $('#imp-help').textContent = IMP_HELP[t];
    $('#paste-replace-wrap').hidden = t !== 'simple';
    clearPreview();
  };
  const clearPreview = () => { impResult = null; $('#imp-preview').innerHTML = ''; $('#paste-ok').disabled = true; };
  $('#imp-type').addEventListener('click', e => { const b = e.target.closest('button[data-type]'); if (b) setImpType(b.dataset.type); });
  $('#paste-text').addEventListener('input', clearPreview);
  $('#open-paste').addEventListener('click', () => { $('#paste-text').value = ''; setImpType('auto'); dlg.showModal(); });
  $('#imp-analyze').addEventListener('click', () => {
    const text = $('#paste-text').value;
    if (!text.trim()) { toast('テキストを貼り付けてください。'); return; }
    if (impType === 'simple') {
      const parsed = parsePaste(text);
      impResult = { type: 'simple', label: '出馬表（簡易）', horses: parsed };
      $('#imp-preview').innerHTML = previewTable(['番', '馬名', '騎手', '斤量', '単勝', '近走'],
        parsed.map(h => [h.num ?? '—', esc(h.name), esc(h.jockey), h.kg ?? '', h.odds ?? '', esc(h.form)]));
    } else {
      impResult = KB.analyze(text, impType, current);
      $('#imp-preview').innerHTML = raceInfoPreview(impResult) + renderImportPreview(impResult);
    }
    $('#paste-ok').disabled = !(impResult.rows || impResult.horses).length && !Object.keys(impResult.raceInfo || {}).length;
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok' || !impResult) return;
    if (impResult.type === 'simple') {
      const parsed = impResult.horses;
      let list = $('#paste-replace').checked ? parsed : [...current.horses, ...parsed];
      list = list.slice(0, 18);
      const hasNums = list.every(h => h.num) && new Set(list.map(h => h.num)).size === list.length;
      if (hasNums) list.sort((a, b) => a.num - b.num);
      current.horses = list;
      if (!hasNums || list.some((h, i) => h.num !== i + 1)) renumber();
      toast(`${parsed.length}頭を登録しました。`);
    } else {
      const useInfo = $('#imp-raceinfo')?.checked && Object.keys(impResult.raceInfo || {}).length;
      if (useInfo) applyRaceInfo(impResult.raceInfo);
      const { added, updated } = applyImport(impResult);
      const parts = [];
      if (useInfo) parts.push('レース情報');
      if (updated) parts.push(`${updated}頭を更新`);
      if (added) parts.push(`${added}頭を追加`);
      toast(`${impResult.label}：${parts.join('・') || '変更なし'}`);
    }
    touch(); renderEdit();
  });

  $('#delete-race').addEventListener('click', async () => {
    if (!(await ask('このレースを削除しますか？元に戻せません。', '削除'))) return;
    db.races = db.races.filter(r => r !== current);
    save(); go('list');
  });
  $('#go-predict').addEventListener('click', () => go('race', current.id));

  // 予想
  $('#edit-race').addEventListener('click', () => go('edit', current.id));
  $('#pred-table').addEventListener('change', e => {
    const sel = e.target.closest('[data-mark]');
    if (!sel) return;
    const h = current.horses.find(x => x.id === sel.dataset.mark);
    // ◎○▲☆ は1頭だけ：他の馬の同じ手動印は外す
    if (['◎', '○', '▲', '☆'].includes(sel.value)) current.horses.forEach(x => { if (x !== h && x.mark === sel.value) x.mark = ''; });
    h.mark = sel.value;
    if (current.result?.order?.[0] == null && sel.value === '◎') current.honmei = h.num;
    touch(); refreshPrediction();
  });
  $('#pred-table').addEventListener('click', e => {
    const b = e.target.closest('[data-detail]');
    if (!b) return;
    const id = b.dataset.detail;
    const row = $(`[data-detail-row="${id}"]`);
    const open = row.hidden;
    row.hidden = !open;
    b.setAttribute('aria-expanded', open);
    open ? openDetails.add(id) : openDetails.delete(id);
  });
  $('#clear-marks').addEventListener('click', () => {
    current.horses.forEach(h => { h.mark = ''; });
    touch(); refreshPrediction();
  });
  $('#budget').addEventListener('input', renderReco);
  $('#bet-type').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    betType = b.dataset.type;
    $$('#bet-type button').forEach(x => x.classList.toggle('on', x === b));
    renderCombos();
  });
  $('#weights').addEventListener('input', e => {
    const el = e.target.closest('[data-w]');
    if (!el) return;
    db.weights[el.dataset.w] = Number(el.value);
    const def = WEIGHT_DEFS.find(w => w.key === el.dataset.w);
    el.nextElementSibling.textContent = el.value + (def.unit || '');
    save(); refreshPrediction();
  });
  $('#reset-weights').addEventListener('click', () => {
    db.weights = { ...DEFAULT_WEIGHTS };
    save(); renderWeights(); refreshPrediction();
  });

  const onResult = () => {
    const order = ['#res-1', '#res-2', '#res-3'].map(s => num($(s).value));
    const bet = num($('#res-bet').value), pay = num($('#res-pay').value);
    if (!order[0] && bet === null && pay === null) {
      current.result = null;
    } else {
      current.result = { order, bet, pay };
    }
    touch(); renderResultSummary();
  };
  ['#res-1', '#res-2', '#res-3', '#res-bet', '#res-pay'].forEach(s => $(s).addEventListener('input', onResult));

  // 初回起動時はサンプルレースを1件入れておく
  if (!db.seeded) {
    db.seeded = true;
    if (!db.races.length) db.races.push(sampleRace());
    save();
  }
  $('#guide').open = db.races.length <= 1;

  route();
}

init();

// ホーム画面に追加・オフライン対応（http(s) で開いたときのみ）
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
