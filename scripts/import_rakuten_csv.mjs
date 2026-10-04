/**
 * 楽天証券「保有商品一覧（すべて）」CSV（assetbalanceall_*.csv, Shift_JIS）から
 * data/portfolio.json の保有を全面更新する。
 *
 *   node scripts/import_rakuten_csv.mjs <csvファイル> [--data <portfolio.json>] [--date YYYY-MM-DD] [--dry-run]
 *
 * - CSVは保有の完全なスナップショットとして扱い、holdings を置き換える
 * - 既存の商品とは銘柄コード（株）／名称（投信）で照合する
 * - 照合できない商品は新規登録し、分類の確認を促すアラートを立てる
 */
import fs from "node:fs";
import { jstToday, summarize, trimAiLog } from "./lib.mjs";

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--data" && args[args.indexOf(a) - 1] !== "--date");
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dataPath = opt("--data") || new URL("../data/portfolio.json", import.meta.url).pathname;
const asOf = opt("--date") || jstToday();
const dryRun = args.includes("--dry-run");
if (!csvPath) { console.error("使い方: node scripts/import_rakuten_csv.mjs <csv> [--data path] [--date YYYY-MM-DD] [--dry-run]"); process.exit(1); }

const raw = fs.readFileSync(csvPath);
const text = raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? raw.toString("utf8").slice(1) : new TextDecoder("shift_jis").decode(raw);
const rows = text.split(/\r?\n/).map((l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()));
const num = (s) => { const n = Number(String(s ?? "").replace(/[,+円%]/g, "")); return Number.isFinite(n) ? n : null; };
const norm = (s) => String(s || "").normalize("NFKC").replace(/[\s　・･()（）\[\]［］]/g, "").toLowerCase();

const p = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// 参考為替
const usdRow = rows.find((r) => r[0] === "米ドル" && num(r[1]));
if (usdRow) p.fx = { USDJPY: num(usdRow[1]), date: asOf };

const hdr = rows.findIndex((r) => r[0] === "種別" && r.includes("保有数量"));
if (hdr < 0) { console.error("「保有商品詳細」の見出し行が見つかりません。楽天証券の保有商品一覧（すべて）のCSVか確認してください。"); process.exit(1); }
const col = (name) => rows[hdr].indexOf(name);
const C = {
  kind: 0, code: col("銘柄コード・ティッカー"), name: col("銘柄"), acct: col("口座"), qty: col("保有数量"),
  cur: col("現在値"), curUnit: col("現在値") + 1, value: col("時価評価額[円]"), pl: col("評価損益[円]"),
};

const holdings = [], created = [], seen = new Set();
const findProduct = (pred) => p.products.find(pred);
function ensureProduct(def) {
  let prod = findProduct((x) => x.key === def.key);
  if (!prod) { prod = def; p.products.push(prod); created.push(prod); }
  return prod;
}

for (const r of rows.slice(hdr + 1)) {
  if (!r[0] || r.length < 10) { if (holdings.length && !r[0]) break; continue; }
  const kind = r[C.kind], code = r[C.code], name = r[C.name];
  const acct = r[C.acct] === "-" ? "-" : r[C.acct].replace("投資枠", "").replace("NISAつみたて", "NISAつみたて").replace("NISA成長", "NISA成長");
  const qty = num(r[C.qty]), value = num(r[C.value]), pl = num(r[C.pl]) ?? 0, cur = num(r[C.cur]);
  if (value == null) continue;
  const cost = Math.round(value - pl);
  let prod;

  if (kind === "国内株式" || kind === "米国株式") {
    const usd = kind === "米国株式";
    const ticker = usd ? code : `${code}.T`;
    prod = findProduct((x) => x.kind === "stock" && x.ticker === ticker)
      || ensureProduct({ key: `stk_${code.toLowerCase()}`, name, kind: "stock", classKey: "stock", ticker, currency: usd ? "USD" : "JPY", thesis: null, exitRule: null });
    if (cur != null) { prod.price = cur; prod.priceDate = asOf; }
    holdings.push({ productKey: prod.key, account: acct, shares: qty, cost });
  } else if (kind === "投資信託" && /マネーファンド|MRF/.test(name)) {
    prod = ensureProduct({ key: "rakuten_mf", name: "楽天・マネーファンド", kind: "manual", classKey: "cash" });
    holdings.push({ productKey: prod.key, account: acct, valueOverride: value, cost });
  } else if (kind === "投資信託") {
    const n = norm(name);
    prod = findProduct((x) => x.kind === "fund" && (n.startsWith(norm(x.name)) || norm(x.name).startsWith(n) || (x.aliases || []).some((a) => n.includes(norm(a)))));
    if (!prod) {
      prod = ensureProduct({ key: `fund_${created.length + 1}_${asOf.replace(/-/g, "")}`, name, kind: "fund", classKey: null, note: "CSV取り込みで新規登録。分類・協会コード未設定" });
      holdings.push({ productKey: prod.key, account: acct, units: qty, cost, valueOverride: value });
      continue;
    }
    if (cur != null) { prod.price = cur; prod.priceDate = asOf; }
    holdings.push({ productKey: prod.key, account: acct, units: qty, cost });
  } else if (kind === "国内債券") {
    // 個人向け国債（額面・元本保証）は安全資産、それ以外の利付国債（新窓販など、時価評価）は国内国債（固定）
    const kojin = /個人/.test(name);
    const m = name.match(/第\s*(\d+)\s*回/);
    const key = (kojin ? "jgb" : "jgbfix") + (m ? m[1] : "_" + asOf.replace(/-/g, ""));
    prod = findProduct((x) => x.key === key)
      || ensureProduct({ key, name: name.replace(/個人国債/, "個人向け国債").replace(/\s+/g, " "), kind: "manual", classKey: kojin ? "safe" : "jgbFix", note: kojin ? "額面評価" : "時価評価（満期保有で利回り確定）" });
    holdings.push({ productKey: prod.key, account: acct, valueOverride: value, cost });
  } else if (kind === "外貨預り金") {
    prod = ensureProduct({ key: "cash_usd", name: "米ドル預り金", kind: "manual", classKey: "cash" });
    holdings.push({ productKey: prod.key, account: "-", valueOverride: value, cost: value });
  } else if (kind === "金・プラチナ") {
    prod = findProduct((x) => x.kind === "gold_jpyg")
      || ensureProduct({ key: "gold_physical", name: "金（現物・グラム建て）", kind: "gold_jpyg", classKey: "gold" });
    if (cur != null) { prod.price = cur; prod.priceDate = asOf; }
    holdings.push({ productKey: prod.key, account: "-", grams: qty, cost });
  } else {
    console.warn(`未対応の種別をスキップ: ${kind} ${name}`);
    continue;
  }
  seen.add(prod.key);
}

