/**
 * ポートフォリオ自動更新スクリプト（GitHub Actions で平日朝に実行）
 *
 * 1. 価格取得
 *    - 投資信託: 投信総合検索ライブラリー（投資信託協会）の時系列CSV
 *    - 株式:     Yahoo Finance chart API（"8306.T" / "ETN" 形式、USD建ては USDJPY で円換算）
 *    - 金現物:   GC=F × USDJPY ÷ 31.1035（円/g）
 * 2. 評価額・クラス別配分を計算し、history に日次スナップショットを追記
 * 3. 移行プランのステップを保有状況から自動完了判定
 * 4. 投資ルール v2（docs/project-v2.md 第7節）に基づくアラートの生成・自動クローズ
 *
 * 依存パッケージなし（Node 20+）。
 */
import fs from "node:fs";
import { jstToday, productOf, holdingValue, summarize, stepAutoDone, trimAiLog } from "./lib.mjs";

const PATH = new URL("../data/portfolio.json", import.meta.url).pathname;
const p = JSON.parse(fs.readFileSync(PATH, "utf8"));
const today = jstToday();
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
  const date = ts ? new Date(ts * 1000 + 9 * 3600e3).toISOString().slice(0, 10) : today;
  return { date, price };
}

let ok = 0, ng = 0;
try {
  const fx = await yahooLast("JPY=X");
  p.fx = { USDJPY: Math.round(fx.price * 100) / 100, date: fx.date };
  log(`USDJPY: ${p.fx.USDJPY} (${fx.date})`);
} catch (e) {
  log(`NG USDJPY: ${e.message}（前回値 ${p.fx?.USDJPY} を維持）`);
}

const held = new Set(p.holdings.map((h) => h.productKey));
for (const prod of p.products) {
  // 保有中か購入対象の商品だけ取得する（売却済みの個別株などは取得しない）
  if (!held.has(prod.key) && !prod.buyTarget) continue;
  try {
    let r;
    if (prod.kind === "fund") r = await fetchFundNav(prod);
    else if (prod.kind === "stock") r = await yahooLast(prod.ticker);
    else if (prod.kind === "gold_jpyg") {
      const oz = await yahooLast("GC=F");
      if (!Number.isFinite(p.fx?.USDJPY)) throw new Error("USDJPY 未取得");
      r = { date: oz.date, price: Math.round(((oz.price * p.fx.USDJPY) / 31.1034768) * 100) / 100 };
    } else continue;
    prod.price = r.price;
    prod.priceDate = r.date;
    ok++;
    log(`${prod.name}: ${r.price} (${r.date})`);
  } catch (e) {
    ng++;
    log(`NG ${prod.name}: ${e.message}（前回値を維持）`);
  }
}

/* ---------- 自動積立の推定反映 ----------
 * 毎月の積立は買付日の基準価額で口数を推定して保有に加え、入出金(flow)として記録する。
 * 次の楽天CSV取り込みで実数に置き換わる。 */
let recurringFlow = 0;
for (const r of p.recurring || []) {
  const ym = today.slice(0, 7);
  if (r.lastApplied >= ym || Number(today.slice(8, 10)) < r.day) continue;
  const prod = productOf(p, r.productKey);
  if (!prod || !Number.isFinite(prod.price)) { log(`積立の推定反映をスキップ（価格なし）: ${r.productKey}`); continue; }
  let h = p.holdings.find((x) => x.productKey === r.productKey && x.account === r.account);
  if (!h) { h = { productKey: r.productKey, account: r.account, units: 0, cost: 0 }; p.holdings.push(h); }
  const units = Math.floor((r.yen / prod.price) * 10000);
  h.units = (h.units || 0) + units;
  h.cost = (h.cost || 0) + r.yen;
  h.estimated = true;
  r.lastApplied = ym;
  recurringFlow += r.yen;
  if (p.nisa?.usedThisYear && r.account.startsWith("NISA") && p.nisa.usedThisYear.year === Number(today.slice(0, 4))) {
    const k = r.account === "NISAつみたて" ? "tsumitate" : "growth";
    if (p.nisa.usedThisYear[k] != null) p.nisa.usedThisYear[k] += r.yen;
  }
  if (p.nisa && r.account.startsWith("NISA") && p.nisa.usedLifetime != null) p.nisa.usedLifetime += r.yen;
  log(`積立を推定反映: ${prod.name} ${r.yen}円 → ${units}口（${r.account}）`);
}

/* ---------- 評価 ---------- */
const s = summarize(p);
if (s.complete && s.total > 0) {
  // flow は入出金（CSV取り込み時に記録）。同日の記録があれば引き継ぐ
  const prev = (p.history || []).find((x) => x.date === today);
  const snap = { date: today, total: Math.round(s.total), cost: Math.round(s.cost), flow: (prev?.flow || 0) + recurringFlow, byClass: {} };
  for (const [k, v] of Object.entries(s.byClass)) snap.byClass[k] = Math.round(v);
  p.history = (p.history || []).filter((x) => x.date !== today);
  p.history.push(snap);
  if (p.history.length > 1500) p.history = p.history.slice(-1500);
} else {
  log(`保有 ${p.holdings.length} 件中 ${s.valued} 件しか評価できないため、履歴の更新をスキップ`);
}

