/* ============================================================
   Stock Analyzer — script.js  (DEEP ANALYSIS VERSION)
   Price history: Stooq → Yahoo fallback (via CORS proxy)
   Data: Finnhub (profile, quote, metrics, analyst, news, earnings)
   AI sentiment: transformers.js in-browser (keyword fallback)
   ============================================================ */

// ⬇️ PASTE YOUR FREE FINNHUB KEY HERE
const FINNHUB_KEY = "d8kpsp1r01qut1f6usrgd8kpsp1r01qut1f6uss0";

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const PROXY = "https://corsproxy.io/?url=";

/* ---------- DOM ---------- */
const form = document.getElementById("search-form");
const input = document.getElementById("ticker-input");
const analyzeBtn = document.getElementById("analyze-btn");
const loadingEl = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const errorEl = document.getElementById("error");
const errorText = document.getElementById("error-text");
const resultsEl = document.getElementById("results");

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setLoading(on, msg) {
  if (on) {
    hide(errorEl); hide(resultsEl);
    if (msg) loadingText.textContent = msg;
    show(loadingEl);
    analyzeBtn.disabled = true;
  } else {
    hide(loadingEl);
    analyzeBtn.disabled = false;
  }
}

function showError(msg) {
  setLoading(false);
  hide(resultsEl);
  errorText.textContent = msg;
  show(errorEl);
}

function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }

/* ============================================================
   DATA FETCHING
   ============================================================ */
function proxied(url) { return PROXY + encodeURIComponent(url); }

async function fetchFromStooq(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`;
  const res = await fetch(proxied(url));
  if (!res.ok) throw new Error("stooq-failed");
  const text = await res.text();
  if (text.trim().toLowerCase().startsWith("no data") || !text.includes(",")) throw new Error("stooq-nodata");
  const lines = text.trim().split("\n");
  if (!lines[0].toLowerCase().startsWith("date")) throw new Error("stooq-format");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 5) continue;
    const close = parseFloat(p[4]);
    if (Number.isNaN(close)) continue;
    rows.push({ date: p[0], open: +p[1], high: +p[2], low: +p[3], close, volume: +p[5] || 0 });
  }
  if (rows.length < 60) throw new Error("stooq-short");
  return rows;
}

async function fetchFromYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
  const res = await fetch(proxied(url));
  if (!res.ok) throw new Error("yahoo-failed");
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error("yahoo-nodata");
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    rows.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? close, high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close, close, volume: q.volume?.[i] ?? 0,
    });
  }
  if (rows.length < 60) throw new Error("yahoo-short");
  return rows;
}

async function fetchPriceHistory(ticker) {
  try { return { rows: await fetchFromStooq(ticker), source: "Stooq" }; }
  catch (e) {
    console.warn("Stooq failed, trying Yahoo:", e.message);
    try { return { rows: await fetchFromYahoo(ticker), source: "Yahoo Finance" }; }
    catch (e2) {
      throw new Error(`Couldn't load price history for "${ticker.toUpperCase()}". Check the ticker, or the source may be down.`);
    }
  }
}

async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const res = await fetch(`${FINNHUB_BASE}${path}?${qs}`);
  if (res.status === 401 || res.status === 403) throw new Error("Finnhub rejected the API key.");
  if (res.status === 429) throw new Error("Finnhub rate limit hit. Wait a minute.");
  if (!res.ok) throw new Error("Finnhub request failed.");
  return res.json();
}

const fetchProfile = (t) => finnhub("/stock/profile2", { symbol: t });
const fetchQuote = (t) => finnhub("/quote", { symbol: t });
const fetchMetrics = (t) => finnhub("/stock/metric", { symbol: t, metric: "all" });
const fetchRecommendations = (t) => finnhub("/stock/recommendation", { symbol: t });
const fetchEarnings = (t) => finnhub("/stock/earnings", { symbol: t });

function fetchNews(t) {
  const to = new Date(), from = new Date();
  from.setDate(to.getDate() - 30);
  const f = (d) => d.toISOString().slice(0, 10);
  return finnhub("/company-news", { symbol: t, from: f(from), to: f(to) });
}

/* ============================================================
   INDICATORS
   ============================================================ */
