/* ============================================================
   Stock Analyzer — script.js
   Price history: Stooq (primary) → Yahoo Finance (fallback),
   both via a CORS proxy. Fundamentals / analyst / news: Finnhub.
   ============================================================ */

// ⬇️ PASTE YOUR FREE FINNHUB KEY HERE
const FINNHUB_KEY = "d8kpsp1r01qut1f6usrgd8kpsp1r01qut1f6uss0";

const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Public CORS proxy. Wraps a URL so the browser is allowed to read it.
const PROXY = "https://corsproxy.io/?url=";

/* ---------- DOM references ---------- */
const form = document.getElementById("search-form");
const input = document.getElementById("ticker-input");
const analyzeBtn = document.getElementById("analyze-btn");
const loadingEl = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const errorEl = document.getElementById("error");
const errorText = document.getElementById("error-text");
const resultsEl = document.getElementById("results");

/* ---------- UI state helpers ---------- */
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setLoading(isLoading, msg) {
  if (isLoading) {
    hide(errorEl);
    hide(resultsEl);
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
  hide(resultsEl);            // <-- hides the leftover AAPL placeholder on error
  errorText.textContent = msg;
  show(errorEl);
}

/* ============================================================
   DATA FETCHING
   ============================================================ */

/* Wrap any URL through the CORS proxy */
function proxied(url) {
  return PROXY + encodeURIComponent(url);
}

/* ---- Primary: Stooq daily CSV ---- */
async function fetchFromStooq(ticker) {
  const symbol = ticker.toLowerCase() + ".us";
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d`;
  const res = await fetch(proxied(url));
  if (!res.ok) throw new Error("stooq-failed");

  const text = await res.text();
  if (text.trim().toLowerCase().startsWith("no data") || !text.includes(",")) {
    throw new Error("stooq-nodata");
  }

  const lines = text.trim().split("\n");
  if (!lines[0].toLowerCase().startsWith("date")) throw new Error("stooq-format");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 5) continue;
    const close = parseFloat(p[4]);
    if (Number.isNaN(close)) continue;
    rows.push({
      date: p[0],
      open: parseFloat(p[1]),
      high: parseFloat(p[2]),
      low: parseFloat(p[3]),
      close,
      volume: parseFloat(p[5]) || 0,
    });
  }
  if (rows.length < 50) throw new Error("stooq-short");
  return rows;
}

/* ---- Fallback: Yahoo Finance chart endpoint (1 year daily) ---- */
async function fetchFromYahoo(ticker) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?range=1y&interval=1d`;
  const res = await fetch(proxied(url));
  if (!res.ok) throw new Error("yahoo-failed");

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("yahoo-nodata");

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    rows.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  if (rows.length < 50) throw new Error("yahoo-short");
  return rows;
}

/* ---- Price history with automatic fallback ---- */
async function fetchPriceHistory(ticker) {
  try {
    return { rows: await fetchFromStooq(ticker), source: "Stooq" };
  } catch (e) {
    console.warn("Stooq failed, trying Yahoo:", e.message);
    try {
      return { rows: await fetchFromYahoo(ticker), source: "Yahoo Finance" };
    } catch (e2) {
      console.warn("Yahoo also failed:", e2.message);
      throw new Error(
        `Couldn't load price history for "${ticker.toUpperCase()}". ` +
        `Check the ticker symbol, or the data source may be temporarily down.`
      );
    }
  }
}

/* ---- Finnhub helpers ---- */
async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const res = await fetch(`${FINNHUB_BASE}${path}?${qs}`);
  if (res.status === 401 || res.status === 403) throw new Error("Finnhub rejected the API key.");
  if (res.status === 429) throw new Error("Finnhub rate limit hit. Wait a minute.");
  if (!res.ok) throw new Error("Finnhub request failed.");
  return res.json();
}

function fetchProfile(t)         { return finnhub("/stock/profile2", { symbol: t }); }
function fetchQuote(t)           { return finnhub("/quote", { symbol: t }); }
function fetchMetrics(t)         { return finnhub("/stock/metric", { symbol: t, metric: "all" }); }
function fetchRecommendations(t) { return finnhub("/stock/recommendation", { symbol: t }); }

