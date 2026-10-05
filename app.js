'use strict';

// ---------- 設定・保存 ----------
const STORAGE_KEY = 'eye-training';

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function save(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 保存できない環境（プライベートモード等）では無視
  }
}

const stored = load();
const settings = Object.assign({ duration: '60', speed: 'normal' }, stored.settings);
let history = Array.isArray(stored.history) ? stored.history : [];

function persist() {
  save({ settings, history });
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(id) {
  $$('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
}

function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// ---------- 各トレーニング ----------
// mode は { title, init(ctx), update(t, dt), draw(g), onPointer?, onDir?, info?, stats() } を持つ

const SPEED = {
  pursuit: { slow: 7, normal: 4.5, fast: 2.8 },     // 1周期の秒数
  saccade: { slow: 2200, normal: 1500, fast: 1000 }, // ターゲットの制限時間 ms
  peripheral: { slow: 450, normal: 280, fast: 160 }, // 表示時間 ms
  focus: { slow: 8, normal: 5, fast: 3 },            // 1ステップの秒数
};

const PATTERNS = [
  { name: '横', fn: (p) => [Math.sin(p), 0] },
  { name: '縦', fn: (p) => [0, Math.sin(p)] },
  { name: '斜め ↗', fn: (p) => [Math.sin(p), -Math.sin(p)] },
  { name: '斜め ↘', fn: (p) => [Math.sin(p), Math.sin(p)] },
  { name: '円', fn: (p) => [Math.cos(p), Math.sin(p)] },
  { name: '8の字', fn: (p) => [Math.sin(p), Math.sin(2 * p)] },
];

function createPursuit(env) {
  const period = SPEED.pursuit[env.speed];
  const segment = env.duration / PATTERNS.length;
  const trail = [];
  let pos = [env.w / 2, env.h / 2];
  let current = PATTERNS[0];

  return {
    title: '追従運動',
    hint: '顔は動かさず、目だけで点を追いかけましょう',
    info: () => `パターン：${current.name}`,
    update(t) {
      const idx = Math.min(PATTERNS.length - 1, Math.floor(t / segment));
      if (PATTERNS[idx] !== current) {
        current = PATTERNS[idx];
        trail.length = 0;
      }
      const local = t - idx * segment;
      const [nx, ny] = current.fn((2 * Math.PI * local) / period);
      const ax = env.w / 2 - 40;
      const ay = env.h / 2 - 40;
      const a = Math.min(ax, ay);
      // 円・8の字は縦横比をそろえ、直線系は画面いっぱいに使う
      const round = current.name === '円' || current.name === '8の字';
      pos = [env.w / 2 + nx * (round ? a : ax), env.h / 2 + ny * (round ? a : ay)];
      trail.push(pos);
      if (trail.length > 24) trail.shift();
    },
    draw(g) {
      trail.forEach(([x, y], i) => {
        g.globalAlpha = (i / trail.length) * 0.25;
        g.beginPath();
        g.arc(x, y, 14, 0, Math.PI * 2);
        g.fillStyle = env.colors.accent;
        g.fill();
      });
      g.globalAlpha = 1;
      drawDot(g, pos[0], pos[1], 16, env.colors.target);
    },
    stats: () => [
      ['パターン数', `${PATTERNS.length}種類`],
      ['1周期', `${period}秒`],
    ],
  };
}

function createSaccade(env) {
  const limit = SPEED.saccade[env.speed];
  const radius = 26;
  let target = null;
  let hits = 0;
  let misses = 0;
  const times = [];
  let effect = null;

  function spawn(now) {
    const m = radius + 24;
    let x, y;
    // 直前の位置から十分離れた場所に出す
    do {
      x = rand(m, env.w - m);
      y = rand(m, env.h - m);
    } while (target && Math.hypot(x - target.x, y - target.y) < Math.min(env.w, env.h) * 0.35);
    target = { x, y, born: now };
  }

  return {
    title: 'ジャンプ',
    hint: '現れたターゲットをできるだけ早くタップ',
    info: () => `ヒット ${hits}　ミス ${misses}`,
    init(now) { spawn(now); },
    update(t, dt, now) {
      if (now - target.born > limit) {
        misses++;
        effect = { x: target.x, y: target.y, ok: false, at: now };
        spawn(now);
      }
      this.now = now;
    },
    onPointer(x, y, now) {
      if (Math.hypot(x - target.x, y - target.y) <= radius * 1.6) {
        hits++;
        times.push(now - target.born);
        effect = { x: target.x, y: target.y, ok: true, at: now };
        spawn(now);
      }
    },
    draw(g) {
      const age = (this.now - target.born) / limit;
      // 残り時間リング
      g.beginPath();
      g.arc(target.x, target.y, radius + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - age));
      g.strokeStyle = env.colors.accent;
      g.lineWidth = 3;
      g.stroke();
      drawDot(g, target.x, target.y, radius, env.colors.target);
      if (effect) {
        const k = (this.now - effect.at) / 300;
        if (k < 1) {
          g.globalAlpha = 1 - k;
          g.beginPath();
          g.arc(effect.x, effect.y, radius + k * 30, 0, Math.PI * 2);
          g.strokeStyle = effect.ok ? env.colors.good : env.colors.bad;
          g.lineWidth = 3;
          g.stroke();
          g.globalAlpha = 1;
        }
      }
    },
    stats() {
      const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
      const total = hits + misses;
      return [
        ['ヒット', `${hits}`],
        ['ミス', `${misses}`],
        ['命中率', total ? `${Math.round((hits / total) * 100)}%` : '-'],
        ['平均反応時間', avg ? `${avg} ms` : '-'],
      ];
    },
    summary() {
      return `ヒット ${hits} / ミス ${misses}`;
    },
  };
}

function createPeripheral(env) {
  const showMs = SPEED.peripheral[env.speed];
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const names = Object.keys(DIRS);
  let phase = 'wait'; // wait → show → answer
  let phaseAt = 0;
  let waitMs = 0;
  let dir = null;
  let correct = 0;
  let total = 0;
  let feedback = null;

  function nextTrial(now) {
    phase = 'wait';
    phaseAt = now;
    waitMs = rand(700, 1500);
    dir = names[Math.floor(Math.random() * names.length)];
  }

  return {
    title: '周辺視野',
    hint: '中央の ✛ を見つめたまま、光った方向を矢印で答えてください',
    info: () => `正解 ${correct} / ${total}`,
    init(now) { nextTrial(now); },
    update(t, dt, now) {
      this.now = now;
      if (phase === 'wait' && now - phaseAt > waitMs) {
        phase = 'show';
        phaseAt = now;
      } else if (phase === 'show' && now - phaseAt > showMs) {
        phase = 'answer';
        phaseAt = now;
      } else if (phase === 'answer' && now - phaseAt > 3000) {
        total++;
        feedback = { ok: false, at: now };
        nextTrial(now);
      }
    },
    onDir(d, now) {
      if (phase !== 'answer' && phase !== 'show') return;
      total++;
      const ok = d === dir;
      if (ok) correct++;
      feedback = { ok, at: now };
      nextTrial(now);
    },
    draw(g) {
      const cx = env.w / 2;
      const cy = env.h / 2;
      let crossColor = env.colors.text;
      if (feedback && this.now - feedback.at < 400) {
        crossColor = feedback.ok ? env.colors.good : env.colors.bad;
      }
      g.strokeStyle = crossColor;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx - 12, cy); g.lineTo(cx + 12, cy);
      g.moveTo(cx, cy - 12); g.lineTo(cx, cy + 12);
      g.stroke();
      if (phase === 'show') {
        const [dx, dy] = DIRS[dir];
        const r = dx ? env.w / 2 - 50 : env.h / 2 - 50;
        drawDot(g, cx + dx * r, cy + dy * r, 18, env.colors.target);
      }
      if (phase === 'answer') {
        g.fillStyle = env.colors.muted;
        g.font = '15px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('どの方向？', cx, cy + 40);
      }
    },
    stats: () => [
      ['正解', `${correct} / ${total}`],
      ['正答率', total ? `${Math.round((correct / total) * 100)}%` : '-'],
      ['表示時間', `${showMs} ms`],
    ],
    summary: () => `正解 ${correct} / ${total}`,
  };
}

