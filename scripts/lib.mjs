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

export function costOf(p, productKey, account) {
  return p.holdings
    .filter((h) => h.productKey === productKey && (!account || h.account === account))
    .reduce((s, h) => s + (h.cost || 0), 0);
}

// 計画ステップの自動完了判定
export function stepAutoDone(p, step) {
  const a = step.auto;
  if (!a) return false;
  if (a.type === "noHolding")
    return !p.holdings.some((h) => h.productKey === a.productKey && (!a.account || h.account === a.account));
  if (a.type === "costAtLeast") return costOf(p, a.productKey) >= a.yen;
  if (a.type === "stocksHaveThesis") {
    const held = new Set(p.holdings.map((h) => h.productKey));
    return p.products
      .filter((x) => x.kind === "stock" && held.has(x.key) && x.planned !== "sell")
      .every((x) => x.thesis && x.exitRule);
  }
  return false;
}

// aiLog は Claude の記録を優先して残す（日次の自動記録で押し出されないように）
export function trimAiLog(log, keepClaude = 50, keepOthers = 40) {
  const claudeIdx = log.map((l, i) => (l.actor === "claude" ? i : -1)).filter((i) => i >= 0).slice(-keepClaude);
  const otherIdx = log.map((l, i) => (l.actor !== "claude" ? i : -1)).filter((i) => i >= 0).slice(-keepOthers);
  const keep = new Set([...claudeIdx, ...otherIdx]);
  return log.filter((_, i) => keep.has(i));
}
