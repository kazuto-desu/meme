'use strict';

/* =====================================================================
 * 競馬ブック等からのコピー＆ペースト取り込み
 *  - 過去走（馬柱）/ 調教 / 厩舎コメント / オッズ の4種類
 *  - ページのレイアウトに依存しすぎないよう「馬名 or 馬番」で馬ごとの
 *    ブロックに分け、ブロック内をキーワード・正規表現で解析する
 *  - 結果はプレビューで確認・修正してから反映する前提
 * ===================================================================== */

const KB = (() => {
  const VENUES = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];

  // 馬名と誤認しやすいカタカナ語
  const STOP = new Set([
    'ダート', 'コース', 'ペース', 'スタート', 'ゴール', 'レース', 'ポリ', 'ポリトラック', 'ウッド', 'ウッドチップ',
    'ハロー', 'ブリンカー', 'ゲート', 'クラス', 'オープン', 'ハンデ', 'ステークス', 'カップ', 'トラック', 'ラスト',
    'ハナ', 'トップ', 'ジョッキー', 'マイル', 'スピード', 'スタミナ', 'パワー', 'リズム', 'テン', 'ロス', 'フォーム',
    'ハミ', 'メンコ', 'チーク', 'シャドー', 'シャドーロール', 'ペースアップ', 'コーナー', 'ムチ', 'ラップ', 'タイム',
    'オッズ', 'グレード', 'ハンデキャップ', 'リステッド', 'ターフ', 'バテ', 'ジリ', 'キャリア', 'ローテ', 'ローテーション',
    'メンバー', 'レベル', 'ステップ', 'ポジション', 'ダッシュ', 'スムーズ', 'テンション', 'カイバ', 'ケア', 'ベスト',
    'プラス', 'マイナス', 'チャンス', 'パドック', 'スタンド', 'エンジン', 'ギア', 'ブレーキ', 'フットワーク', 'バランス',
    // サイトのメニュー・見出し
    'コースデータ', 'レイティング', 'データ', 'ページ', 'インタビュー', 'ギリギリ', 'ランキング', 'ニュース', 'コラム',
    'メニュー', 'ログイン', 'ログアウト', 'マイページ', 'ホーム', 'リンク', 'シェア', 'カレンダー', 'スケジュール',
    'プレミアム', 'サービス', 'ヘルプ', 'サイト', 'アプリ', 'ポイント', 'コメント', 'レース', 'ハンデ', 'セール',
  ]);

  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

  /** 丸数字を [[n]] に退避してから NFKC 正規化（全角英数→半角） */
  function normalize(text) {
    let t = String(text || '')
      .replace(/\[([^\]]*)\]\((?:https?:)?[^)]*\)/g, '$1') // [文字](URL) → 文字
      .replace(/[①-⑳]/g, c => `[[${CIRCLED.indexOf(c) + 1}]]`);
    t = t.normalize('NFKC');
    return t.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
  }

  const isName = s => /^[ァ-ヶー]{2,9}$/.test(s) && !STOP.has(s);

  /* ---------------- 馬ごとのブロック分割 ---------------- */

  /**
   * テキストを馬ごとのブロックに分ける。
   * known: 既存の出走馬 [{num, name}]（あれば馬名一致を優先）
   */
  function splitBlocks(text, known = []) {
    const lines = text.split('\n').map(l => l.trim());
    const names = known.filter(h => h.name).map(h => h.name).sort((a, b) => b.length - a.length);
    const heads = [];

    lines.forEach((line, i) => {
      if (!line) return;
      // 1) 既知の馬名を含む行
      const kn = names.find(n => line.includes(n));
      if (kn) {
        const before = line.slice(0, line.indexOf(kn));
        const nums = before.match(/\d{1,2}/g);
        heads.push({ i, name: kn, num: nums ? +nums[nums.length - 1] : null });
        return;
      }
      // 2) 「(枠) 馬番 馬名 …」または「馬名」だけの行
      const m = line.match(/^(?:(\d{1,2})\s*)?(?:(\d{1,2})\s*)?(?:[◎○◯▲△☆×注✓\s]*)([ァ-ヶー]{2,9})(?=$|[\s(（□◇*外地父市])/);
      if (m && isName(m[3]) && !/追走|先行|先着|同入|遅れ|併せ/.test(line)) {
        let num = m[2] ? +m[2] : m[1] ? +m[1] : null;
        if (num === null) {
          // 直前の行が数字だけなら馬番とみなす
          for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
            if (/^\d{1,2}$/.test(lines[k])) { num = +lines[k]; break; }
            if (lines[k]) break;
          }
        }
        if (num !== null && (num < 1 || num > 18)) num = null;
        heads.push({ i, name: m[3], num });
      }
    });

    // 同じ馬名が連続して出る（見出し＋本文など）場合は最初だけ
    const uniq = heads.filter((h, k) => k === 0 || h.name !== heads[k - 1].name);
    const blocks = uniq.map((h, k) => {
      const end = k + 1 < uniq.length ? uniq[k + 1].i : lines.length;
      const head = lines[h.i];
      const body = lines.slice(h.i, end).join('\n');
      return { name: h.name, num: h.num, head, body, start: h.i };
    });

    // 馬名が見つからない場合：行頭の馬番で分割（オッズ表など）
    if (!blocks.length) {
      lines.forEach(line => {
        const m = line.match(/^(\d{1,2})\s+(.+)$/);
        if (m && +m[1] >= 1 && +m[1] <= 18) blocks.push({ name: '', num: +m[1], head: line, body: line });
      });
    }
    return blocks;
  }

  /* ---------------- 種類の自動判別 ---------------- */

  function detectType(text) {
    const t = normalize(text);
    const score = {
      past: (t.match(/\d{2,4}[./]\d{1,2}[./]\d{1,2}/g) || []).length * 2 + (t.match(/(芝|ダ)\s?\d{4}/g) || []).length * 2 + (t.match(/\d{1,2}着|\[\[\d+\]\]/g) || []).length,
      train: (t.match(/坂路|坂|CW|DP|PW|ポリ|ウッド|美[南北]?W|栗[東]?|美浦|併せ|馬なり|強め|一杯|G前仕掛|直強|末強/g) || []).length * 2,
      odds: (t.match(/単勝|複勝|オッズ|人気/g) || []).length * 2 + ((t.match(/\d+\.\d\s*[-~〜]\s*\d+\.\d/g) || []).length),
      comment: (t.match(/。/g) || []).length,
    };
    let best = 'comment', v = -1;
    for (const k in score) if (score[k] > v) { v = score[k]; best = k; }
    return v <= 0 ? 'comment' : best;
  }

  /* ---------------- 共通スコア ---------------- */

  function finishVal(f) {
    if (f === '中') return 0.05;
    if (f === 1) return 1;
    if (f === 2) return 0.82;
    if (f === 3) return 0.7;
    if (f === 4) return 0.56;
    if (f === 5) return 0.48;
    if (f <= 9) return 0.3;
    return 0.15;
  }

  /** 着順の平均評価値 → 1〜5 */
  function toFive(avg) {
    if (avg >= 0.75) return 5;
    if (avg >= 0.55) return 4;
    if (avg >= 0.38) return 3;
    if (avg >= 0.25) return 2;
    return 1;
  }

  function sentiment(text, dict) {
    let s = 0;
    const hits = [];
    for (const [re, w] of dict) {
      const g = new RegExp(re.source, 'g');
      const found = [...new Set((text.match(g) || []))].slice(0, 2); // 同系統は2つまで
      found.forEach(m => { s += w; hits.push((w > 0 ? '+' : '−') + m); });
    }
    return { s, hits };
  }

  /* ---------------- 過去走（馬柱） ---------------- */

  const DATE_RE = /(\d{2,4})[./年](\d{1,2})[./月](\d{1,2})日?/g;

  function parseDate(y, m, d) {
    let yy = +y;
    if (yy < 100) yy += 2000;
    const dt = new Date(yy, +m - 1, +d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function parseRun(seg) {
    const run = {};
    const dm = seg.match(/(\d{2,4})[./年](\d{1,2})[./月](\d{1,2})/);
    if (dm) run.date = parseDate(dm[1], dm[2], dm[3]);
    run.venue = VENUES.find(v => seg.includes(v)) || null;
    const sd = seg.match(/(芝|ダ|障)\s?(?:外|内|直)?\s?(\d{4})/);
    if (sd) { run.surface = sd[1] === '芝' ? 'turf' : sd[1] === 'ダ' ? 'dirt' : 'jump'; run.dist = +sd[2]; }
    const gm = seg.match(/(?:芝|ダ)[^\n]{0,12}?(良|稍重|稍|重|不良|不)/) || seg.match(/(良|稍重|不良)/);
    if (gm) run.going = { '稍': '稍重', '不': '不良' }[gm[1]] || gm[1];

    if (/中止|競走中止|取消|除外|失格/.test(seg)) run.finish = '中';
    else {
      const f = seg.match(/(\d{1,2})\s?着/) || seg.match(/\[\[(\d{1,2})\]\]/);
      if (f) run.finish = +f[1];
    }
    const fld = seg.match(/(\d{1,2})\s?頭/);
    if (fld) run.field = +fld[1];

    // 上がり3F：走破タイム（1.34.5 など）より後ろの 3x.x
    const timeIdx = seg.search(/\d\.\d{2}\.\d/);
    const after = timeIdx >= 0 ? seg.slice(timeIdx + 6) : seg;
    const ag = after.match(/(?:上が?り?|3F)?\s?(3[2-9]\.\d|4[0-2]\.\d)\s?(?:\[\[(\d{1,2})\]\])?/);
    if (ag) { run.agari = +ag[1]; if (ag[2]) run.agariRank = +ag[2]; }
    const arm = seg.match(/上が?り?\s?(\d{1,2})\s?位/);
    if (arm) run.agariRank = +arm[1];

    const bw = seg.match(/(\d{3})\s?(?:kg)?\s?\(\s?([+-]?\d{1,2}|±0|0)\s?\)/);
    if (bw) { run.weight = +bw[1]; run.weightDiff = parseInt(bw[2].replace('±', ''), 10) || 0; }
    return run;
  }

  /**
   * 過去走の配列（古い→新しい順、日付なしなら新しい→古いでも可）から各評価を作る
   */
  function summarizeRuns(runsIn, race) {
    let runs = [...runsIn];
    if (runs.length && runs.every(r => r.date)) runs.sort((a, b) => b.date - a.date);
    else runs.reverse();
    runs = runs.slice(0, 10);

    const out = { past: runs.map(r => {
      const { month, day, ...rest } = r;
      return { ...rest, date: r.date ? fmtDate(r.date) : null };
    }) };
    if (!runs.length) return out;

    const fin = runs.filter(r => r.finish !== undefined);
    if (fin.length) out.form = fin.slice(0, 5).map(r => r.finish).join('-');
    if (fin.length && runs.some(r => r.grade || r.race)) {
      const fa = formAdjusted(runs, race);
      if (fa !== null) out.formAdj = fa;
    }

    const last = runs[0];
    if (last.agariRank) out.agari = last.agariRank;
    if (last.date && race.date) {
      const w = Math.round((new Date(race.date) - last.date) / (7 * 864e5));
      if (w >= 0 && w < 200) out.weeks = w;
    }

    // スピード指数：直近3走の上位2つの平均
    const sis = runs.slice(0, 3).map(r => r.si).filter(Boolean).sort((a, b) => b - a);
    if (sis.length) out.si = Math.round(sis.slice(0, 2).reduce((a, b) => a + b, 0) / Math.min(2, sis.length));

    const rated = (list, wf) => {
      let s = 0, w = 0;
      list.forEach(r => {
        if (r.finish === undefined) return;
        const k = wf(r);
        if (k <= 0) return;
        s += finishVal(r.finish) * k; w += k;
      });
      return w >= 0.8 ? toFive(s / w) : null;
    };
    const sameSurf = runs.filter(r => r.surface === race.surface);
    if (race.dist) {
      const v = rated(sameSurf, r => (r.dist ? Math.exp(-Math.abs(r.dist - race.dist) / 250) : 0));
      if (v) out.dist = v;
    }
    const cv = rated(sameSurf.filter(r => r.venue === race.venue), () => 1);
    if (cv) out.course = cv;
    const mv = rated(runs.filter(r => ['稍重', '重', '不良'].includes(r.going)), r => (r.going === '稍重' ? 0.6 : 1));
    if (mv) out.mud = mv;
    return out;
  }

  /** クラスの格付け（数字が大きいほど上） */
  const CLASS_LV = { G1: 6, G2: 5, G3: 4, 'OP/L': 3, L: 3, OP: 3, '3勝': 2, '2勝': 1, '1勝': 0, '未勝利': -1, '新馬': -1 };
  function runLevel(r) {
    if (r.grade && CLASS_LV[r.grade] !== undefined) return CLASS_LV[r.grade];
    const m = (r.race || '').match(/([123])勝/);
    if (m) return CLASS_LV[m[1] + '勝'];
    if (/未勝|新馬/.test(r.race || '')) return -1;
    return 3; // 「関越S」など格付けなしの特別はオープン扱い
  }

  /** 近走の評価（0〜1）：着順を今回のクラスとの差で補正し、新しい走ほど重く */
  function formAdjusted(runs, race) {
    const today = CLASS_LV[race.grade] ?? 3;
    const rec = [0.35, 0.27, 0.2, 0.12, 0.06];
    let s = 0, w = 0;
    runs.slice(0, 5).forEach((r, i) => {
      if (r.finish === undefined) return;
      const diff = runLevel(r) - today;
      // 格上で掲示板（5着以内）は加点、格下の好走は割り引き
      let v = finishVal(r.finish);
      if (diff > 0 && r.finish !== '中' && r.finish <= 9) v = Math.min(1, v * (1 + 0.12 * diff) + 0.04 * diff);
      if (diff < 0) v *= Math.max(0.55, 1 + 0.15 * diff);
      s += v * rec[i]; w += rec[i];
    });
    return w ? Math.round((s / w) * 1000) / 1000 : null;
  }

  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function parsePast(block, race) {
    const body = block.body;
    // 日付で走ごとに区切る（日付がなければ行ごと）
    const idx = [];
    let m;
    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(body))) idx.push(m.index);
    let segs;
    if (idx.length) segs = idx.map((s, k) => body.slice(s, k + 1 < idx.length ? idx[k + 1] : undefined));
    else segs = body.split('\n').slice(1).filter(l => /(芝|ダ)\s?\d{4}|着/.test(l));

    const runs = segs.map(parseRun).filter(r => r.finish !== undefined || r.dist);
    // 汎用形式は新しい順に並ぶ前提（日付があれば日付で並べ替え）
    const out = summarizeRuns(runs.every(r => r.date) ? runs : [...runs].reverse(), race);

    // 見出し行から斤量・騎手（空欄のときだけ使う）
    const kg = block.head.match(/(?:^|\s)(4[89]|5\d|6[0-3])(?:\.[05])?(?=\s|kg|$)/);
    if (kg) out.kg = parseFloat(kg[0]);
    return out;
  }

  /* ---------------- 調教 ---------------- */

  const TRAIN_WORDS = [
    [/絶好|抜群|文句(?:ない|なし)|申し分ない|素晴らしい|万全|見せつけ/, 3],
    [/好調|好気配|上昇|良化(?!途上)|好仕上|仕上がり(?:は)?(?:良|上々|いい|万全)|仕上がって|仕上がっている|気配上々|気合乗り上々|活気|デキ(?:良|上々)|上々|心身好調|態勢良好|元気一杯|スピード感|手応え(?:も)?十分/, 2],
    [/軽快|鋭い|鋭く|鋭さ|切れ|伸び(?:良|鋭)|力強|迫力(?!という点)|余力(?:十分|残し|あり)|楽に|反応(?:良|が良)|動き(?:は)?良|好時計|自己ベスト|シャープ|機敏|素軽|キビキビ|グイグイ|スムーズ/, 1.5],
    [/順調|好調(?:持続|維持|キープ)|平行線|変わり(?:なく|ない|なかった)|まずまず|悪くない|合格点|この馬なり|元気(?!一杯|がない)|落ち着き|少々好転|いつも(?:こんな|通り|どおり)/, 0.5],
    [/平凡|物足りな|もう一息|一息(?!入)|ひと息|案外|地味|及ばない|程度か|(?:いい|良い|上々)が$/, -1.5],
    [/重い|鈍い|鈍く|硬い|反応(?:鈍|悪)|モタ|太め|重め残|良化途上|まだ(?:緩|重)|散漫|浮つ/, -2],
    [/不安|疲れ(?!なし)|落ち(?!着)|下降|覇気(?:がない|なし|に欠)|元気がない|ズブ/, -2.5],
  ];

  /** 「太め感もない」「疲労を残さないように」など否定の言い回しを除く */
  const stripNegations = t => t
    .replace(/(?:疲れ|疲労)(?:感)?(?:も|は)?(?:ない|なく|なし|ありません)/g, '疲れなし')
    .replace(/(太め|不安|重め|左右差)(?:感)?(?:も|は|を)?(?:ない|なく|なし|残さない|残さず|なくなって)/g, '')
    .replace(/(悪く|重く)ない/g, '悪くない')
    .replace(/(?:一息|ひと息)入る/g, '休み明け')
    .replace(/重い馬場|重馬場|荒れ馬場|重たい馬場/g, '馬場')
    .replace(/(?:いくらか|多少|少し|やや)(?:良化|上向)\S*?(?=[。、]|$)/g, '少々好転');

  function parseTrain(block) {
    if (/攻め解説|\(前回\)/.test(block.body)) return parseKbTrain(block);
    const body = block.body.replace(block.name, '');
    const { s: ws, hits } = sentiment(stripNegations(body), TRAIN_WORDS);
    let s = ws;

    // 併せ馬の結果
    const pass = (body.match(/先着/g) || []).length;
    const late = (body.match(/遅れ/g) || []).length;
    s += Math.min(pass, 2) * 1 - Math.min(late, 2) * 1.2;
    if (pass) hits.push(`+先着×${pass}`);
    if (late) hits.push(`−遅れ×${late}`);

    // ラスト1F：各行の末尾寄りの 10.5〜14.5 の数字
    let best1f = null;
    body.split('\n').forEach(l => {
      const ts = (l.match(/(?:^|[\s\-])(1[0-4]\.\d)(?=\s|$|\[|\D)/g) || []).map(x => parseFloat(x.replace(/[^\d.]/g, '')));
      const last = ts[ts.length - 1];
      if (last && last >= 10.5 && last <= 14.5 && (best1f === null || last < best1f)) best1f = last;
    });
    if (best1f !== null) {
      const d = best1f <= 11.5 ? 2 : best1f <= 12.0 ? 1 : best1f <= 12.5 ? 0 : -1;
      s += d;
      hits.push(`1F ${best1f.toFixed(1)}`);
    }

    // 矢印・明示評価
    const arrow = body.match(/[↑↗→↘↓]/);
    if (arrow) { s += { '↑': 2, '↗': 1, '→': 0, '↘': -1, '↓': -2 }[arrow[0]]; hits.push(arrow[0]); }
    const grade = body.match(/(?:評価|評)\s?[:：]?\s?([A-DＡ-Ｄ])/);

    let train;
    if (grade) train = grade[1].normalize('NFKC');
    else train = s >= 3 ? 'A' : s >= 0.5 ? 'B' : s > -2 ? 'C' : 'D';

    // 短評：数字の少ない日本語の行
    const note = body.split('\n')
      .map(l => l.trim())
      .filter(l => l && l.length >= 4 && (l.match(/\d/g) || []).length <= 2 && /[ぁ-んァ-ヶ一-龠]/.test(l))
      .join(' / ')
      .slice(0, 140);
    return { train, trainNote: note, trainHits: hits.join(' ') };
  }

  /* ---------- 競馬ブック 調教ページ専用 ---------- */

  // 「津村明 11/18 美W 不 馬なり余力」のような追い切りの見出し
  const SESSION = /^(\S+)\s+(\d{1,2})\/(\d{1,2})\s+(\S+?)\s+(良|稍|重|不)\s*(.*)$/;
  const PARTNER = /(追走|先行|併せ|の内|の外)[^\n]*?(?:(\d+\.\d)秒)?(先着|同入|遅れ)/;

  function trackKind(course) {
    if (/坂/.test(course)) return 'hill';
    return 'flat'; // W・CW・芝・ダ・ポリ等
  }

  /** 1F（ラスト1ハロン）の評価。コース種別・馬場で基準を変える */
  function oneFScore(t, kind, going) {
    const adj = going === '重' || going === '不' ? 0.2 : going === '稍' ? 0.1 : 0;
    const x = t - adj;
    const th = kind === 'hill' ? [12.0, 12.5, 13.0, 13.5] : [11.3, 11.6, 11.9, 12.2];
    if (x <= th[0]) return 1.5;
    if (x <= th[1]) return 1;
    if (x <= th[2]) return 0.4;
    if (x <= th[3]) return 0;
    return -0.5;
  }

  function parseKbTrain(block) {
    const lines = block.body.split('\n').map(l => l.trim()).filter(Boolean);
    // 見出し：「1 カラマティアノス 気合乗り上々 ↗」
    const hm = lines[0].match(new RegExp(`${block.name}\\s*(.*?)\\s*([↑↗→↘↓])?$`));
    const tanpyo = hm ? hm[1].trim() : '';
    const arrow = hm && hm[2] ? hm[2] : '';
    const ai = lines.findIndex(l => l === '攻め解説');
    const kaisetsu = ai >= 0 ? lines.slice(ai + 1).filter(l => !/^\d{1,2}$/.test(l)).join('') : '';

    // 追い切りごとに分ける（(前回) は今回の評価から除外）
    const sessions = [];
    let cur = null;
    lines.slice(1, ai >= 0 ? ai : undefined).forEach(l => {
      const m = l.match(SESSION);
      if (m) {
        cur = { rider: m[1], date: `${m[2]}/${m[3]}`, course: m[4], going: m[5], intensity: m[6].trim(), prev: m[1] === '(前回)', times: [], partner: null };
        sessions.push(cur);
        return;
      }
      if (!cur) return;
      const pm = l.match(PARTNER);
      if (pm && /[ぁ-んァ-ヶ一-龠]/.test(l)) { cur.partner = { text: l, result: pm[3], margin: pm[2] ? +pm[2] : 0 }; return; }
      const ts = (l.match(/\d{1,3}\.\d/g) || []).map(Number);
      if (ts.length) cur.times = ts;
    });
    const now = sessions.filter(x => !x.prev);

    const hits = [];
    let score = 0;
    // 短評（記者のまとめ）は重め
    const st = sentiment(stripNegations(tanpyo), TRAIN_WORDS);
    score += st.s * 1.3;
    st.hits.forEach(h => hits.push('短評' + h));
    // 攻め解説
    const ks = sentiment(stripNegations(kaisetsu), TRAIN_WORDS);
    score += ks.s * 0.6;
    hits.push(...ks.hits);
    // 矢印
    if (arrow) {
      const a = { '↑': 2.5, '↗': 1.5, '→': 0, '↘': -1.5, '↓': -2.5 }[arrow];
      score += a;
      hits.push(arrow);
    }
    // 時計（今回の追い切りのラスト1F：最も良い1本と最終追い切りの平均）
    const sc = now.map(x => {
      const t1 = x.times[x.times.length - 1];
      return t1 && t1 < 15 ? oneFScore(t1, trackKind(x.course), x.going) : null;
    });
    const valid = sc.filter(v => v !== null);
    if (valid.length) {
      const best = Math.max(...valid);
      const last = sc[sc.length - 1] ?? best;
      const t = (best + last) / 2;
      score += t;
      const lastS = now[now.length - 1];
      hits.push(`時計${t >= 0 ? '+' : ''}${t.toFixed(1)}`);
      if (lastS) hits.push(`最終 ${lastS.date} ${lastS.course}(${lastS.going}) ${lastS.intensity} 1F${lastS.times[lastS.times.length - 1] ?? '-'}`);
    }
    // 併せ馬
    now.forEach(x => {
      if (!x.partner) return;
      const r = x.partner.result;
      const v = r === '先着' ? 1 : r === '同入' ? 0.3 : (/アタマ|クビ|ハナ/.test(x.partner.text) ? -0.5 : -1);
      score += v;
      hits.push(`併せ${r}${x.partner.margin ? x.partner.margin + '秒' : ''}`);
    });

    const train = score >= 6 ? 'A' : score >= 2.5 ? 'B' : score >= -1.5 ? 'C' : 'D';
    return {
      train,
      trainScore: Math.round(score * 10) / 10,
      trainNote: [tanpyo + (arrow ? ' ' + arrow : ''), kaisetsu].filter(Boolean).join(' / ').slice(0, 200),
      trainHits: hits.join(' '),
    };
  }

  /* ---------------- 厩舎コメント ---------------- */

  const CAMP_WORDS = [
    [/自信|勝ち負け|好勝負|勝ち(?:に)?等しい|勝ち等しく|勝てる|勝ちたい|負けられ|力は(?:一枚)?上|能力上位|上位争い|手が届|重賞(?:でも|級)|通用する/, 2],
    [/楽しみ|面白い|期待|充実|本当に状態が(?:いい|良)|凄く(?:いい|良い)|すごく(?:いい|良い)/, 1.5],
    [/好調|状態(?:は|が|面は)?(?:良|いい|上々|万全|最高|キープ)|いい状態|デキ(?:は)?(?:良|いい|上々|最高)|仕上が(?:り|っ)(?:は|て)?(?:良|いい|上々|万全|まし)|上積み|良くなって|調子(?:は)?(?:良|いい|上向)|具合(?:は)?(?:良|いい)|反応が良|動きが良|動き(?:も)?いい|成長|良化(?!途上)|いい気配|気配(?:は|が)?(?:良|いい)|収穫/, 1],
    [/(?:距離|コース|舞台|条件|右回り|左回り|小回り|福島|中山|東京|京都|阪神|中京|新潟|小倉|札幌|函館|\d{4}メートル)[^。]{0,8}?(?:合う|合って|合い|向く|向いて|得意|フィット|適性|守備範囲|相性)|実績のある|勝っている|強い勝ち方|\d勝している|良績|叩いて(?:良化|上昇|良くな)|ひと叩きされ|ハンデ(?:は|も)?(?:軽い|手頃|恵まれ)/, 1],
    [/順調|変わりない|いつも通り|力は出せ|力を出せ|まずまず|問題(?:ない|ありません)|悪くない|リフレッシュ|疲れなし/, 0.5],
    [/善戦|見直し|一考|(?:れ|け|め|せ|え|ぶ)ば[。]?$|ようなら|ればと|れればと|くれれば/, -0.5],
    [/展開次第|相手(?:が|は|も)?強|メンバー(?:が|は|も)?強|楽ではない|課題|未知数|半信半疑|どこまで|注意が必要|窮屈|もうひとつ|もう一つ|見劣/, -1],
    [/叩き台|様子見|使いつつ|次(?:が|へ)?本番|良化途上|太め|余裕残し|仕上がり途上|ひと息|一息|もう一息|緩さ|ズブ|振るわ/, -1],
    [/厳しい|苦しい|難しい|距離(?:が)?(?:長い|短い|不安)|気性(?:が|難|面)|集中力|イレ込|不安|疲れ(?!なし)|休み明け(?:で|は)?(?:どうか|厳)|引退|無事に(?:走|回)/, -1.5],
  ];

  /** 今日の馬場と陣営の言葉の噛み合い（重・不良での「良馬場が前提」など） */
  function goingFit(text, going) {
    const heavy = going === '重' || going === '不良';
    const soft = heavy || going === '稍重';
    const hits = [];
    let s = 0;
    if (/良馬場(?:が前提|で走れれば|なら|希望|がいい|の方が)|(?:時計の)?速い馬場(?:が|の方が)|道悪(?:は|が)?(?:苦手|ダメ|不安|未知)|渋った馬場(?:は|が)?(?:苦手|ダメ)/.test(text)) {
      if (soft) { s -= heavy ? 2 : 1; hits.push(`馬場×(${going})`); }
    }
    if (/時計(?:が|の)?(?:かかって|かかる|要せば|要する)|道悪(?:は|も)?(?:得意|苦にしない|上手|こなす|合う)|重馬場(?:は|も)?(?:得意|合う|上手)|(?:前走|今回)のような馬場(?:状態)?(?:も|が)?合|渋った馬場(?:も|が|は)?(?:得意|合う|苦にしない)|力の要る馬場/.test(text)) {
      if (soft) { s += heavy ? 1.5 : 1; hits.push(`馬場○(${going})`); }
    }
    return { s, hits };
  }

  const CAMP_MARK = { '◎': 2.5, '○': 0, '◯': 0, '▲': -1, '△': -2, '☆': 0.5, '×': -3 };

  function parseComment(block, race = {}) {
    let body = block.body.replace(block.name, '').split('\n').map(l => l.trim()).filter(l => l && !/^\d{1,2}$/.test(l)).join(' ');
    body = body.replace(/^[\s\d]+/, '').trim();
    const hits = [];
    let s = 0;
    // 競馬ブック形式：「○(見出し) 話し手――本文」
    const km = body.match(/^([◎○◯▲△☆×])?\s?\(([^)]*)\)\s*([^―]*?)―+\s*(.*)$/);
    let headline = '', speaker = '', text = body;
    if (km) {
      const mark = km[1] || '';
      headline = km[2]; speaker = km[3].trim(); text = km[4];
      if (mark && CAMP_MARK[mark]) { s += CAMP_MARK[mark]; hits.push(`印${mark}`); }
      const h = sentiment(stripNegations(headline), CAMP_WORDS);
      s += h.s * 1.2;
      h.hits.forEach(x => hits.push('見出し' + x));
    }
    const c = sentiment(stripNegations(text), CAMP_WORDS);
    s += c.s * (km ? 0.6 : 1);
    hits.push(...c.hits);
    const g = goingFit(headline + ' ' + text, race.going);
    s += g.s;
    hits.push(...g.hits);

    const camp = s >= 4.5 ? 5 : s >= 1.5 ? 4 : s > -0.5 ? 3 : s > -2.5 ? 2 : 1;
    return { comment: body.replace(/\n+/g, ' ').slice(0, 300), camp, campScore: Math.round(s * 10) / 10, campHits: hits.join(' ') };
  }

  /* ---------------- オッズ ---------------- */

  function parseOdds(block, opt = {}) {
    let t = block.body.replace(block.name, ' ');
    const out = {};
    if (opt.kind) out.oddsKind = opt.kind;
    const rng = t.match(/(\d+\.\d)\s*[-~〜]\s*(\d+\.\d)/);
    if (rng) { out.place = `${rng[1]}-${rng[2]}`; t = t.replace(rng[0], ' '); }
    const pop = t.match(/(\d{1,2})\s?(?:番)?人気/);
    if (pop) { out.pop = +pop[1]; t = t.replace(pop[0], ' '); }
    // 馬番・斤量などを避けて「小数1桁」の最初の値を単勝とみなす
    const cands = (t.match(/(?:^|\s)(\d{1,4}\.\d)(?=\s|$|倍)/g) || []).map(x => parseFloat(x));
    // 斤量（48.0〜62.5 の .0/.5）と紛らわしい値は、他に候補があれば除外
    const looksKg = v => v >= 48 && v <= 62.5 && (v * 2) % 1 === 0;
    const pool = cands.filter(v => v >= 1.0);
    const win = pool.length > 1 ? (pool.find(v => !looksKg(v)) ?? pool[0]) : pool[0];
    if (win !== undefined) out.odds = win;
    // 「50倍以上は☆印」：馬名の後ろの ☆ を下限値として扱う
    else if (opt.star && new RegExp(`${block.name}\\s*☆`).test(block.body)) { out.odds = opt.star; out.oddsApprox = true; }
    return out;
  }

  /* ---------------- 競馬ブック 出馬表（馬柱）専用 ---------------- */

  const VENUE_1 = { 札: '札幌', 函: '函館', 福: '福島', 新: '新潟', 東: '東京', 中: '中山', 名: '中京', 京: '京都', 阪: '阪神', 小: '小倉' };
  const SEX_AGE = /(牡|牝|セ)\s?(\d{1,2})(?:\s|$)/;
  const RUN1 = /^(\d{1,2})(札|函|福|新|東|中|名|京|阪|小|中京|中山)(\d{1,2})[･・.](\d{1,2})\s*(.*)$/;

  /** 「枠」「馬番」が1行ずつ並ぶ競馬ブックの出馬表を馬ごとに切り出す */
  function splitKeibabook(text) {
    const lines = text.split('\n').map(l => l.trim());
    const starts = [];
    for (let i = 0; i + 2 < lines.length; i++) {
      if (!/^[1-8]$/.test(lines[i]) || !/^\d{1,2}$/.test(lines[i + 1])) continue;
      const num = +lines[i + 1];
      if (num < 1 || num > 18) continue;
      // 15行以内に「牡 4」などの性齢があれば馬の先頭とみなす
      const sx = lines.slice(i + 2, i + 18).findIndex(l => SEX_AGE.test(l));
      if (sx < 0) continue;
      starts.push(i);
      i += 2;
    }
    return starts.map((st, k) => ({ start: st, lines: lines.slice(st, k + 1 < starts.length ? starts[k + 1] : lines.length) }));
  }

  function parseKbRunLines(l1, l2, l3, l4) {
    const run = {};
    const m1 = l1.match(RUN1);
    if (!m1) return null;
    run.venue = VENUE_1[m1[2]] || m1[2];
    run.month = +m1[3]; run.day = +m1[4];
    const rest = m1[5] || '';
    const fm = rest.match(/(\d{1,2})頭\s?(\d{1,2}|中|取|除|失)?\s*$/);
    if (fm) {
      run.field = +fm[1];
      if (fm[2]) run.finish = /^\d+$/.test(fm[2]) ? +fm[2] : '中';
    }
    const gr = rest.match(/(G[123]|\(L\)|OP|L)(?=\d{1,2}頭)/) || rest.match(/(G[123]|\(L\)|OP)/);
    if (gr) run.grade = gr[1].replace(/[()]/g, '');
    run.race = rest.replace(/(G[123]|\(L\)|OP)?\s?\d{1,2}頭.*$/, '').trim();

    const m2 = (l2 || '').match(/^(\d{4})(芝|ダ|障)(内|外|直)?([A-D])?\s?(\d\.\d{2}\.\d)?(.*?)\s+(\d{2}(?:\.\d)?)\b/);
    if (m2) {
      run.dist = +m2[1];
      run.surface = m2[2] === '芝' ? 'turf' : m2[2] === 'ダ' ? 'dirt' : 'jump';
      if (m2[5]) run.time = m2[5];
      run.jockey = m2[6].trim();
      run.kg = parseFloat(m2[7]);
    }
    const m3 = (l3 || '').match(/^([SMH])?(\d{2}\.\d)-(\d{2}\.\d)(最内|大外|内|中|外)?(?:S(\d{2,3}))?/);
    if (m3) {
      run.pace = m3[1] || null;
      run.first3f = +m3[2];
      run.agari = +m3[3];
      run.pos4 = m3[4] || null;
      if (m3[5]) run.si = +m3[5];
    }
    const m4 = (l4 || '').match(/^(.*?)(\d+\.\d)(.*?)(\d{3})(\d{1,2})枠(\d{1,2})人/);
    if (m4) {
      run.margin = +m4[2];
      run.rival = (m4[1] || m4[3]).trim(); // 勝ち馬（自分が勝った時は2着馬）
      run.weight = +m4[4];
      run.num = +m4[5];
      run.pop = +m4[6];
    }
    return run;
  }

  /** 月日だけの日付に年を補う（古い順に並んでいる前提で新しい方から遡る） */
  function assignYears(runs, raceDate) {
    const rd = raceDate ? new Date(raceDate) : new Date();
    let y = rd.getFullYear(), m = rd.getMonth() + 1, d = rd.getDate();
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k];
      if (!r.month) continue;
      let yy = y;
      if (r.month > m || (r.month === m && r.day > d)) yy = y - 1;
      r.date = new Date(yy, r.month - 1, r.day);
      y = yy; m = r.month; d = r.day;
    }
  }

  function parseKeibabookHorse(block, race) {
    const L = block.lines;
    const out = { waku: +L[0], num: +L[1] };
    let i = 2;
    if (/^\d{2,3}\.\d$/.test(L[i])) { out.rt = parseFloat(L[i]); i++; }
    else if (/^[-－—]*$/.test(L[i])) i++;
    // CPU印・展開
    for (; i < Math.min(L.length, 6); i++) {
      if (/^[◎○◯▲△☆×注✓・]$/.test(L[i])) { out.cpu = L[i] === '・' ? '' : L[i]; continue; }
      if (/^(逃|先|差|追|自|マ)$/.test(L[i])) { out.style = L[i]; continue; }
      break;
    }
    // 斤量＋騎手（1文字ずつ縦に並ぶ）
    const sx = L.findIndex((l, k) => k >= i && SEX_AGE.test(l));
    const km = (L[i] || '').match(/^(\d{2}(?:\.\d)?)\s*(.*)$/);
    if (km && sx > i) {
      out.kg = parseFloat(km[1]);
      let jk = [km[2], ...L.slice(i + 1, sx)].join('\n');
      // 騎手名の前の「B」はブリンカー着用
      if (/(?:^|\n)B(?:\s|\n|$)/.test(jk)) { out.blinker = true; jk = jk.replace(/(?:^|\n)B(?=\s|\n|$)/, ''); }
      // 縦書きの長音「ー」が「|」「｜」で来る
      out.jockey = jk.replace(/[|｜│]/g, 'ー').replace(/\s/g, '');
    }
    if (sx >= 0) {
      const sa = L[sx].match(SEX_AGE);
      out.sexAge = sa[1] + sa[2];
      out.sire = L[sx].slice(0, sa.index).trim();
      out.name = (L[sx + 1] || '').replace(/[\s(（].*$/, '').trim();
    }
    const stable = L.find(l => /[(（](美|栗|地|外)[)）]$/.test(l));
    if (stable) out.stable = stable;
    const rec = L.find(l => /^\d+-\d+-\d+-\d+$/.test(l));
    if (rec) out.record = rec;

    // 過去走：1走4行
    const runs = [];
    for (let k = Math.max(0, sx); k < L.length; k++) {
      if (!RUN1.test(L[k])) continue;
      const r = parseKbRunLines(L[k], L[k + 1], L[k + 2], L[k + 3]);
      if (r) { runs.push(r); k += 3; }
    }
    assignYears(runs, race.date);
    return { out, runs };
  }

  /** 出馬表（競馬ブック形式）を解析。形式が違えば null */
  function parseKeibabookSyutuba(text, race) {
    const blocks = splitKeibabook(text);
    if (!blocks.length) return null;
    const rows = blocks.map(b => {
      const { out, runs } = parseKeibabookHorse(b, race);
      const data = summarizeRuns(runs, race);
      Object.assign(data, {
        kg: out.kg, jockey: out.jockey, rt: out.rt, cpu: out.cpu, style: out.style,
        blinker: !!out.blinker, sexAge: out.sexAge, stable: out.stable, record: out.record, sire: out.sire,
      });
      return { num: out.num, name: out.name || '', data };
    });
    return { rows, start: blocks[0].start };
  }

  /* ---------------- レース情報（ページ見出し） ---------------- */

  const NAME_KEY = /チャンピオン|シップ|大賞典|ハードル|ステークス|S$|S\(|賞|カップ|C$|C\(|記念|特別|杯|ダービー|オークス|新馬|未勝利|クラス|オープン|トロフィー|チャレンジ|ハンデキャップ|メイクデビュー|ジャンプ/;

  function gradeOf(t) {
    const g = t.match(/(?:G|Jpn)\s?(III|II|I|[123])(?![\dA-Za-z])/);
    if (g) return 'G' + ({ I: 1, II: 2, III: 3 }[g[1]] || g[1]);
    if (/\(L\)|リステッド|オープン|OP/.test(t)) return 'OP/L';
    if (/3勝クラス|1600万/.test(t)) return '3勝';
    if (/2勝クラス|1000万/.test(t)) return '2勝';
    if (/1勝クラス|500万/.test(t)) return '1勝';
    if (/未勝利/.test(t)) return '未勝利';
    if (/新馬|メイクデビュー/.test(t)) return '新馬';
    return null;
  }

  /**
   * ページ先頭（最初の馬より前）からレース条件を読み取る。
   * 見つかった項目だけを返す：{date, venue, rnum, name, surface, dist, going, grade}
   */
  function parseRaceInfo(text, blocks, baseYear) {
    const lines = text.split('\n').map(l => l.trim());
    const end = blocks.length && blocks[0].start !== undefined ? blocks[0].start : Math.min(lines.length, 20);
    const head = lines.slice(0, end).filter(Boolean).join('\n');
    if (!head) return {};
    const info = {};

    let dm = head.match(/(\d{4})\s?[年./-]\s?(\d{1,2})\s?[月./-]\s?(\d{1,2})/);
    if (dm) info.date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
    else if ((dm = head.match(/(\d{1,2})月(\d{1,2})日/))) info.date = `${baseYear}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;

    const vm = head.match(new RegExp(`\\d回\\s?(${VENUES.join('|')})`)) || head.match(new RegExp(`(${VENUES.join('|')})\\s?\\d{1,2}\\s?R`));
    info.venue = vm ? vm[1] : VENUES.find(v => head.includes(v)) || undefined;

    const rm = head.match(/(?:^|[^\d.])(\d{1,2})\s?R(?![a-zA-Z])/) || head.match(/第?(\d{1,2})競走/);
    if (rm && +rm[1] >= 1 && +rm[1] <= 12) info.rnum = +rm[1];

    // 「2000m (芝Ｂ・右)」形式（競馬ブック）
    const sm1 = head.match(/(\d{4})\s?m\s?[(（]\s?(芝|ダート|ダ|障害?)/);
    const sm = sm1 ? [sm1[0], sm1[2], sm1[1]] : head.match(/(芝|ダート|ダ|障害)\s?[・･:：]?\s?(?:[(（]?(?:外|内|右|左|直線|外→内|内2周)[)）]?\s?)*(\d{4})\s?m?/);
    if (sm) {
      info.surface = sm[1] === '芝' ? 'turf' : sm[1].startsWith('障') ? undefined : 'dirt';
      info.dist = +sm[2];
    }

    // 「晴・重」のような 天候・馬場
    const wm = head.match(/(?:晴|曇|雨|小雨|雪|小雪)\s?[・･/\s]\s?(良|稍重|稍|重|不良|不)(?![a-zA-Z一-龠:：])/);
    const gm = wm || head.match(/(?:馬場(?:状態)?|芝|ダート?)\s?[:：]?\s?(良|稍重|稍|重|不良|不)(?:馬場)?(?![a-zA-Z一-龠])/) || head.match(/(良|稍重|不良)馬場/);
    const gm2 = gm || head.match(/\d{4}\s?m?\s+(?:[^\s\n]+\s+)?(良|稍重|稍|重|不良|不)(?=\s|$)/);
    if (gm2) info.going = { '稍': '稍重', '不': '不良' }[gm2[1]] || gm2[1];

    info.grade = gradeOf(head) || undefined;

    // レース名：キーワードを含む語句から、回次・格付け・条件を除く
    const segs = head.split(/[\n\s]+/).filter(Boolean);
    const cand = segs.find(x => NAME_KEY.test(x) && !/^\d+R$/.test(x) && !/^(?:\d歳|オープン|\d勝クラス|新馬|未勝利)$/.test(x) && !/^(?:[(（].*[)）])$/.test(x));
    if (cand) {
      const name = cand
        .replace(/[(（]\s?(?:G|Jpn)\s?(?:III|II|I|[123])\s?[)）]/g, '')
        .replace(/(?:G|Jpn)\s?(?:III|II|I|[123])$/, '')
        .replace(/[(（]L[)）]/g, '')
        .replace(/^第\d+回/, '')
        .trim();
      if (name) info.name = name;
    }

    Object.keys(info).forEach(k => info[k] === undefined && delete info[k]);
    return info;
  }

  function describeRaceInfo(info) {
    const parts = [];
    if (info.date) parts.push(info.date);
    if (info.venue || info.rnum) parts.push(`${info.venue || ''}${info.rnum ? info.rnum + 'R' : ''}`);
    if (info.name) parts.push(info.name);
    if (info.grade) parts.push(info.grade);
    if (info.surface || info.dist) parts.push(`${info.surface === 'turf' ? '芝' : info.surface === 'dirt' ? 'ダ' : ''}${info.dist || ''}`);
    if (info.going) parts.push(info.going);
    return parts.join(' ');
  }

  /* ---------------- まとめ ---------------- */

  const LABEL = { past: '過去走', train: '調教', comment: '厩舎コメント', odds: 'オッズ' };

  /**
   * @returns {{type, rows: Array<{num, name, data, matchId}>}}
   */
  function analyze(rawText, type, race) {
    const text = normalize(rawText);
    const kbBlocks = splitKeibabook(text);
    const isKb = kbBlocks.length > 0;
    if (type === 'auto') type = isKb ? 'past' : detectType(rawText);
    const known = race.horses.map(h => ({ id: h.id, num: h.num, name: h.name }));
    const useKb = isKb && type === 'past';
    const blocks = useKb ? [] : splitBlocks(text, known);
    // ページ見出しのレース条件（距離・コース適性の計算にも使う）
    const year = (race.date || '').slice(0, 4) || new Date().getFullYear();
    const raceInfo = parseRaceInfo(text, isKb ? [{ start: kbBlocks[0].start }] : blocks, year);
    const r2 = { ...race, ...raceInfo };
    const starM = text.match(/(\d+)倍以上は☆/);
    const oddsOpt = { star: starM ? +starM[1] : (/☆/.test(text) && /単勝/.test(text) ? 50 : null), kind: /(?:^|\n)予測(?:\n|$)|予測オッズ/.test(text) ? '予測' : '' };
    const matchOf = (name, num) => known.find(h => h.name && h.name === name) || (num && known.find(h => h.num === num && (!h.name || !name)));
    let rows;
    if (useKb) {
      rows = parseKeibabookSyutuba(text, r2).rows.map(r => {
        const match = matchOf(r.name, r.num);
        return { ...r, matchId: match?.id || null, data: { ...r.data, fromSyutuba: true } };
      });
    } else {
      const fn = { past: b => parsePast(b, r2), train: parseTrain, comment: b => parseComment(b, r2), odds: b => parseOdds(b, oddsOpt) }[type];
      rows = blocks.map(b => {
        const match = matchOf(b.name, b.num);
        return { num: b.num ?? match?.num ?? null, name: b.name || match?.name || '', matchId: match?.id || null, data: fn(b) };
      });
    }
    // 同じ馬が複数ブロックに分かれた場合は後勝ちでまとめる
    const merged = [];
    rows.forEach(r => {
      const prev = merged.find(x => (r.name && x.name === r.name) || (!r.name && r.num && x.num === r.num));
      if (prev) Object.assign(prev.data, Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined && v !== null && v !== '')));
      else merged.push(r);
    });
    return { type, label: LABEL[type], rows: merged, raceInfo, raceInfoText: describeRaceInfo(raceInfo) };
  }

  return { analyze, parseKeibabookSyutuba, splitKeibabook, parseRaceInfo, describeRaceInfo, detectType, normalize, splitBlocks, parsePast, parseTrain, parseComment, parseOdds, LABEL };
})();

if (typeof module !== 'undefined') module.exports = KB;