// 同一商品・同一口座は合算
const merged = [];
for (const h of holdings) {
  const ex = merged.find((x) => x.productKey === h.productKey && x.account === h.account);
  if (!ex) { merged.push({ ...h }); continue; }
  for (const k of ["units", "shares", "grams", "cost", "valueOverride"]) if (h[k] != null) ex[k] = (ex[k] || 0) + h[k];
}

// 円の預り金（資産合計欄）。売却代金はここに入るため、保有に含めて評価額の連続性を保つ
const jpyCashRow = rows.find((r) => r[0] === "預り金" && num(r[1]) != null);
const jpyCash = jpyCashRow ? num(jpyCashRow[1]) : 0;
if (jpyCash > 0) {
  ensureProduct({ key: "cash_jpy", name: "円預り金", kind: "manual", classKey: "cash" });
  merged.push({ productKey: "cash_jpy", account: "-", valueOverride: jpyCash, cost: jpyCash });
  seen.add("cash_jpy");
}

// 入出金（フロー）＝ 新しい保有の評価額 − 以前の保有を今回の価格で評価した額
// 売却して預り金に残る分はフロー0、新たに入金して買った分だけがフローになる
const before = summarize(p);
const prevKeys = new Set(p.holdings.map((h) => h.productKey));
p.holdings = merged;
p.holdingsAsOf = asOf;
const after = summarize(p);
const flow = Math.round(after.total - before.total);
const snap = { date: asOf, total: Math.round(after.total), cost: Math.round(after.cost), flow, byClass: {} };
for (const [k, v] of Object.entries(after.byClass)) snap.byClass[k] = Math.round(v);
const same = (p.history || []).find((x) => x.date === asOf);
if (same) snap.flow += same.flow || 0;
p.history = (p.history || []).filter((x) => x.date !== asOf).concat(snap).sort((a, b) => (a.date < b.date ? -1 : 1));

const removed = [...prevKeys].filter((k) => !seen.has(k)).map((k) => p.products.find((x) => x.key === k)?.name || k);
const added = [...seen].filter((k) => !prevKeys.has(k)).map((k) => p.products.find((x) => x.key === k)?.name || k);

for (const prod of created) {
  p.alerts = p.alerts || [];
  p.alerts.push({ id: `verify:new:${prod.key}`, date: asOf, level: "warn", status: "open",
    message: `【要確認】CSV取り込みで新しい商品「${prod.name}」を登録しました。${prod.classKey ? "" : "資産クラスが未設定のため配分計算から外れています。"}Claudeが分類と価格取得の設定を行います。` });
}

const msg = `楽天証券CSV（${asOf}）から保有を更新: ${merged.length}件、評価額 ¥${Math.round(after.total).toLocaleString("ja-JP")}（取得額 ¥${Math.round(after.cost).toLocaleString("ja-JP")}）。` +
  (removed.length ? `売却済み: ${removed.join("、")}。` : "") + (added.length ? `新規: ${added.join("、")}。` : "");
p.aiLog = trimAiLog((p.aiLog || []).concat({ date: asOf, actor: "claude", message: msg }));

console.log(msg);
console.log(`評価額 ${Math.round(before.total).toLocaleString()} → ${Math.round(after.total).toLocaleString()}（入出金として記録: ${flow.toLocaleString()}円、価格未取得 ${p.holdings.length - after.valued} 件）`);
if (Math.abs(flow) > 0) console.log("※ 入出金の額が想定（新規入金額）と違う場合は、売却済み商品の価格が古い可能性があります。");
if (created.length) console.log("新規登録:", created.map((x) => `${x.key} ${x.name}`).join(" / "));
if (!dryRun) fs.writeFileSync(dataPath, JSON.stringify(p, null, 2) + "\n");