function sma(values, period, offset = 0) {
  const end = values.length - offset;
  if (end < period) return null;
  let s = 0;
  for (let i = end - period; i < end; i++) s += values[i];
  return s / period;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1), out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function macdSeries(closes) {
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  const line = closes.map((_, i) => (fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null));
  const valid = line.filter((v) => v != null);
  const sig = emaSeries(valid, 9);
  // align signal back to full length
  const pad = line.length - valid.length;
  const signal = new Array(pad).fill(null).concat(sig);
  return { line, signal };
}

function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std, lower = mean - 2 * std;
  const price = closes[closes.length - 1];
  return {
    pos: upper === lower ? 0.5 : (price - lower) / (upper - lower),
    width: mean ? ((upper - lower) / mean) * 100 : 0, // squeeze detection
  };
}

function stochastic(rows, kPeriod = 14) {
  if (rows.length < kPeriod) return null;
  const slice = rows.slice(-kPeriod);
  const hi = Math.max(...slice.map((r) => r.high));
  const lo = Math.min(...slice.map((r) => r.low));
  const c = rows[rows.length - 1].close;
  return hi === lo ? 50 : ((c - lo) / (hi - lo)) * 100;
}

function annualizedVol(closes, lookback = 20) {
  if (closes.length < lookback + 1) return null;
  const rets = [];
  for (let i = closes.length - lookback; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return v * Math.sqrt(252) * 100;
}

function maxDrawdown(closes, lookback = 252) {
  const slice = closes.slice(-lookback);
  let peak = slice[0], maxDD = 0;
  for (const c of slice) {
    if (c > peak) peak = c;
    const dd = (peak - c) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

/* ============================================================
   SCORING — TECHNICAL (deep)
   ============================================================ */
function scoreTechnical(rows) {
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const price = closes[closes.length - 1];
  let score = 50;
  const bullish = [], bearish = [];

  // RSI level + direction
  const rsiS = rsiSeries(closes);
  const rsi = rsiS[rsiS.length - 1] ?? 50;
  const rsiPrev = rsiS[rsiS.length - 6] ?? rsi;
  if (rsi < 30) { score += 12; bullish.push(`RSI oversold (${rsi.toFixed(1)})`); }
  else if (rsi > 70) { score -= 12; bearish.push(`RSI overbought (${rsi.toFixed(1)})`); }
  if (rsi > rsiPrev + 5 && rsi < 60) { score += 4; bullish.push("RSI recovering upward"); }
  else if (rsi < rsiPrev - 5 && rsi > 40) { score -= 4; bearish.push("RSI rolling over"); }

  // MACD: position + histogram momentum
  const { line, signal } = macdSeries(closes);
  const macd = line[line.length - 1] ?? 0;
  const sig = signal[signal.length - 1] ?? 0;
  const hist = macd - sig;
  const histPrev = (line[line.length - 4] ?? 0) - (signal[signal.length - 4] ?? 0);
  if (hist > 0 && hist > histPrev) { score += 10; bullish.push("MACD bullish and strengthening"); }
  else if (hist > 0) { score += 6; bullish.push("MACD above signal"); }
  else if (hist < 0 && hist < histPrev) { score -= 10; bearish.push("MACD bearish and weakening"); }
  else { score -= 6; bearish.push("MACD below signal"); }

  // Trend STRUCTURE + STRENGTH (MA slopes)
  const ma20 = sma(closes, 20), ma50 = sma(closes, 50), ma200 = sma(closes, 200);
  const ma20Prev = sma(closes, 20, 10), ma50Prev = sma(closes, 50, 10);
  if (ma20 && ma50) {
    const slope20 = ma20Prev ? ((ma20 - ma20Prev) / ma20Prev) * 100 : 0;
    const slope50 = ma50Prev ? ((ma50 - ma50Prev) / ma50Prev) * 100 : 0;
    if (price > ma20 && ma20 > ma50 && slope20 > 0.5) {
      score += 14; bullish.push(`Strong uptrend (MA20 slope +${slope20.toFixed(1)}%/2wk)`);
    } else if (price > ma20 && ma20 > ma50) {
      score += 8; bullish.push("Uptrend structure intact");
    } else if (price < ma20 && ma20 < ma50 && slope20 < -0.5) {
      score -= 14; bearish.push(`Strong downtrend (MA20 slope ${slope20.toFixed(1)}%/2wk)`);
    } else if (price < ma20 && ma20 < ma50) {
      score -= 8; bearish.push("Downtrend structure");
    }
    // Golden / death cross within last ~15 sessions
    const ma50_15 = sma(closes, 50, 15), ma200_15 = sma(closes, 200, 15);
    if (ma200 && ma200_15 && ma50_15) {
      if (ma50 > ma200 && ma50_15 <= ma200_15) { score += 8; bullish.push("Recent golden cross (MA50 > MA200)"); }
      if (ma50 < ma200 && ma50_15 >= ma200_15) { score -= 8; bearish.push("Recent death cross (MA50 < MA200)"); }
    }
    if (ma200 && price > ma200) { score += 4; bullish.push("Above 200-day MA (long-term uptrend)"); }
    else if (ma200 && price < ma200) { score -= 4; bearish.push("Below 200-day MA"); }
  }

  // Bollinger position + squeeze
  const bb = bollinger(closes);
  if (bb) {
    if (bb.pos < 0.08) { score += 8; bullish.push("At lower Bollinger Band"); }
    else if (bb.pos > 0.92) { score -= 8; bearish.push("At upper Bollinger Band"); }
    if (bb.width < 6) bullish.push(`Bollinger squeeze (width ${bb.width.toFixed(1)}%) — big move may be coming`);
  }

  // Stochastic confirmation
  const stoch = stochastic(rows);
  if (stoch != null) {
    if (stoch < 20 && rsi < 40) { score += 5; bullish.push("Stochastic confirms oversold"); }
    else if (stoch > 80 && rsi > 60) { score -= 5; bearish.push("Stochastic confirms overbought"); }
  }

  // Volume trend on up vs down days (accumulation/distribution feel)
  if (rows.length >= 20) {
    let upVol = 0, downVol = 0;
    for (let i = rows.length - 20; i < rows.length; i++) {
      if (rows[i].close >= rows[i].open) upVol += rows[i].volume;
      else downVol += rows[i].volume;
    }
    if (upVol > downVol * 1.4) { score += 6; bullish.push("Volume concentrated on up days (accumulation)"); }
    else if (downVol > upVol * 1.4) { score -= 6; bearish.push("Volume concentrated on down days (distribution)"); }
  }

  return {
    score: clamp(score), bullish, bearish,
    detail: `RSI=${rsi.toFixed(1)}, MACD_hist=${hist.toFixed(3)}, BB_pos=${bb ? bb.pos.toFixed(2) : "N/A"}`,
  };
}

/* ============================================================
   SCORING — MOMENTUM & RISK (deep)
   ============================================================ */
function scoreMomentum(rows) {
  const c = rows.map((r) => r.close);
  const n = c.length;
  const ret = (d) => (n > d ? (c[n - 1] / c[n - 1 - d] - 1) * 100 : null);
  const r1w = ret(5), r1m = ret(21), r3m = ret(63), r6m = ret(126);
  let score = 50;
  const bullish = [], bearish = [];

  // Multi-timeframe alignment matters more than any single number
  const frames = [r1w, r1m, r3m].filter((v) => v != null);
  const allUp = frames.length >= 3 && frames.every((v) => v > 0);
  const allDown = frames.length >= 3 && frames.every((v) => v < 0);
  if (allUp) { score += 10; bullish.push("Positive momentum across all timeframes"); }
  if (allDown) { score -= 10; bearish.push("Negative momentum across all timeframes"); }

  if (r1m != null) {
    if (r1m > 10) { score += 10; bullish.push(`Strong month (+${r1m.toFixed(1)}%)`); }
    else if (r1m < -10) { score -= 10; bearish.push(`Weak month (${r1m.toFixed(1)}%)`); }
  }
  if (r3m != null) {
    if (r3m > 20) { score += 8; bullish.push(`Strong quarter (+${r3m.toFixed(1)}%)`); }
    else if (r3m < -20) { score -= 8; bearish.push(`Weak quarter (${r3m.toFixed(1)}%)`); }
  }
  // Mean reversion sanity: parabolic short-term spikes get a caution
  if (r1w != null && r1w > 15) { score -= 4; bearish.push(`Parabolic week (+${r1w.toFixed(1)}%) — pullback risk`); }

  const vol = annualizedVol(c);
  if (vol != null) {
    if (vol > 55) { score -= 6; bearish.push(`High volatility (${vol.toFixed(0)}% annualized)`); }
    else if (vol < 18) { score += 3; bullish.push(`Low volatility (${vol.toFixed(0)}%)`); }
  }

  const dd = maxDrawdown(c);
  if (dd > 35) { score -= 5; bearish.push(`Deep 1-yr drawdown (-${dd.toFixed(0)}% from peak)`); }
  else if (dd < 12) { score += 4; bullish.push(`Shallow drawdowns (max -${dd.toFixed(0)}%)`); }

  return { score: clamp(score), bullish, bearish, r1m: r1m ?? 0, vol, drawdown: dd };
}

/* ============================================================
   SCORING — FUNDAMENTAL (sector-aware, deep)
   ============================================================ */
function peThresholds(industry) {
  const ind = (industry || "").toLowerCase();
  const growth = ["technology", "software", "semiconductors", "biotechnology", "media", "communication", "internet"];
  const value = ["bank", "insurance", "energy", "utilities", "oil", "financial", "mining"];
  if (growth.some((g) => ind.includes(g))) return { cheap: 35, expensive: 55 };
  if (value.some((v) => ind.includes(v))) return { cheap: 12, expensive: 22 };
  return { cheap: 18, expensive: 35 };
}

function scoreFundamental(metricData, profileD, price, earningsD) {
  const m = (metricData && metricData.metric) || {};
  const industry = profileD?.finnhubIndustry;
  let score = 50;
  const bullish = [], bearish = [];

  const pe = m.peTTM ?? m.peBasicExclExtraTTM;
  const roe = m.roeTTM;
  const debtEq = m["totalDebt/totalEquityQuarterly"] ?? m.longTermDebt2EquityQuarterly;
  const revGrowth = m.revenueGrowthTTMYoy;
  const epsGrowth = m.epsGrowthTTMYoy;
  const netMargin = m.netProfitMarginTTM;
  const grossMargin = m.grossMarginTTM;
  const divYield = m.currentDividendYieldTTM;
  const wkHigh = m["52WeekHigh"], wkLow = m["52WeekLow"];

  // Sector-aware valuation
  const th = peThresholds(industry);
  if (pe != null) {
    if (pe > 0 && pe < th.cheap) { score += 12; bullish.push(`P/E ${pe.toFixed(1)} reasonable for ${industry || "sector"}`); }
    else if (pe > th.expensive) { score -= 12; bearish.push(`P/E ${pe.toFixed(1)} expensive for ${industry || "sector"}`); }
    else if (pe < 0) { score -= 8; bearish.push("Negative earnings (no meaningful P/E)"); }
  }

  // Growth-adjusted valuation (homemade PEG)
  if (pe != null && pe > 0 && epsGrowth != null && epsGrowth > 0) {
    const peg = pe / epsGrowth;
    if (peg < 1.2) { score += 8; bullish.push(`Cheap vs growth (PEG ≈ ${peg.toFixed(2)})`); }
    else if (peg > 3) { score -= 6; bearish.push(`Expensive vs growth (PEG ≈ ${peg.toFixed(2)})`); }
  }

  // Quality
  if (roe != null) {
    if (roe > 20) { score += 10; bullish.push(`Excellent ROE (${roe.toFixed(1)}%)`); }
    else if (roe > 12) { score += 6; bullish.push(`Solid ROE (${roe.toFixed(1)}%)`); }
    else if (roe < 5) { score -= 7; bearish.push(`Weak ROE (${roe.toFixed(1)}%)`); }
  }
  if (grossMargin != null && grossMargin > 50) { score += 4; bullish.push(`Strong gross margin (${grossMargin.toFixed(0)}%) — pricing power`); }
  if (netMargin != null) {
    if (netMargin > 20) { score += 5; bullish.push(`High net margin (${netMargin.toFixed(1)}%)`); }
    else if (netMargin < 0) { score -= 8; bearish.push("Currently unprofitable"); }
  }

  // Balance sheet
  if (debtEq != null) {
    if (debtEq < 0.4) { score += 6; bullish.push("Conservative balance sheet (low debt)"); }
    else if (debtEq > 2) { score -= 12; bearish.push(`Heavy debt load (D/E ${debtEq.toFixed(2)})`); }
    else if (debtEq > 1.2) { score -= 6; bearish.push(`Elevated debt (D/E ${debtEq.toFixed(2)})`); }
  }

  // Growth
  if (revGrowth != null) {
    if (revGrowth > 15) { score += 10; bullish.push(`Strong revenue growth (${revGrowth.toFixed(1)}%)`); }
    else if (revGrowth < -5) { score -= 10; bearish.push(`Shrinking revenue (${revGrowth.toFixed(1)}%)`); }
  }

  // Earnings surprise track record (last 4 quarters)
  if (Array.isArray(earningsD) && earningsD.length > 0) {
    const last4 = earningsD.slice(0, 4);
    const beats = last4.filter((e) => e.surprise != null && e.surprise > 0).length;
    const misses = last4.filter((e) => e.surprise != null && e.surprise < 0).length;
    if (beats >= 3) { score += 8; bullish.push(`Beat earnings estimates ${beats} of last ${last4.length} quarters`); }
    else if (misses >= 2) { score -= 8; bearish.push(`Missed estimates ${misses} of last ${last4.length} quarters`); }
  }

  // Dividend
  if (divYield != null && divYield > 2 && divYield < 6) { score += 3; bullish.push(`Pays dividend (${divYield.toFixed(1)}%)`); }

  // 52-week range position
  let rangePos = null;
  if (wkHigh && wkLow && wkHigh > wkLow && price) {
    rangePos = (price - wkLow) / (wkHigh - wkLow);
    if (rangePos > 0.85) { score += 4; bullish.push(`Near 52-week high (${(rangePos * 100).toFixed(0)}% of range)`); }
    else if (rangePos < 0.2) { score -= 4; bearish.push(`Near 52-week low (${(rangePos * 100).toFixed(0)}% of range) — investigate why`); }
  }

  return {
    score: clamp(score), bullish, bearish,
    detail: `P/E=${pe != null ? pe.toFixed(1) : "N/A"} (${industry || "?"}), ROE=${roe != null ? roe.toFixed(1) + "%" : "N/A"}, RevG=${revGrowth != null ? revGrowth.toFixed(1) + "%" : "N/A"}, 52wk=${rangePos != null ? (rangePos * 100).toFixed(0) + "%" : "N/A"}`,
  };
}

/* ============================================================
   SCORING — ANALYST (with trend over months)
   ============================================================ */
function scoreAnalyst(recArray) {
  let score = 50;
  const bullish = [], bearish = [];
  let rating = "N/A";

  if (Array.isArray(recArray) && recArray.length > 0) {
    const weightedOf = (r) => {
      const total = (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0);
      if (!total) return null;
      return ((r.strongBuy || 0) * 100 + (r.buy || 0) * 75 + (r.hold || 0) * 50 + (r.sell || 0) * 25) / total;
    };
    const now = weightedOf(recArray[0]);
    if (now != null) {
      score = now;
      rating = now >= 75 ? "Strong Buy" : now >= 60 ? "Buy" : now >= 45 ? "Hold" : now >= 30 ? "Sell" : "Strong Sell";
      const bull = (recArray[0].strongBuy || 0) + (recArray[0].buy || 0);
      const bear = (recArray[0].sell || 0) + (recArray[0].strongSell || 0);
      if (bull > bear) bullish.push(`Analysts lean bullish (${bull} buy vs ${bear} sell)`);
      else if (bear > bull) bearish.push(`Analysts lean bearish (${bear} sell vs ${bull} buy)`);
      // Trend: compare with ~3 months ago
      if (recArray.length >= 4) {
        const past = weightedOf(recArray[3]);
        if (past != null) {
          if (now > past + 5) { score = clamp(score + 5); bullish.push("Analyst sentiment improving over 3 months"); }
          else if (now < past - 5) { score = clamp(score - 5); bearish.push("Analyst sentiment deteriorating over 3 months"); }
        }
      }
    }
  }
  return { score: clamp(score), bullish, bearish, rating };
}

/* ============================================================
   SCORING — AI SENTIMENT (transformers.js, keyword fallback)
   ============================================================ */
let sentimentPipeline = null;
let sentimentLoadFailed = false;

async function getSentimentModel() {
  if (sentimentPipeline) return sentimentPipeline;
  if (sentimentLoadFailed) return null;
  try {
    const { pipeline } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
    sentimentPipeline = await pipeline("sentiment-analysis");
    return sentimentPipeline;
  } catch (e) {
    console.warn("AI model load failed, using keywords:", e);
    sentimentLoadFailed = true;
    return null;
  }
}

function recencyWeight(unixSeconds) {
  if (!unixSeconds) return 0.5;
  const daysAgo = (Date.now() / 1000 - unixSeconds) / 86400;
  return Math.max(0.35, 1 - daysAgo / 45);
}

function keywordSentiment(text) {
  const pos = ["surge","beat","gain","growth","record","upgrade","strong","rally","profit","jump","outperform","raise"];
  const neg = ["miss","fall","drop","loss","downgrade","weak","plunge","decline","cut","lawsuit","probe","warn"];
  let s = 0;
  const t = text.toLowerCase();
  for (const w of pos) if (t.includes(w)) s++;
  for (const w of neg) if (t.includes(w)) s--;
  return s === 0 ? null : s > 0 ? 1 : -1;
}

async function scoreSentiment(newsArray) {
  let score = 50;
  const bullish = [], bearish = [];
  if (!Array.isArray(newsArray) || newsArray.length === 0)
    return { score, bullish, bearish, method: "no news" };

  const items = newsArray.slice(0, 25);
  const model = await getSentimentModel();
  let method = model ? "AI model" : "keyword fallback";
  let wSum = 0, wTot = 0, counted = 0;

  if (model) {
    setLoading(true, "AI is reading the news…");
    for (const item of items) {
      const text = (item.headline || "").slice(0, 200);
      if (!text) continue;
      try {
        const [res] = await model(text);
        const dir = res.label === "POSITIVE" ? 1 : -1;
        const w = recencyWeight(item.datetime);
        wSum += dir * res.score * w;
        wTot += w;
        counted++;
      } catch { /* skip */ }
    }
  } else {
    for (const item of items) {
      const dir = keywordSentiment(`${item.headline || ""} ${item.summary || ""}`);
      if (dir === null) continue;
      const w = recencyWeight(item.datetime);
      wSum += dir * w; wTot += w; counted++;
    }
  }

  if (counted > 0 && wTot > 0) {
    const avg = wSum / wTot;
    score = clamp(50 + avg * 40);
    if (score > 62) bullish.push(`News tone positive — ${counted} articles (${method})`);
    else if (score < 38) bearish.push(`News tone negative — ${counted} articles (${method})`);
  }
  // News volume signal
  if (newsArray.length > 60) bullish.push(`Heavy news flow (${newsArray.length} articles/30d) — high attention`);

  return { score: clamp(score), bullish, bearish, method };
}

/* ============================================================
   SMART SUMMARY — generates a readable paragraph from the data
   ============================================================ */
function buildSummary(a) {
  const s = [];
  const name = a.name !== a.ticker ? a.name : a.ticker;

  // Opening verdict
  if (a.overall >= 75)      s.push(`${name} scores ${Math.round(a.overall)}/100 — one of the stronger profiles this tool can produce.`);
  else if (a.overall >= 60) s.push(`${name} scores ${Math.round(a.overall)}/100, a moderately positive overall picture.`);
  else if (a.overall >= 45) s.push(`${name} scores ${Math.round(a.overall)}/100 — a mixed picture without a clear edge either way.`);
  else                      s.push(`${name} scores ${Math.round(a.overall)}/100, with warning signs outweighing the positives right now.`);

  // Strongest and weakest factor
  const factors = Object.entries(a.scores); // [name, score]
  factors.sort((x, y) => y[1] - x[1]);
  const [bestName, bestVal] = factors[0];
  const [worstName, worstVal] = factors[factors.length - 1];
  const label = { technical: "technical setup", fundamental: "fundamentals", momentum: "momentum", sentiment: "news sentiment", analyst: "analyst opinion" };

  if (bestVal - worstVal > 25) {
    s.push(`The standout strength is its ${label[bestName]} (${Math.round(bestVal)}), while the weak spot is ${label[worstName]} (${Math.round(worstVal)}) — that disagreement is why confidence sits at ${Math.round(a.confidence)}%.`);
  } else {
    s.push(`The five factors broadly agree, led by ${label[bestName]} at ${Math.round(bestVal)}.`);
  }

  // Headline factor highlights (top bullish + top bearish)
  if (a.bullish.length) s.push(`On the plus side: ${a.bullish[0].toLowerCase()}${a.bullish[1] ? ", and " + a.bullish[1].toLowerCase() : ""}.`);
  if (a.bearish.length) s.push(`On the caution side: ${a.bearish[0].toLowerCase()}${a.bearish[1] ? ", and " + a.bearish[1].toLowerCase() : ""}.`);

  // Risk framing
  if (a.risk === "High" || a.risk === "Elevated")
    s.push(`Risk is rated ${a.risk.toLowerCase()}, so swings in both directions should be expected.`);
  else if (a.risk === "Low")
    s.push(`Risk is rated low, suggesting comparatively calm price behavior.`);

  // Honest closer
  s.push(`As always, a score is a snapshot — check what's driving the numbers before acting on them.`);

  return s.join(" ");
}

/* ============================================================
   ORCHESTRATION
   ============================================================ */
async function analyze(ticker) {
  setLoading(true, "Fetching price history…");
  const { rows, source: priceSource } = await fetchPriceHistory(ticker);

  setLoading(true, "Fetching fundamentals, analyst, earnings & news…");
  const [profile, quote, metrics, recs, news, earnings] = await Promise.allSettled([
    fetchProfile(ticker), fetchQuote(ticker), fetchMetrics(ticker),
    fetchRecommendations(ticker), fetchNews(ticker), fetchEarnings(ticker),
  ]);
  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  const profileD = val(profile), quoteD = val(quote), metricsD = val(metrics);
  const recsD = val(recs), newsD = val(news), earningsD = val(earnings);

  const price = quoteD && quoteD.c ? quoteD.c : rows[rows.length - 1].close;

  setLoading(true, "Crunching the numbers…");
  const tech = scoreTechnical(rows);
  const mom = scoreMomentum(rows);
  const fund = scoreFundamental(metricsD, profileD, price, earningsD);
  const analyst = scoreAnalyst(recsD);
  const sentiment = await scoreSentiment(newsD);

  const overall =
    0.25 * tech.score + 0.25 * fund.score + 0.20 * mom.score +
    0.15 * sentiment.score + 0.15 * analyst.score;

  // Confidence: factor agreement + data completeness
  const scores = [tech.score, fund.score, mom.score, sentiment.score, analyst.score];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  let confidence = clamp(100 - std * 1.5);
  const sources = [priceSource];
  if (metricsD?.metric) sources.push("Finnhub fundamentals");
  if (recsD?.length) sources.push("Finnhub analyst");
  if (newsD?.length) sources.push(`Finnhub news (${sentiment.method})`);
  if (Array.isArray(earningsD) && earningsD.length) sources.push("Finnhub earnings");
  confidence = clamp(confidence * (0.6 + 0.1 * Math.min(sources.length, 4)));

  // Risk: beta + realized volatility + drawdown
  const beta = metricsD?.metric?.beta;
  let riskPoints = 0;
  if (beta != null) riskPoints += beta > 1.5 ? 2 : beta > 1.1 ? 1 : beta < 0.8 ? -1 : 0;
  if (mom.vol != null) riskPoints += mom.vol > 50 ? 2 : mom.vol > 32 ? 1 : mom.vol < 18 ? -1 : 0;
  if (mom.drawdown > 35) riskPoints += 1;
  const risk = riskPoints >= 3 ? "High" : riskPoints <= -1 ? "Low" : riskPoints >= 1 ? "Elevated" : "Medium";

  let recommendation = "HOLD";
  if (overall >= 70) recommendation = "BUY";
  else if (overall < 45) recommendation = "SELL";

  return {
    ticker: ticker.toUpperCase(),
    name: profileD?.name || ticker.toUpperCase(),
    price, overall, confidence, risk, recommendation,
    scores: {
      technical: tech.score, fundamental: fund.score, momentum: mom.score,
      sentiment: sentiment.score, analyst: analyst.score,
    },
    analystRating: analyst.rating,
    bullish: [...tech.bullish, ...fund.bullish, ...mom.bullish, ...sentiment.bullish, ...analyst.bullish],
    bearish: [...tech.bearish, ...fund.bearish, ...mom.bearish, ...sentiment.bearish, ...analyst.bearish],
    explanation: `${tech.detail} | ${fund.detail} | 1M: ${mom.r1m.toFixed(1)}%, Vol: ${mom.vol ? mom.vol.toFixed(0) + "%" : "N/A"}, MaxDD: -${mom.drawdown.toFixed(0)}% | Sentiment: ${sentiment.score.toFixed(0)}/100 | Analyst: ${analyst.rating}`,
    sources,
  };
}

/* ============================================================
   RENDERING
   ============================================================ */
function barClass(s) { return s >= 65 ? "high" : s >= 45 ? "mid" : "low"; }

function fillScore(numId, barId, score) {
  document.getElementById(numId).textContent = Math.round(score);
  const bar = document.getElementById(barId);
  bar.className = "score-fill " + barClass(score);
  requestAnimationFrame(() => { bar.style.width = clamp(score) + "%"; });
}

function fillList(listId, items, emptyMsg) {
  const ul = document.getElementById(listId);
  ul.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyMsg;
    ul.appendChild(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = it;
    ul.appendChild(li);
  }
}

function render(a) {
  document.getElementById("result-ticker").textContent = a.ticker;
  document.getElementById("result-name").textContent = a.name;
  document.getElementById("result-updated").textContent = "Updated: " + new Date().toLocaleString();
  document.getElementById("overall-value").textContent = Math.round(a.overall);

  const badge = document.getElementById("recommendation-badge");
  badge.textContent = a.recommendation;
  badge.className = "recommendation-badge " + a.recommendation.toLowerCase();

  document.getElementById("confidence-value").textContent = Math.round(a.confidence) + "%";
  document.getElementById("risk-value").textContent = a.risk;
  document.getElementById("price-value").textContent = a.price != null ? "$" + a.price.toFixed(2) : "—";
  document.getElementById("target-value").textContent = a.analystRating !== "N/A" ? a.analystRating : "—";

  fillScore("technical-num", "technical-bar", a.scores.technical);
  fillScore("fundamental-num", "fundamental-bar", a.scores.fundamental);
  fillScore("momentum-num", "momentum-bar", a.scores.momentum);
  fillScore("sentiment-num", "sentiment-bar", a.scores.sentiment);
  fillScore("analyst-num", "analyst-bar", a.scores.analyst);

  fillList("bullish-list", a.bullish, "No notable bullish signals.");
  fillList("bearish-list", a.bearish, "No notable bearish signals.");

  document.getElementById("explanation-text").textContent = a.explanation;

  // Smart summary (the fix!)
  const summaryEl = document.getElementById("summary-text");
  if (summaryEl) summaryEl.textContent = buildSummary(a);

  document.getElementById("sources-value").textContent = a.sources.join(", ");

  setLoading(false);
  show(resultsEl);
}

/* ============================================================
   EVENTS
   ============================================================ */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;

  if (!FINNHUB_KEY || FINNHUB_KEY === "YOUR_FINNHUB_KEY") {
    showError("Add your free Finnhub API key in script.js (FINNHUB_KEY).");
    return;
  }
  try {
    render(await analyze(ticker));
  } catch (err) {
    console.error(err);
    showError(err.message || "Analysis failed. Try another ticker.");
  }
});

/* ---------- Theme toggle (works if you added the button) ---------- */
const themeBtn = document.getElementById("theme-toggle");
if (themeBtn) {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.dataset.theme = saved;
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  });
}