function createRelax(env) {
  // 1サイクル：まばたき → 閉眼 → 遠くを見る
  const STEPS = [
    { text: 'ゆっくり大きくまばたき', sub: 'パチ…パチ…と5回', sec: 8 },
    { text: '目を閉じて深呼吸', sub: '肩の力を抜きましょう', sec: 10 },
    { text: '遠くを見つめる', sub: '窓の外など、6m以上先をぼんやりと', sec: 12 },
  ];
  const cycle = STEPS.reduce((a, s) => a + s.sec, 0);
  let step = STEPS[0];
  let local = 0;

  return {
    title: 'リラックス',
    hint: '',
    info: () => step.text,
    update(t) {
      let r = t % cycle;
      for (const s of STEPS) {
        if (r < s.sec) { step = s; local = r; break; }
        r -= s.sec;
      }
    },
    draw(g) {
      const cx = env.w / 2;
      const cy = env.h / 2;
      // 4秒周期で膨らんで縮む円（呼吸ガイド）
      const breath = (Math.sin((local / 4) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      const base = Math.min(env.w, env.h) * 0.18;
      g.globalAlpha = 0.25;
      drawDot(g, cx, cy, base + breath * base * 0.6, env.colors.accent);
      g.globalAlpha = 1;
      g.fillStyle = env.colors.text;
      g.textAlign = 'center';
      g.font = 'bold 22px system-ui, sans-serif';
      g.fillText(step.text, cx, cy - 4);
      g.fillStyle = env.colors.muted;
      g.font = '15px system-ui, sans-serif';
      g.fillText(step.sub, cx, cy + 24);
      g.fillText(`${Math.ceil(step.sec - local)}`, cx, cy + 52);
    },
    stats: () => [['サイクル', `${(env.duration / cycle).toFixed(1)}回分`]],
  };
}

function createFocus(env) {
  const stepSec = SPEED.focus[env.speed];
  // 画面 → 指先（近く） → 画面 → 遠く をくり返す
  const STEPS = [
    { key: 'screen', text: '画面の小さな文字を見る', sub: '文字がくっきり見えるまでピントを合わせる' },
    { key: 'near', icon: '☝️', text: '指先を見る', sub: '顔の前 約20cm に指を立てて、指先にピント' },
    { key: 'screen', text: '画面の小さな文字を見る', sub: '文字がくっきり見えるまでピントを合わせる' },
    { key: 'far', icon: '🏔️', text: '遠くを見る', sub: '窓の外など、できるだけ遠くにピント' },
  ];
  const CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ2345679';
  let index = -1;
  let step = STEPS[0];
  let local = 0;
  let switches = 0;
  let chars = '';

  function randomChars() {
    let out = '';
    for (let i = 0; i < 4; i++) out += CHARS[Math.floor(Math.random() * CHARS.length)];
    return out;
  }

  return {
    title: '遠近ピント',
    hint: '合図に合わせて、近く・画面・遠くへピントを切り替えます',
    info: () => step.text,
    update(t) {
      const i = Math.floor(t / stepSec);
      local = t - i * stepSec;
      if (i !== index) {
        if (index >= 0) switches++;
        index = i;
        step = STEPS[i % STEPS.length];
        if (step.key === 'screen') chars = randomChars();
      }
    },
    draw(g) {
      const cx = env.w / 2;
      const cy = env.h / 2;
      const ring = Math.min(env.w, env.h) * 0.32;
      // 残り時間リング
      g.beginPath();
      g.arc(cx, cy, ring, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - local / stepSec));
      g.strokeStyle = env.colors.accent;
      g.globalAlpha = 0.5;
      g.lineWidth = 4;
      g.stroke();
      g.globalAlpha = 1;

      g.textAlign = 'center';
      g.textBaseline = 'middle';
      if (step.key === 'screen') {
        // 小さめの文字をはっきり読ませる
        g.fillStyle = env.colors.text;
        g.font = '600 16px ui-monospace, monospace';
        g.fillText(chars.split('').join(' '), cx, cy);
      } else {
        // 画面から目を離す合図：アイコンが少しずつ近づく／遠ざかる
        const k = Math.min(1, local / 0.6);
        const size = step.key === 'near' ? 40 + 40 * k : 80 - 30 * k;
        g.globalAlpha = 0.85;
        g.font = `${size}px system-ui, sans-serif`;
        g.fillText(step.icon, cx, cy);
        g.globalAlpha = 1;
      }
      g.fillStyle = env.colors.text;
      g.font = 'bold 20px system-ui, sans-serif';
      g.fillText(step.text, cx, cy + ring + 34);
      g.fillStyle = env.colors.muted;
      g.font = '14px system-ui, sans-serif';
      g.fillText(step.sub, cx, cy + ring + 60);
      g.textBaseline = 'alphabetic';
    },
    stats: () => [
      ['ピント切り替え', `${switches}回`],
      ['1ステップ', `${stepSec}秒`],
    ],
    summary: () => `切り替え ${switches}回`,
  };
}

const MODES = {
  pursuit: createPursuit,
  saccade: createSaccade,
  peripheral: createPeripheral,
  focus: createFocus,
  relax: createRelax,
};

function drawDot(g, x, y, r, color) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
}

