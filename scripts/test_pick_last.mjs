/** pickLast の場合分けテスト：node scripts/test_pick_last.mjs（外部接続なし） */
import assert from "node:assert/strict";
import { pickLast } from "./lib.mjs";

const Z = (s) => Date.parse(s) / 1000;
const bars = (items) => ({ timestamp: items.map(([t]) => Z(t)), indicators: { quote: [{ close: items.map(([, c]) => c) }] } });

// 1. 金先物（2026-10-30 実行時の実データ形）：取引所の暦日バーは取引中扱いになるが、最新気配を使うので1日遅れない
{
  const r = { ...bars([["2026-10-28T04:00Z", 4051.6], ["2026-10-29T04:00Z", 4031.4], ["2026-10-30T04:00Z", 3884.9]]),
    meta: { symbol: "GC=F", instrumentType: "FUTURE", gmtoffset: -14400, regularMarketPrice: 3880.2, regularMarketTime: Z("2026-10-30T20:59Z"),
      currentTradingPeriod: { regular: { start: Z("2026-10-30T04:00Z"), end: Z("2026-10-31T03:59Z") } } } };
  const x = pickLast(r, Z("2026-10-30T23:07Z"));
  assert.equal(x.price, 3880.2); assert.equal(x.date, "2026-10-30"); assert.equal(x.mode, "quote");
}
// 2. 為替（平日JST 9:40＝UTC 0:40）：最新気配、日付は取引所の現地日付
{
  const r = { ...bars([["2026-10-28T23:00Z", 157.1], ["2026-10-29T23:00Z", 157.7]]),
    meta: { symbol: "JPY=X", instrumentType: "CURRENCY", gmtoffset: 3600, regularMarketPrice: 157.9, regularMarketTime: Z("2026-10-30T00:38Z"),
      currentTradingPeriod: { regular: { start: Z("2026-10-29T23:00Z"), end: Z("2026-10-30T22:59Z") } } } };
  const x = pickLast(r, Z("2026-10-30T00:40Z"));
  assert.equal(x.price, 157.9); assert.equal(x.date, "2026-10-30");
}
// 3. 先物で最新気配が無い場合は従来のバー判定にフォールバック
{
  const r = { ...bars([["2026-10-29T04:00Z", 4031.4], ["2026-10-30T04:00Z", 3884.9]]),
    meta: { symbol: "GC=F", instrumentType: "FUTURE", currentTradingPeriod: { regular: { start: Z("2026-10-30T04:00Z"), end: Z("2026-10-31T03:59Z") } } } };
  const x = pickLast(r, Z("2026-10-30T23:07Z"));
  assert.equal(x.price, 4031.4); assert.equal(x.mode, "bar");
}
// 4. 日本株：JSTの朝（寄り付き前）は前営業日の確定バー（当日のバーはまだ無い）を使う
{
  const r = { ...bars([["2026-10-28T00:00Z", 3300], ["2026-10-29T00:00Z", 3321]]),
    meta: { symbol: "8306.T", instrumentType: "EQUITY", currentTradingPeriod: { regular: { start: Z("2026-10-30T00:00Z"), end: Z("2026-10-30T06:30Z") } } } };
  const x = pickLast(r, Z("2026-10-29T23:10Z"));
  assert.equal(x.price, 3321); assert.equal(x.date, "2026-10-29");
}
// 5. 日本株：立会中（JST 10:00）は、当日の途中バーを捨てて前日の終値を使う
{
  const r = { ...bars([["2026-10-29T00:00Z", 3321], ["2026-10-30T00:00Z", 3340]]),
    meta: { symbol: "8306.T", instrumentType: "EQUITY", currentTradingPeriod: { regular: { start: Z("2026-10-30T00:00Z"), end: Z("2026-10-30T06:30Z") } } } };
  const x = pickLast(r, Z("2026-10-30T01:00Z"));
  assert.equal(x.price, 3321); assert.equal(x.date, "2026-10-29");
}
// 6. 日本株：大引け後（JST 16:00）は当日のバーを使う
{
  const r = { ...bars([["2026-10-29T00:00Z", 3321], ["2026-10-30T00:00Z", 3330]]),
    meta: { symbol: "8306.T", instrumentType: "EQUITY", currentTradingPeriod: { regular: { start: Z("2026-10-30T00:00Z"), end: Z("2026-10-30T06:30Z") } } } };
  const x = pickLast(r, Z("2026-10-30T07:00Z"));
  assert.equal(x.price, 3330); assert.equal(x.date, "2026-10-30");
}
// 7. 米国株：UTC 0時台（取引終了後）は当日の確定バー、取引中は捨てる
{
  const meta = { symbol: "ETN", instrumentType: "EQUITY", currentTradingPeriod: { regular: { start: Z("2026-10-29T13:30Z"), end: Z("2026-10-29T20:00Z") } } };
  const r = { ...bars([["2026-10-28T13:30Z", 366], ["2026-10-29T13:30Z", 368.9]]), meta };
  assert.equal(pickLast(r, Z("2026-10-30T00:40Z")).price, 368.9);
  assert.equal(pickLast(r, Z("2026-10-29T15:00Z")).price, 366);
}
// 8. 終値が null の末尾バーは飛ばす
{
  const r = { ...bars([["2026-10-28T00:00Z", 100], ["2026-10-29T00:00Z", null]]), meta: { symbol: "X", instrumentType: "EQUITY" } };
  assert.equal(pickLast(r, Z("2026-10-30T00:00Z")).price, 100);
}
console.log("pickLast: 全ケース OK");