function fetchNews(t) {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 30);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return finnhub("/company-news", { symbol: t, from: fmt(from), to: fmt(to) });
}

/* ============================================================
   TECHNICAL INDICATORS
   ============================================================ */
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) =>
    fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null
  );
  const valid = macdLine.filter((v) => v != null);
  const signalSeries = emaSeries(valid, 9);
  return {
    macd: macdLine[macdLine.length - 1] ?? 0,
    signal: signalSeries[signalSeries.length - 1] ?? 0,
  };
}

function bollingerPosition(closes, period = 20) {
  if (closes.length < period) return 0.5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std, lower = mean - 2 * std;
  const price = closes[closes.length - 1];
  if (upper === lower) return 0.5;
  return (price - lower) / (upper - lower);
}

/* ============================================================
   SCORING
   ============================================================ */
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }

function scoreTechnical(rows) {
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const price = closes[closes.length - 1];
  const rsi = calcRSI(closes);
  const { macd, signal } = calcMACD(closes);
  const bbPos = bollingerPosition(closes);
  const ma20 = sma(closes, 20), ma50 = sma(closes, 50);

  let score = 50;
  const bullish = [], bearish = [];

  if (rsi < 30)      { score += 15; bullish.push(`RSI oversold (${rsi.toFixed(1)})`); }
  else if (rsi > 70) { score -= 15; bearish.push(`RSI overbought (${rsi.toFixed(1)})`); }

  if (macd > signal) { score += 10; bullish.push("MACD above signal line"); }
  else               { score -= 10; bearish.push("MACD below signal line"); }

  if (bbPos < 0.1)      { score += 12; bullish.push("Price near lower Bollinger Band"); }
  else if (bbPos > 0.9) { score -= 12; bearish.push("Price near upper Bollinger Band"); }

  if (ma20 && ma50) {
    if (price > ma20 && ma20 > ma50)      { score += 12; bullish.push("Uptrend (price > MA20 > MA50)"); }
    else if (price < ma20 && ma20 < ma50) { score -= 12; bearish.push("Downtrend (price < MA20 < MA50)"); }
  }

  const recentVol = sma(volumes, 5);
  const avgVol = sma(volumes, Math.min(volumes.length, 60));
  if (recentVol && avgVol && recentVol > avgVol * 1.4) { score += 5; bullish.push("Volume above average"); }

  return {
    score: clamp(score), bullish, bearish,
    detail: `RSI=${rsi.toFixed(1)}, MACD=${(macd - signal).toFixed(3)}, BB_pos=${bbPos.toFixed(2)}`,
  };
}