/* ---------- 移行プランの自動完了 ---------- */
for (const st of p.plan?.steps || []) {
  if (st.status !== "done" && stepAutoDone(p, st)) {
    st.status = "done";
    st.doneDate = today;
    log(`計画ステップ完了: ${st.id} ${st.title}`);
  }
}

/* ---------- アラート ---------- */
const alerts = p.alerts || [];
const raised = new Set();
const MANAGED = ["drift:", "cap:", "ban:", "review:", "floor:", "tax:", "plan:"];
function raise(id, level, message) {
  raised.add(id);
  const ex = alerts.find((a) => a.id === id && a.status === "open");
  if (ex) { ex.level = level; ex.message = message; ex.updated = today; return; }
  alerts.push({ id, date: today, level, message, status: "open" });
}
const yen = (n) => (n < 0 ? "-¥" : "¥") + Math.abs(Math.round(n)).toLocaleString("ja-JP");
const pol = p.policy;
const openSteps = (p.plan?.steps || []).filter((x) => x.status !== "done");
const STOCK_STEPS = ["stocksHaveThesis", "plannedSellsDone"];
const stepsForClass = (ck) =>
  openSteps.filter((x) =>
    (x.auto?.productKey && productOf(p, x.auto.productKey)?.classKey === ck) ||
    x.auto?.classKey === ck ||
    (ck === "stock" && STOCK_STEPS.includes(x.auto?.type)));

if (s.complete && s.total > 0) {
  const T = s.total;

  // R8 ドリフト
  for (const c of p.assetClasses) {
    if (c.excludeFromDrift) continue;
    const w = ((s.byClass[c.key] || 0) / T) * 100;
    const d = w - c.targetPct;
    if (Math.abs(d) <= pol.rebalanceBandPct) continue;
    const amt = (Math.abs(d) / 100) * T;
    const steps = stepsForClass(c.key);
    const how = d > 0 ? "積立・新規購入を止めて比率を下げる" : "新規資金・積立をこのクラスへ優先して入れる";
    const msg = `【配分】${c.name} が ${w.toFixed(1)}%（基本配分 ${c.targetPct}%、${d > 0 ? "+" : ""}${d.toFixed(1)}pt）。約 ${yen(amt)} 分のズレ。${how}。` +
      (steps.length ? `移行プランで対応中（${steps.map((x) => x.id).join("・")}）。` : "");
    raise(`drift:${c.key}`, steps.length ? "info" : "action", msg);
  }

  // R1 レバレッジ
  for (const prod of p.products.filter((x) => x.leveraged && held.has(x.key))) {
    const v = s.byProduct[prod.key] || 0;
    raise(`ban:leverage:${prod.key}`, "action",
      `【ルールR1違反】${prod.name}（${yen(v)}、実効 ${yen(v * prod.leveraged)} 相当）を保有中。レバレッジ商品は持たないルール。${prod.note || ""}`);
  }

  // R2 個別株の上限
  const stockW = ((s.byKind.stock || 0) / T) * 100;
  if (stockW > pol.maxStockWeightPct) {
    raise("cap:stock", "action",
      `【ルールR2】個別株が合計 ${stockW.toFixed(1)}%（上限 ${pol.maxStockWeightPct}%）。約 ${yen(((stockW - pol.maxStockWeightPct) / 100) * T)} の超過。新規の個別株購入は停止。`);
  }
  for (const prod of p.products.filter((x) => x.kind === "stock" && held.has(x.key))) {
    const w = ((s.byProduct[prod.key] || 0) / T) * 100;
    if (pol.maxSingleStockPct && w > pol.maxSingleStockPct)
      raise(`cap:single:${prod.key}`, "action", `【ルールR2】${prod.name} が1銘柄で ${w.toFixed(1)}%（上限 ${pol.maxSingleStockPct}%）。`);
  }

  // R3 個別株の見直しライン
  for (const h of p.holdings) {
    const prod = productOf(p, h.productKey);
    if (prod?.kind !== "stock" || !h.cost) continue;
    const v = holdingValue(p, h);
    const pct = ((v - h.cost) / h.cost) * 100;
    if (pct > -pol.stockReviewDrawdownPct) continue;
    const planned = prod.planned === "sell" || prod.planned === "review";
    raise(`review:dd:${prod.key}`, planned ? "info" : "warn",
      `【ルールR3】${prod.name} が取得価格から ${pct.toFixed(1)}%（${yen(v - h.cost)}）。` +
      (planned ? (prod.planned === "sell" ? "移行プランで売却予定。" : "移行プランで残すかどうか選別中（s07）。") : `見直しライン -${pol.stockReviewDrawdownPct}% に到達。買った理由が崩れていないか確認し、崩れていれば売却。` +
        (prod.exitRule ? `撤退条件:「${prod.exitRule}」` : "撤退条件が未記録。")));
  }

  // R9 安全資産の下限
  const safeW = (((s.byClass.safe || 0) + (s.byClass.cash || 0)) / T) * 100;
  if (safeW < pol.minSafeWeightPct)
    raise("floor:safe", "warn", `【ルールR9】安全資産（国債・現金）が ${safeW.toFixed(1)}%（下限 ${pol.minSafeWeightPct}%）。個人向け国債の購入を検討。`);
  const liqW = ((s.byClass.cash || 0) / T) * 100;
  if (pol.minLiquidPct && liqW < pol.minLiquidPct)
    raise("floor:liquid", "info", `【ルールR9】すぐ動かせる現金等が ${liqW.toFixed(1)}%（目安 ${pol.minLiquidPct}%以上）。個人向け国債は発行後1年は換金できないため、急な出費や下落時の買い増し用に現金を残す。`);

  // R4 年末の損出し
  const month = Number(today.slice(5, 7));
  if ((pol.taxHarvestMonths || []).includes(month)) {
    const losers = p.holdings
      .filter((h) => h.account === "特定" && h.cost && !["gold_jpyg", "manual"].includes(productOf(p, h.productKey)?.kind) && !productOf(p, h.productKey)?.leveraged)
      .map((h) => ({ h, pl: holdingValue(p, h) - h.cost }))
      .filter((x) => x.pl < -1000);
    if (losers.length) {
      const sum = losers.reduce((a, x) => a + x.pl, 0);
      raise(`tax:harvest:${today.slice(0, 4)}`, month === 12 ? "warn" : "info",
        `【ルールR4】特定口座に含み損 ${yen(sum)}（${losers.map((x) => productOf(p, x.h.productKey).name).join("、")}）。今年の特定口座に実現益（配当を含む）があれば、年内（受渡ベース）に確定して最大 約${yen(-sum * 0.20315)} の税金が戻る。残したい銘柄は売って翌営業日以降に買い戻せる。国内株は12/28約定、米国株・海外資産の投信は12月中旬が目安。通算しきれない分は確定申告で3年繰越。`);
    }
  }
}

