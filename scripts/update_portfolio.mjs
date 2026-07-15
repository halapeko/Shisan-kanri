/**
 * ポートフォリオ自動更新スクリプト（GitHub Actions で定期実行）
 *
 * 1. data/portfolio.json の各商品の最新価格を取得
 *    - 投資信託: 投信総合検索ライブラリー（投資信託協会）の時系列CSV
 *    - 株式:     Yahoo Finance chart API（ticker は "7203.T" 形式）
 * 2. 保有の評価額・クラス別配分を計算して history に日次スナップショットを追記
 * 3. 投資ルールに基づきアラートを生成・自動クローズ
 *    - 基本配分から3%超のドリフト
 *    - 個別株30%超 / 投信70%未満
 *    - 半年に1回（1月・7月）の定期リバランス点検
 *
 * 依存パッケージなし（Node 20+）。
 */
import fs from "node:fs";

const PATH = new URL("../data/portfolio.json", import.meta.url).pathname;
const p = JSON.parse(fs.readFileSync(PATH, "utf8"));
const today = new Date().toISOString().slice(0, 10);
const log = (m) => console.log(`[update] ${m}`);

/* ---------- 価格取得 ---------- */
async function fetchFundNav(prod) {
  const url =
    "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download" +
    `?isinCd=${prod.isin}&associFundCd=${prod.assocCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = new TextDecoder("shift_jis").decode(await res.arrayBuffer());
  let best = null;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(",").map((s) => s.replace(/["\s]/g, ""));
    // 日付は「2026年07月14日」「2026/07/14」等。文字化けにも耐えるよう区切りは非数字を許容
    const m = cols[0]?.match(/^(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})\D{0,3}$/);
    if (!m) continue;
    const nav = Number(cols[1]);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    if (!best || date > best.date) best = { date, price: nav };
  }
  if (!best) throw new Error("CSVから基準価額を読み取れませんでした");
  return best;
}

async function yahooLast(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    "?range=5d&interval=1d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description || "chart API 応答が不正");
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  const price = closes.at(-1) ?? r.meta?.regularMarketPrice;
  if (!Number.isFinite(price)) throw new Error("終値を取得できませんでした");
  const ts = r.meta?.regularMarketTime;
  const date = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : today;
  return { date, price };
}

const fetchStockPrice = (prod) => yahooLast(prod.ticker);

// 金現物の円/g概算: 国際スポット(USD/トロイオンス) × USDJPY ÷ 31.1035
// （×1.1の消費税調整は行わない。ユーザーの口座残高表示がスポット税抜相当のため — 初回実行の照合で確認済み）
async function fetchGoldJpyPerGram() {
  const oz = await yahooLast("GC=F");
  const fx = await yahooLast("JPY=X");
  const price = (oz.price * fx.price) / 31.1034768;
  return { date: oz.date, price: Math.round(price * 100) / 100 };
}

let ok = 0, ng = 0;
for (const prod of p.products) {
  try {
    let r;
    if (prod.kind === "fund") r = await fetchFundNav(prod);
    else if (prod.kind === "stock") r = await fetchStockPrice(prod);
    else if (prod.kind === "gold_jpyg") r = await fetchGoldJpyPerGram();
    else { log(`SKIP ${prod.name}（手動評価）`); continue; }
    prod.price = r.price;
    prod.priceDate = r.date;
    ok++;
    log(`${prod.name}: ${r.price} (${r.date})`);
  } catch (e) {
    ng++;
    log(`NG ${prod.name}: ${e.message}（前回値を維持）`);
  }
}

/* ---------- 評価額の計算 ---------- */
// holdings: { productKey, account, units(投信:口数) | shares(株式:株数) | grams(金現物:g),
//             cost(取得額合計円), valueOverride?(額面評価などの直接指定) }
function holdingValue(h) {
  if (Number.isFinite(h.valueOverride)) return h.valueOverride;
  const prod = p.products.find((x) => x.key === h.productKey);
  if (!prod || !Number.isFinite(prod.price)) return null;
  if (prod.kind === "fund") return ((h.units || 0) / 10000) * prod.price; // 基準価額は1万口あたり
  if (prod.kind === "gold_jpyg") return (h.grams || 0) * prod.price;
  return (h.shares || 0) * prod.price;
}

const byClass = {};
const byKind = {};
let total = 0, cost = 0, valued = 0;
for (const h of p.holdings) {
  const v = holdingValue(h);
  if (v == null) continue;
  const prod = p.products.find((x) => x.key === h.productKey);
  const ck = prod?.classKey || "other";
  byClass[ck] = (byClass[ck] || 0) + v;
  byKind[prod?.kind || "other"] = (byKind[prod?.kind || "other"] || 0) + v;
  total += v;
  cost += h.cost || 0;
  valued++;
}

// 一部の価格取得に失敗して評価額が欠けると誤ったドリフト判定になるため、
// 全保有が評価できた時のみ履歴記録・アラート判定を行う
const fullyValued = p.holdings.length > 0 && valued === p.holdings.length;

if (fullyValued) {
  const snap = { date: today, total: Math.round(total), cost: Math.round(cost), byClass: {} };
  for (const [k, v] of Object.entries(byClass)) snap.byClass[k] = Math.round(v);
  p.history = (p.history || []).filter((s) => s.date !== today);
  p.history.push(snap);
  if (p.history.length > 1500) p.history = p.history.slice(-1500);
} else if (p.holdings.length > 0) {
  log(`保有 ${p.holdings.length} 件中 ${valued} 件しか評価できないため、履歴・アラートの更新をスキップ`);
}

/* ---------- アラート判定 ---------- */
const alerts = p.alerts || [];
function upsertAlert(id, level, message) {
  const ex = alerts.find((a) => a.id === id && a.status === "open");
  if (ex) { ex.date = today; ex.message = message; ex.level = level; return; }
  alerts.push({ id, date: today, level, message, status: "open" });
}
function closeAlert(id) {
  for (const a of alerts) if (a.id === id && a.status === "open") { a.status = "done"; a.closedDate = today; }
}
const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");

if (fullyValued && total > 0) {
  const band = p.policy.rebalanceBandPct;
  for (const c of p.assetClasses) {
    const w = ((byClass[c.key] || 0) / total) * 100;
    const drift = w - c.targetPct;
    const id = `drift:${c.key}`;
    if (Math.abs(drift) > band) {
      const amount = (Math.abs(drift) / 100) * total;
      const dir = drift > 0 ? "売り（または積立停止）" : "買い増し（積立配分の増額）";
      upsertAlert(id, "action",
        `【リバランス】${c.name} が基本配分 ${c.targetPct}% に対し ${w.toFixed(1)}%（${drift > 0 ? "+" : ""}${drift.toFixed(1)}pt）。約 ${yen(amount)} の${dir}で基本配分に戻せます。原則は売却せず、毎月の積立配分の調整で対応。`);
    } else {
      closeAlert(id);
    }
  }
  // 比率ルールは資産クラスではなく商品種別で判定する
  // （日本株式クラスでも投資信託(Tracers等)は投信7割側にカウント）
  const stockW = ((byKind["stock"] || 0) / total) * 100;
  if (stockW > p.policy.maxStockWeightPct) {
    upsertAlert("cap:stock", "action",
      `【上限超過】個別株比率が ${stockW.toFixed(1)}% となり上限 ${p.policy.maxStockWeightPct}% を超えています。新規の個別株購入を停止し、投信側の積立で希釈してください。`);
  } else {
    closeAlert("cap:stock");
  }
  const fundW = ((byKind["fund"] || 0) / total) * 100;
  if (fundW < p.policy.minFundWeightPct) {
    upsertAlert("floor:fund", "warn",
      `【配分注意】投資信託比率が ${fundW.toFixed(1)}% と、方針の ${p.policy.minFundWeightPct}% を下回っています。`);
  } else {
    closeAlert("floor:fund");
  }
}

const month = Number(today.slice(5, 7));
const ym = today.slice(0, 7);
if ((p.policy.regularRebalanceMonths || []).includes(month)) {
  const id = `regular-check:${ym}`;
  if (!alerts.some((a) => a.id === id)) {
    alerts.push({ id, date: today, level: "info", status: "open",
      message: `【定期点検】半年に1回のリバランス点検月です（${ym}）。配分・リスク許容度・NISA枠の消化状況を確認してください。` });
  }
}
p.alerts = alerts.slice(-100);

/* ---------- ログと保存 ---------- */
p.lastUpdated = new Date().toISOString();
p.aiLog = (p.aiLog || []).concat({
  date: today,
  actor: "github-actions",
  message: `価格を自動更新（成功 ${ok} / 失敗 ${ng}）。評価額合計 ${total > 0 ? yen(total) : "—（保有未登録）"}。未対応アラート ${p.alerts.filter((a) => a.status === "open" && a.level !== "info").length} 件。`,
}).slice(-60);

fs.writeFileSync(PATH, JSON.stringify(p, null, 2) + "\n");
log(`完了: 価格 ${ok}件成功 / ${ng}件失敗, 評価額合計 ${Math.round(total)}`);
if (ok === 0 && p.products.length > 0) {
  console.error("すべての価格取得に失敗しました");
  process.exit(1);
}
