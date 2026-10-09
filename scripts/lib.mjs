/** 評価・集計の共通処理（update_portfolio.mjs と import_rakuten_csv.mjs で共用） */

export function jstToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

export function productOf(p, key) {
  return p.products.find((x) => x.key === key);
}

// 円建て評価額。価格未取得なら null
export function holdingValue(p, h) {
  if (Number.isFinite(h.valueOverride)) return h.valueOverride;
  const prod = productOf(p, h.productKey);
  if (!prod || !Number.isFinite(prod.price)) return null;
  if (prod.kind === "fund") return ((h.units || 0) / 10000) * prod.price; // 基準価額は1万口あたり
  if (prod.kind === "gold_jpyg") return (h.grams || 0) * prod.price;
  if (prod.kind === "stock") {
    const fx = prod.currency === "USD" ? p.fx?.USDJPY : 1;
    if (!Number.isFinite(fx)) return null;
    return (h.shares || 0) * prod.price * fx;
  }
  return null;
}

export function summarize(p) {
  const byClass = {}, byProduct = {}, byKind = {};
  let total = 0, cost = 0, valued = 0;
  for (const h of p.holdings) {
    const v = holdingValue(p, h);
    if (v == null) continue;
    const prod = productOf(p, h.productKey);
    const ck = prod?.classKey || "other";
    byClass[ck] = (byClass[ck] || 0) + v;
    byProduct[h.productKey] = (byProduct[h.productKey] || 0) + v;
    byKind[prod?.kind || "other"] = (byKind[prod?.kind || "other"] || 0) + v;
    total += v;
    cost += h.cost || 0;
    valued++;
  }
  return { byClass, byProduct, byKind, total, cost, valued, complete: valued === p.holdings.length };
}

// account は文字列か配列（NISAつみたての自動積立をまとめ買いと区別するため）
export function costOf(p, productKey, account) {
  const ok = (a) => !account || (Array.isArray(account) ? account.includes(a) : a === account);
  // 積立の推定反映分（estimatedCost）は、楽天CSVで実数に置き換わるまで数えない
  return p.holdings
    .filter((h) => h.productKey === productKey && ok(h.account))
    .reduce((s, h) => s + Math.max(0, (h.cost || 0) - (h.estimatedCost || 0)), 0);
}

// 計画ステップの自動完了判定
export function stepAutoDone(p, step) {
  const a = step.auto;
  if (!a) return false;
  if (a.type === "noHolding")
    return !p.holdings.some((h) => h.productKey === a.productKey && (!a.account || h.account === a.account));
  if (a.type === "costAtLeast") return costOf(p, a.productKey, a.account) >= a.yen;
  if (a.type === "classCostAtLeast")
    return p.holdings.filter((h) => productOf(p, h.productKey)?.classKey === a.classKey).reduce((s, h) => s + Math.max(0, (h.cost || 0) - (h.estimatedCost || 0)), 0) >= a.yen;
  const held = new Set(p.holdings.map((h) => h.productKey));
  const heldStocks = p.products.filter((x) => x.kind === "stock" && held.has(x.key));
  // 残す銘柄が決まり（選別中が無い）、残す銘柄すべてに理由と撤退条件がある
  if (a.type === "stocksHaveThesis")
    return heldStocks.every((x) => x.planned !== "review") &&
      heldStocks.filter((x) => x.planned !== "sell").every((x) => x.thesis && x.exitRule);
  // 売却と決めた銘柄をすべて売り終えた（選別中が残っていれば未完了）
  if (a.type === "plannedSellsDone")
    return !p.products.some((x) => held.has(x.key) && (x.planned === "sell" || x.planned === "review"));
  return false;
}

// aiLog は Claude の記録を優先して残す（日次の自動記録で押し出されないように）
export function trimAiLog(log, keepClaude = 50, keepOthers = 40) {
  const claudeIdx = log.map((l, i) => (l.actor === "claude" ? i : -1)).filter((i) => i >= 0).slice(-keepClaude);
  const otherIdx = log.map((l, i) => (l.actor !== "claude" ? i : -1)).filter((i) => i >= 0).slice(-keepOthers);
  const keep = new Set([...claudeIdx, ...otherIdx]);
  return log.filter((_, i) => keep.has(i));
}

/* ---------- 期待リターンとリスク（計画書・ダッシュボード共通） ----------
 * assetClasses[].geoReturnPct は「複利（幾何）リターン」の前提。
 * 算術 = 複利 + σ²/2、ポートフォリオの複利の中心 = Σw・算術 − σp²/2
 */
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return 0.5 * (1 + (z >= 0 ? y : -y));
}

export function portfolioStats(p, weights) {
  const cls = p.assetClasses || [];
  const C = p.correlations || {};
  const corr = (a, b) => (a === b ? 1 : (C[a] || {})[b] ?? (C[b] || {})[a] ?? 0);
  let arith = 0, v = 0, fx = 0, stress = 0, equity = 0;
  for (const a of cls) {
    const wa = weights[a.key] || 0;
    arith += wa * (a.geoReturnPct + a.riskPct ** 2 / 200);
    fx += wa * (a.fxShare || 0) * 100;
    stress += wa * (a.stressPct || 0);
    if (a.equity) equity += wa * 100;
    for (const b of cls) v += wa * (weights[b.key] || 0) * a.riskPct * b.riskPct * corr(a.key, b.key);
  }
  const sd = Math.sqrt(Math.max(v, 0));
  const geo = arith - sd * sd / 200;
  return {
    geo, arith, sd, fx, stress, equity,
    pLoss10: normCdf((-10 - arith) / (sd || 1e-9)),                  // 単年で-10%を超えて負ける確率
    p10y5: 1 - normCdf((5 - geo) / ((sd || 1e-9) / Math.sqrt(10))),  // 10年の複利平均が5%以上になる確率
  };
}

// 保有からクラス別の実効ウェイト（レバレッジ商品は倍率分を株式に、差額を借入として待機資金から控除）
export function effectiveWeights(p) {
  const s = summarize(p);
  const w = {};
  for (const [k, v] of Object.entries(s.byClass)) w[k] = v / (s.total || 1);
  for (const h of p.holdings) {
    const prod = productOf(p, h.productKey);
    if (!prod?.leveraged) continue;
    const v = holdingValue(p, h) || 0;
    w[prod.classKey] = (w[prod.classKey] || 0) + (v * (prod.leveraged - 1)) / s.total;
    w.cash = (w.cash || 0) - (v * (prod.leveraged - 1)) / s.total;
  }
  return w;
}