function scoreMomentum(rows) {
  const c = rows.map((r) => r.close);
  const n = c.length;
  const r1w = n >= 6  ? (c[n-1] / c[n-6]  - 1) * 100 : 0;
  const r1m = n >= 21 ? (c[n-1] / c[n-21] - 1) * 100 : 0;
  const r3m = n >= 64 ? (c[n-1] / c[n-64] - 1) * 100 : 0;

  let score = 50;
  const bullish = [], bearish = [];

  if (r1w > 5)        { score += 8;  bullish.push(`Strong 1-week move (+${r1w.toFixed(1)}%)`); }
  else if (r1w < -5)  { score -= 8;  bearish.push(`Weak 1-week move (${r1w.toFixed(1)}%)`); }
  if (r1m > 10)       { score += 14; bullish.push(`Strong 1-month move (+${r1m.toFixed(1)}%)`); }
  else if (r1m < -10) { score -= 14; bearish.push(`Weak 1-month move (${r1m.toFixed(1)}%)`); }
  if (r3m > 20)       { score += 10; bullish.push(`Strong 3-month move (+${r3m.toFixed(1)}%)`); }
  else if (r3m < -20) { score -= 10; bearish.push(`Weak 3-month move (${r3m.toFixed(1)}%)`); }

  if (n >= 21) {
    const rets = [];
    for (let i = n - 20; i < n; i++) rets.push(c[i] / c[i - 1] - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const annVol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100;
    if (annVol > 50)      { score -= 5; bearish.push(`High volatility (${annVol.toFixed(0)}%)`); }
    else if (annVol < 20) { score += 3; bullish.push(`Low volatility (${annVol.toFixed(0)}%)`); }
  }

  return { score: clamp(score), bullish, bearish, r1m };
}

function scoreFundamental(metricData) {
  const m = (metricData && metricData.metric) || {};
  let score = 50;
  const bullish = [], bearish = [];

  const pe = m.peTTM ?? m.peBasicExclExtraTTM;
  const roe = m.roeTTM;
  const debtEq = m["totalDebt/totalEquityQuarterly"] ?? m.longTermDebt2EquityQuarterly;
  const revGrowth = m.revenueGrowthTTMYoy;
  const netMargin = m.netProfitMarginTTM;

  if (pe != null) {
    if (pe > 8 && pe < 18) { score += 12; bullish.push(`Attractive P/E (${pe.toFixed(1)})`); }
    else if (pe > 35)      { score -= 12; bearish.push(`High P/E (${pe.toFixed(1)})`); }
    else if (pe < 0)       { score -= 8;  bearish.push("Negative earnings (no P/E)"); }
  }
  if (roe != null) {
    if (roe > 18)      { score += 12; bullish.push(`Excellent ROE (${roe.toFixed(1)}%)`); }
    else if (roe > 12) { score += 8;  bullish.push(`Good ROE (${roe.toFixed(1)}%)`); }
    else if (roe < 5)  { score -= 8;  bearish.push(`Weak ROE (${roe.toFixed(1)}%)`); }
  }
  if (debtEq != null) {
    if (debtEq < 0.4)      { score += 8;  bullish.push("Low debt-to-equity"); }
    else if (debtEq > 1.5) { score -= 12; bearish.push(`High debt-to-equity (${debtEq.toFixed(2)})`); }
  }
  if (revGrowth != null) {
    if (revGrowth > 15)      { score += 14; bullish.push(`Strong revenue growth (${revGrowth.toFixed(1)}%)`); }
    else if (revGrowth < -5) { score -= 12; bearish.push(`Declining revenue (${revGrowth.toFixed(1)}%)`); }
  }
  if (netMargin != null) {
    if (netMargin > 20)     { score += 6; bullish.push(`High net margin (${netMargin.toFixed(1)}%)`); }
    else if (netMargin < 0) { score -= 8; bearish.push("Unprofitable (negative margin)"); }
  }

  const detail = `P/E=${pe != null ? pe.toFixed(1) : "N/A"}, ROE=${roe != null ? roe.toFixed(1) + "%" : "N/A"}, RevGrowth=${revGrowth != null ? revGrowth.toFixed(1) + "%" : "N/A"}`;
  return { score: clamp(score), bullish, bearish, detail };
}

function scoreAnalyst(recArray) {
  let score = 50;
  const bullish = [], bearish = [];
  let rating = "N/A";

  if (Array.isArray(recArray) && recArray.length > 0) {
    const l = recArray[0];
    const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = l;
    const total = strongBuy + buy + hold + sell + strongSell;
    if (total > 0) {
      const weighted = (strongBuy * 100 + buy * 75 + hold * 50 + sell * 25) / total;
      score = weighted;
      const bull = strongBuy + buy, bear = sell + strongSell;
      if (weighted >= 75) rating = "Strong Buy";
      else if (weighted >= 60) rating = "Buy";
      else if (weighted >= 45) rating = "Hold";
      else if (weighted >= 30) rating = "Sell";
      else rating = "Strong Sell";
      if (bull > bear) bullish.push(`Analysts lean bullish (${bull} buy vs ${bear} sell)`);
      else if (bear > bull) bearish.push(`Analysts lean bearish (${bear} sell vs ${bull} buy)`);
    }
  }
  return { score: clamp(score), bullish, bearish, rating };
}

function scoreSentiment(newsArray) {
  let score = 50;
  const bullish = [], bearish = [];
  const positive = ["surge","beat","gain","growth","record","upgrade","strong","rally","profit","jump","outperform","raise"];
  const negative = ["miss","fall","drop","loss","downgrade","weak","plunge","decline","cut","lawsuit","probe","warn"];

  let net = 0, counted = 0;
  if (Array.isArray(newsArray)) {
    for (const item of newsArray.slice(0, 40)) {
      const text = `${item.headline || ""} ${item.summary || ""}`.toLowerCase();
      let local = 0;
      for (const w of positive) if (text.includes(w)) local++;
      for (const w of negative) if (text.includes(w)) local--;
      if (local !== 0) { net += local; counted++; }
    }
  }
  if (counted > 0) {
    score = clamp(50 + (net / counted) * 18);
    if (score > 60) bullish.push(`Positive news tone (${counted} articles)`);
    else if (score < 40) bearish.push(`Negative news tone (${counted} articles)`);
  }
  return { score: clamp(score), bullish, bearish };
}

/* ============================================================
   ORCHESTRATION
   ============================================================ */
async function analyze(ticker) {
  setLoading(true, "Fetching price history…");
  const { rows, source: priceSource } = await fetchPriceHistory(ticker);

  setLoading(true, "Fetching fundamentals, analyst & news data…");
  const [profile, quote, metrics, recs, news] = await Promise.allSettled([
    fetchProfile(ticker), fetchQuote(ticker), fetchMetrics(ticker),
    fetchRecommendations(ticker), fetchNews(ticker),
  ]);
  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  const profileD = val(profile), quoteD = val(quote), metricsD = val(metrics),
        recsD = val(recs), newsD = val(news);

  setLoading(true, "Crunching the numbers…");
  const tech = scoreTechnical(rows);
  const mom = scoreMomentum(rows);
  const fund = scoreFundamental(metricsD);
  const analyst = scoreAnalyst(recsD);
  const sentiment = scoreSentiment(newsD);

  const overall =
    0.25 * tech.score + 0.25 * fund.score + 0.20 * mom.score +
    0.15 * sentiment.score + 0.15 * analyst.score;

  const scores = [tech.score, fund.score, mom.score, sentiment.score, analyst.score];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  let confidence = clamp(100 - std * 1.5);

  const sources = [priceSource];
  if (metricsD) sources.push("Finnhub fundamentals");
  if (recsD) sources.push("Finnhub analyst");
  if (newsD) sources.push("Finnhub news");
  if (sources.length >= 3) confidence = clamp(confidence + 8);

  const beta = metricsD?.metric?.beta;
  let risk = "Medium";
  if (beta != null) { if (beta > 1.5) risk = "High"; else if (beta < 0.8) risk = "Low"; }

  let recommendation = "HOLD";
  if (overall >= 70) recommendation = "BUY";
  else if (overall < 45) recommendation = "SELL";

  const price = quoteD && quoteD.c ? quoteD.c : rows[rows.length - 1].close;

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
    explanation: `${tech.detail} | ${fund.detail} | 1M move: ${mom.r1m.toFixed(1)}% | Sentiment: ${sentiment.score.toFixed(0)}/100 | Analyst: ${analyst.rating}`,
    sources,
  };
}

/* ============================================================
   RENDERING
   ============================================================ */
function barClass(score) {
  if (score >= 65) return "high";
  if (score >= 45) return "mid";
  return "low";
}

function fillScore(numId, barId, score) {
  document.getElementById(numId).textContent = Math.round(score);
  const barEl = document.getElementById(barId);
  barEl.className = "score-fill " + barClass(score);
  requestAnimationFrame(() => { barEl.style.width = clamp(score) + "%"; });
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
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
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
  document.getElementById("sources-value").textContent = a.sources.join(", ");

  setLoading(false);
  show(resultsEl);
}

/* ============================================================
   EVENT WIRING
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