// ---------- 実行エンジン ----------
const canvas = $('#stage');
const g = canvas.getContext('2d');
let run = null;

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (run) {
    run.env.w = rect.width;
    run.env.h = rect.height;
  }
}

function startExercise(modeKey) {
  showScreen('exercise');
  // レイアウト（ヒント・方向パッド）を確定させてから描画領域を測る
  $('#hint').textContent = '';
  $('#dir-pad').classList.toggle('hidden', modeKey !== 'peripheral');
  const rect = canvas.getBoundingClientRect();
  const env = {
    w: rect.width,
    h: rect.height,
    speed: settings.speed,
    duration: Number(settings.duration),
    colors: {
      text: cssVar('--text'),
      muted: cssVar('--muted'),
      accent: cssVar('--accent'),
      target: cssVar('--target'),
      good: cssVar('--good'),
      bad: cssVar('--bad'),
    },
  };
  resize();
  const mode = MODES[modeKey](env);
  run = { modeKey, mode, env, start: null, countdownEnd: performance.now() + 3000, raf: 0, lastT: 0 };

  $('#ex-title').textContent = mode.title;
  $('#ex-info').textContent = '';
  $('#ex-timer').textContent = fmtTime(env.duration);
  $('#hint').textContent = mode.hint;

  run.raf = requestAnimationFrame(tick);
}