// 移行プランの期限
for (const st of openSteps) {
  if (!st.due) continue;
  const days = (new Date(st.due) - new Date(today)) / 86400e3;
  if (days < 0) raise(`plan:overdue:${st.id}`, "action", `【移行プラン・期限超過】${st.title}（期限 ${st.due}）。${st.detail || ""}`);
  else if (days <= 7) raise(`plan:soon:${st.id}`, st.urgent ? "action" : "info", `【移行プラン・今週】${st.title}（期限 ${st.due}、あと${Math.round(days)}日）。${st.detail || ""}`);
}

// 週次レビューの停止検知
const lastClaude = [...(p.aiLog || [])].reverse().find((l) => l.actor === "claude");
const staleDays = lastClaude ? (new Date(today) - new Date(lastClaude.date)) / 86400e3 : Infinity;
if (staleDays > (pol.reviewStaleDays || 9))
  raise("review:stale", "warn",
    `【体制】Claudeの週次レビュー記録が ${Number.isFinite(staleDays) ? Math.round(staleDays) + "日" : "一度も"}途絶えています（最終 ${lastClaude?.date || "なし"}）。Routine の稼働を確認してください。`);

// 定期点検（1月・7月）
const ym = today.slice(0, 7);
if ((pol.regularRebalanceMonths || []).includes(Number(today.slice(5, 7))) && !alerts.some((a) => a.id === `regular-check:${ym}`)) {
  alerts.push({ id: `regular-check:${ym}`, date: today, level: "info", status: "open",
    message: `【定期点検】半年に1回の点検月です（${ym}）。配分・前提・リスク許容度・NISA枠を確認。` });
}

// 今回発生しなかった管理対象アラートは自動クローズ
for (const a of alerts) {
  if (a.status === "open" && MANAGED.some((m) => a.id.startsWith(m)) && !raised.has(a.id)) {
    a.status = "done";
    a.closedDate = today;
  }
}
p.alerts = alerts.filter((a) => a.status === "open").concat(alerts.filter((a) => a.status !== "open").slice(-60));

/* ---------- ログと保存 ---------- */
const openActions = p.alerts.filter((a) => a.status === "open" && a.level === "action").length;
p.lastUpdated = new Date().toISOString();
p.aiLog = trimAiLog((p.aiLog || []).concat({
  date: today,
  actor: "github-actions",
  message: `価格を自動更新（成功 ${ok} / 失敗 ${ng}）。評価額合計 ${s.total > 0 ? yen(s.total) : "—"}。要対応アラート ${openActions} 件。`,
}));

fs.writeFileSync(PATH, JSON.stringify(p, null, 2) + "\n");
log(`完了: 価格 ${ok}件成功 / ${ng}件失敗, 評価額合計 ${Math.round(s.total)}`);
if (ok === 0 && p.products.length > 0) {
  console.error("すべての価格取得に失敗しました");
  process.exit(1);
}
