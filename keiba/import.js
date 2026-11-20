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
  ]);

  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

  /** 丸数字を [[n]] に退避してから NFKC 正規化（全角英数→半角） */
  function normalize(text) {
    let t = String(text || '').replace(/[①-⑳]/g, c => `[[${CIRCLED.indexOf(c) + 1}]]`);
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
      if (m && isName(m[3])) {
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

    let runs = segs.map(parseRun).filter(r => r.finish !== undefined || r.dist);
    if (runs.every(r => r.date)) runs.sort((a, b) => b.date - a.date);
    runs = runs.slice(0, 10);

    const out = { past: runs.map(r => ({ ...r, date: r.date ? r.date.toISOString().slice(0, 10) : null })) };
    if (!runs.length) return out;

    const fin = runs.filter(r => r.finish !== undefined);
    if (fin.length) out.form = fin.slice(0, 5).map(r => r.finish).join('-');

    const last = runs[0];
    if (last.agariRank) out.agari = last.agariRank;
    if (last.date && race.date) {
      const d = new Date(race.date);
      const w = Math.round((d - last.date) / (7 * 864e5));
      if (w >= 0 && w < 200) out.weeks = w;
    }

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

    // 見出し行から斤量・騎手（空欄のときだけ使う）
    const kg = block.head.match(/(?:^|\s)(4[89]|5\d|6[0-3])(?:\.[05])?(?=\s|kg|$)/);
    if (kg) out.kg = parseFloat(kg[0]);
    return out;
  }

  /* ---------------- 調教 ---------------- */

  const TRAIN_WORDS = [
    [/絶好|抜群|文句なし|申し分ない|素晴らしい/, 3],
    [/好調|好気配|上昇|良化(?!途上)|状態(?:は)?良|仕上がり(?:良|上々|万全)|気配上々|活気|デキ(?:良|上々)/, 2],
    [/軽快|鋭い|鋭く|切れ|伸び(?:良|鋭)|力強|迫力|余力(?:十分|残し|あり)|楽に|反応良|動き良|好時計|自己ベスト/, 1.5],
    [/順調|好調(?:持続|維持|キープ)|平行線|変わりなく|まずまず|悪くない/, 0.5],
    [/平凡|物足りな|もう一息|一息|案外|地味|ひと息/, -1.5],
    [/重い|鈍い|鈍く|硬い|反応(?:鈍|悪)|モタ|太め|重め残|良化途上|息遣い|まだ(?:緩|重)/, -2],
    [/不安|疲れ|落ち|下降|覇気(?:がない|なし|に欠)|元気がない|ズブ/, -2.5],
  ];

  function parseTrain(block) {
    const body = block.body.replace(block.name, '');
    const { s: ws, hits } = sentiment(body, TRAIN_WORDS);
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

  /* ---------------- 厩舎コメント ---------------- */

  const CAMP_WORDS = [
    [/自信|勝ち負け|好勝負|チャンス十分|勝てる|勝ちたい|ここは(?:譲れ|負けられ)|力は(?:一枚)?上|能力上位|楽しみ|期待/, 2],
    [/好調|状態(?:は)?(?:良い|いい|上々|万全|最高)|デキ(?:は)?(?:良|いい|上々|最高)|仕上が(?:り|っ)(?:は)?(?:良|上々|万全|ている)|上積み|良くなって|調子(?:は)?(?:良|いい|上向)|具合(?:は)?(?:良|いい)/, 1.5],
    [/距離(?:は)?(?:合う|ぴったり|問題ない|ベスト)|コース(?:は)?(?:合う|向く|得意)|条件(?:好転|ぴったり|合う)|叩いて(?:良化|上昇|良くな)|ひと叩きされ/, 1],
    [/順調|変わりない|いつも通り|力は出せる|力を出せ|まずまず/, 0.5],
    [/展開次第|相手(?:が|は|も)?強|メンバー(?:が|は|も)?強|楽ではない|課題|課題は|未知数|半信半疑|どこまで/, -1],
    [/叩き台|様子見|使いつつ|次(?:が|へ)?本番|良化途上|太め|余裕残し|仕上がり途上|ひと息|もう一息|緩さ/, -1.5],
    [/厳しい|苦しい|距離(?:が)?(?:長い|短い|不安)|気性(?:が|難|面)|集中力|イレ込|不安|疲れ|休み明け(?:で|は)?(?:どうか|厳)/, -2],
  ];

  function parseComment(block) {
    const body = block.body.replace(block.name, '').replace(/^[\s\d]+/, '').trim();
    const { s, hits } = sentiment(body, CAMP_WORDS);
    const camp = s >= 3 ? 5 : s >= 1.5 ? 4 : s > -1 ? 3 : s > -2.5 ? 2 : 1;
    return { comment: body.replace(/\n+/g, ' ').slice(0, 200), camp, campHits: hits.join(' ') };
  }

  /* ---------------- オッズ ---------------- */

  function parseOdds(block) {
    let t = block.body.replace(block.name, ' ');
    const out = {};
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
    return out;
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

    const sm = head.match(/(芝|ダート|ダ|障害)\s?[・･:：]?\s?(?:[(（]?(?:外|内|右|左|直線|外→内|内2周)[)）]?\s?)*(\d{4})\s?m?/);
    if (sm) {
      info.surface = sm[1] === '芝' ? 'turf' : sm[1].startsWith('障') ? undefined : 'dirt';
      info.dist = +sm[2];
    }

    const gm = head.match(/(?:馬場(?:状態)?|芝|ダート?)\s?[:：]?\s?(良|稍重|稍|重|不良|不)(?:馬場)?(?![a-zA-Z一-龠])/) || head.match(/(良|稍重|不良)馬場/);
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
    if (type === 'auto') type = detectType(rawText);
    const known = race.horses.map(h => ({ id: h.id, num: h.num, name: h.name }));
    const blocks = splitBlocks(text, known);
    // ページ見出しのレース条件（距離・コース適性の計算にも使う）
    const raceInfo = parseRaceInfo(text, blocks, (race.date || '').slice(0, 4) || new Date().getFullYear());
    const r2 = { ...race, ...raceInfo };
    const fn = { past: b => parsePast(b, r2), train: parseTrain, comment: parseComment, odds: parseOdds }[type];
    const rows = blocks.map(b => {
      const match = known.find(h => h.name && h.name === b.name) || (b.num && known.find(h => h.num === b.num && (!h.name || !b.name)));
      return { num: b.num ?? match?.num ?? null, name: b.name || match?.name || '', matchId: match?.id || null, data: fn(b) };
    });
    // 同じ馬が複数ブロックに分かれた場合は後勝ちでまとめる
    const merged = [];
    rows.forEach(r => {
      const prev = merged.find(x => (r.name && x.name === r.name) || (!r.name && r.num && x.num === r.num));
      if (prev) Object.assign(prev.data, Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined && v !== null && v !== '')));
      else merged.push(r);
    });
    return { type, label: LABEL[type], rows: merged, raceInfo, raceInfoText: describeRaceInfo(raceInfo) };
  }

  return { analyze, parseRaceInfo, describeRaceInfo, detectType, normalize, splitBlocks, parsePast, parseTrain, parseComment, parseOdds, LABEL };
})();

if (typeof module !== 'undefined') module.exports = KB;