function tick(now) {
  if (!run) return;
  const { mode, env } = run;
  g.clearRect(0, 0, env.w, env.h);

  if (now < run.countdownEnd) {
    g.fillStyle = env.colors.text;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 64px system-ui, sans-serif';
    g.fillText(String(Math.ceil((run.countdownEnd - now) / 1000)), env.w / 2, env.h / 2);
    g.textBaseline = 'alphabetic';
    run.raf = requestAnimationFrame(tick);
    return;
  }

  if (run.start === null) {
    run.start = now;
    mode.init?.(now);
  }

  const t = (now - run.start) / 1000;
  const dt = t - run.lastT;
  run.lastT = t;

  if (t >= env.duration) {
    finish(true);
    return;
  }

  mode.update(t, dt, now);
  mode.draw(g);
  $('#ex-timer').textContent = fmtTime(env.duration - t);
  if (mode.info) $('#ex-info').textContent = mode.info();
  run.raf = requestAnimationFrame(tick);
}

function finish(completed) {
  if (!run) return;
  cancelAnimationFrame(run.raf);
  const { mode, modeKey, env, start } = run;
  run = null;

  if (!completed || start === null) {
    showScreen('home');
    renderHistory();
    return;
  }

  history.unshift({
    mode: modeKey,
    title: mode.title,
    summary: mode.summary ? mode.summary() : `${fmtTime(env.duration)} 完了`,
    at: Date.now(),
  });
  history = history.slice(0, 20);
  persist();

  $('#res-title').textContent = `${mode.title}（${fmtTime(env.duration)}）`;
  const stats = [['時間', fmtTime(env.duration)], ...mode.stats()];
  $('#res-stats').innerHTML = '';
  for (const [k, v] of stats) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    $('#res-stats').append(dt, dd);
  }
  $('#res-retry').dataset.mode = modeKey;
  showScreen('result');
}

// ---------- 入力 ----------
canvas.addEventListener('pointerdown', (e) => {
  if (!run || run.start === null || !run.mode.onPointer) return;
  const rect = canvas.getBoundingClientRect();
  run.mode.onPointer(e.clientX - rect.left, e.clientY - rect.top, performance.now());
});

$$('#dir-pad button').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (run && run.start !== null && run.mode.onDir) run.mode.onDir(btn.dataset.dir, performance.now());
  });
});

const KEY_DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

document.addEventListener('keydown', (e) => {
  if (!run) return;
  if (e.key === 'Escape') {
    finish(false);
  } else if (KEY_DIRS[e.key] && run.start !== null && run.mode.onDir) {
    e.preventDefault();
    run.mode.onDir(KEY_DIRS[e.key], performance.now());
  }
});

$('#ex-stop').addEventListener('click', () => finish(false));
new ResizeObserver(resize).observe(canvas);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && run) finish(false);
});

// ---------- ホーム画面 ----------
function renderSettings() {
  $$('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.value === settings[key]);
    });
  });
}

$$('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings[seg.dataset.setting] = b.dataset.value;
    persist();
    renderSettings();
  });
});

function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '';
  for (const h of history.slice(0, 8)) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.textContent = `${h.title}：${h.summary}`;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(h.at).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    li.append(what, when);
    list.append(li);
  }
  $('#history-empty').classList.toggle('hidden', history.length > 0);
}

$$('.card').forEach((c) => c.addEventListener('click', () => startExercise(c.dataset.mode)));
$('#res-retry').addEventListener('click', (e) => startExercise(e.currentTarget.dataset.mode));
$('#res-home').addEventListener('click', () => {
  showScreen('home');
  renderHistory();
});

renderSettings();
renderHistory();
