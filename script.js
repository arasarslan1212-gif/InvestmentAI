/* ============================================================
   Stock Analyzer — script.js
   Data: Stooq (price history) + Finnhub (fundamentals,
   analyst recommendations, news sentiment). Real API only.
   ============================================================ */

// ⬇️ PASTE YOUR FREE FINNHUB KEY HERE
const FINNHUB_KEY = "d8kpsp1r01qut1f6usrgd8kpsp1r01qut1f6uss0";

const FINNHUB_BASE = "https://finnhub.io/api/v1";

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
  hide(resultsEl);
  errorText.textContent = msg;
  show(errorEl);
}

/* ============================================================
   DATA FETCHING
   ============================================================ */

/* ---- Stooq: historical daily prices (CORS-friendly CSV) ----
   Stooq serves US tickers with a ".us" suffix, e.g. aapl.us
   Returns an array of {date, open, high, low, close, volume}
   sorted oldest → newest.
------------------------------------------------------------- */
async function fetchPriceHistory(ticker) {
  const symbol = ticker.toLowerCase() + ".us";
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not reach price history service.");

  const text = await res.text();
  // Stooq returns "No data" text when ticker is invalid
  if (text.trim().toLowerCase().startsWith("no data") || !text.includes(",")) {
    throw new Error(`No price history found for "${ticker.toUpperCase()}".`);
  }

  const lines = text.trim().split("\n");
  const header = lines[0].toLowerCase();
  if (!header.startsWith("date")) {
    throw new Error("Unexpected price data format.");
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const [date, open, high, low, close, volume] = parts;
    const c = parseFloat(close);
    if (Number.isNaN(c)) continue;
    rows.push({
      date,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: c,
      volume: parseFloat(volume) || 0,
    });
  }

  if (rows.length < 50) {
    throw new Error("Not enough price history to analyze this ticker.");
  }
  return rows;
}

/* ---- Finnhub helpers ---- */
async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const res = await fetch(`${FINNHUB_BASE}${path}?${qs}`);
  if (res.status === 401 || res.status === 403) {
    throw new Error("Finnhub rejected the API key. Check your key.");
  }
  if (res.status === 429) {
    throw new Error("Finnhub rate limit hit. Wait a minute and retry.");
  }
  if (!res.ok) throw new Error("Finnhub request failed.");
  return res.json();
}

function fetchProfile(t)        { return finnhub("/stock/profile2", { symbol: t }); }
function fetchQuote(t)          { return finnhub("/quote", { symbol: t }); }
function fetchMetrics(t)        { return finnhub("/stock/metric", { symbol: t, metric: "all" }); }
function fetchRecommendations(t){ return finnhub("/stock/recommendation", { symbol: t }); }

/* News from the last 30 days, for sentiment */
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

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
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
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
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
  const macd = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { macd: macd ?? 0, signal: signal ?? 0 };
}

function bollingerPosition(closes, period = 20) {
  if (closes.length < period) return 0.5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
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
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);

  let score = 50;
  const bullish = [], bearish = [];

  if (rsi < 30)      { score += 15; bullish.push(`RSI oversold (${rsi.toFixed(1)})`); }
  else if (rsi > 70) { score -= 15; bearish.push(`RSI overbought (${rsi.toFixed(1)})`); }

  if (macd > signal) { score += 10; bullish.push("MACD above signal line"); }
  else               { score -= 10; bearish.push("MACD below signal line"); }

  if (bbPos < 0.1)      { score += 12; bullish.push("Price near lower Bollinger Band"); }
  else if (bbPos > 0.9) { score -= 12; bearish.push("Price near upper Bollinger Band"); }

  if (ma20 && ma50) {
    if (price > ma20 && ma20 > ma50) { score += 12; bullish.push("Uptrend (price > MA20 > MA50)"); }
    else if (price < ma20 && ma20 < ma50) { score -= 12; bearish.push("Downtrend (price < MA20 < MA50)"); }
  }

  const recentVol = sma(volumes, 5);
  const avgVol = sma(volumes, Math.min(volumes.length, 60));
  if (recentVol && avgVol && recentVol > avgVol * 1.4) {
    score += 5; bullish.push("Volume above average");
  }

  return {
    score: clamp(score),
    bullish, bearish,
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

  if (r1w > 5)       { score += 8;  bullish.push(`Strong 1-week move (+${r1w.toFixed(1)}%)`); }
  else if (r1w < -5) { score -= 8;  bearish.push(`Weak 1-week move (${r1w.toFixed(1)}%)`); }

  if (r1m > 10)       { score += 14; bullish.push(`Strong 1-month move (+${r1m.toFixed(1)}%)`); }
  else if (r1m < -10) { score -= 14; bearish.push(`Weak 1-month move (${r1m.toFixed(1)}%)`); }

  if (r3m > 20)       { score += 10; bullish.push(`Strong 3-month move (+${r3m.toFixed(1)}%)`); }
  else if (r3m < -20) { score -= 10; bearish.push(`Weak 3-month move (${r3m.toFixed(1)}%)`); }

  // annualized volatility penalty
  if (n >= 21) {
    const rets = [];
    for (let i = n - 20; i < n; i++) rets.push(c[i] / c[i - 1] - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const annVol = Math.sqrt(variance) * Math.sqrt(252) * 100;
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
  const roe = m.roeTTM;                  // already a percentage in Finnhub
  const debtEq = m["totalDebt/totalEquityQuarterly"] ?? m.longTermDebt2EquityQuarterly;
  const revGrowth = m.revenueGrowthTTMYoy;   // percentage
  const netMargin = m.netProfitMarginTTM;    // percentage

  if (pe != null) {
    if (pe > 8 && pe < 18)  { score += 12; bullish.push(`Attractive P/E (${pe.toFixed(1)})`); }
    else if (pe > 35)       { score -= 12; bearish.push(`High P/E (${pe.toFixed(1)})`); }
    else if (pe < 0)        { score -= 8;  bearish.push("Negative earnings (no P/E)"); }
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
    const latest = recArray[0]; // most recent period
    const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = latest;
    const total = strongBuy + buy + hold + sell + strongSell;

    if (total > 0) {
      // weighted: strongBuy=100 ... strongSell=0
      const weighted =
        (strongBuy * 100 + buy * 75 + hold * 50 + sell * 25 + strongSell * 0) / total;
      score = weighted;

      const bullishCount = strongBuy + buy;
      const bearishCount = sell + strongSell;

      if (weighted >= 75)      rating = "Strong Buy";
      else if (weighted >= 60) rating = "Buy";
      else if (weighted >= 45) rating = "Hold";
      else if (weighted >= 30) rating = "Sell";
      else                     rating = "Strong Sell";

      if (bullishCount > bearishCount) {
        bullish.push(`Analysts lean bullish (${bullishCount} buy vs ${bearishCount} sell)`);
      } else if (bearishCount > bullishCount) {
        bearish.push(`Analysts lean bearish (${bearishCount} sell vs ${bullishCount} buy)`);
      }
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

  const headlines = Array.isArray(newsArray) ? newsArray.length : 0;
  return { score: clamp(score), bullish, bearish, headlines };
}

/* ============================================================
   ORCHESTRATION
   ============================================================ */
async function analyze(ticker) {
  // 1. Price history (Stooq) — required
  setLoading(true, "Fetching price history…");
  const rows = await fetchPriceHistory(ticker);

  // 2. Finnhub data in parallel — tolerate individual failures
  setLoading(true, "Fetching fundamentals, analyst & news data…");
  const [profile, quote, metrics, recs, news] = await Promise.allSettled([
    fetchProfile(ticker),
    fetchQuote(ticker),
    fetchMetrics(ticker),
    fetchRecommendations(ticker),
    fetchNews(ticker),
  ]);

  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  const profileD = val(profile);
  const quoteD = val(quote);
  const metricsD = val(metrics);
  const recsD = val(recs);
  const newsD = val(news);

  // 3. Score each factor
  setLoading(true, "Crunching the numbers…");
  const tech = scoreTechnical(rows);
  const mom = scoreMomentum(rows);
  const fund = scoreFundamental(metricsD);
  const analyst = scoreAnalyst(recsD);
  const sentiment = scoreSentiment(newsD);

  // 4. Weighted overall
  const overall =
    0.25 * tech.score +
    0.25 * fund.score +
    0.20 * mom.score +
    0.15 * sentiment.score +
    0.15 * analyst.score;

  // 5. Confidence from agreement between factors + data completeness
  const scores = [tech.score, fund.score, mom.score, sentiment.score, analyst.score];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  let confidence = clamp(100 - std * 1.5);
  const sourcesUsed = ["Stooq"];
  if (metricsD) sourcesUsed.push("Finnhub fundamentals");
  if (recsD) sourcesUsed.push("Finnhub analyst");
  if (newsD) sourcesUsed.push("Finnhub news");
  if (sourcesUsed.length >= 3) confidence = clamp(confidence + 8);

  // 6. Risk level from beta (Finnhub metric) or volatility fallback
  const beta = metricsD?.metric?.beta;
  let risk = "Medium";
  if (beta != null) {
    if (beta > 1.5) risk = "High";
    else if (beta < 0.8) risk = "Low";
  }

  // 7. Recommendation label from overall
  let recommendation = "HOLD";
  if (overall >= 70) recommendation = "BUY";
  else if (overall < 45) recommendation = "SELL";

  const price = quoteD && quoteD.c ? quoteD.c : rows[rows.length - 1].close;

  return {
    ticker: ticker.toUpperCase(),
    name: profileD?.name || ticker.toUpperCase(),
    price,
    overall,
    confidence,
    risk,
    recommendation,
    scores: {
      technical: tech.score,
      fundamental: fund.score,
      momentum: mom.score,
      sentiment: sentiment.score,
      analyst: analyst.score,
    },
    analystRating: analyst.rating,
    bullish: [...tech.bullish, ...fund.bullish, ...mom.bullish, ...sentiment.bullish, ...analyst.bullish],
    bearish: [...tech.bearish, ...fund.bearish, ...mom.bearish, ...sentiment.bearish, ...analyst.bearish],
    explanation: `${tech.detail} | ${fund.detail} | 1M move: ${mom.r1m.toFixed(1)}% | Sentiment: ${sentiment.score.toFixed(0)}/100 | Analyst: ${analyst.rating}`,
    sources: sourcesUsed,
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
  const numEl = document.getElementById(numId);
  const barEl = document.getElementById(barId);
  numEl.textContent = Math.round(score);
  barEl.className = "score-fill " + barClass(score);
  // delay so the CSS width transition animates
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
  // Summary
  document.getElementById("result-ticker").textContent = a.ticker;
  document.getElementById("result-name").textContent = a.name;
  document.getElementById("result-updated").textContent =
    "Updated: " + new Date().toLocaleString();
  document.getElementById("overall-value").textContent = Math.round(a.overall);

  const badge = document.getElementById("recommendation-badge");
  badge.textContent = a.recommendation;
  badge.className = "recommendation-badge " + a.recommendation.toLowerCase();

  // Stats
  document.getElementById("confidence-value").textContent = Math.round(a.confidence) + "%";
  document.getElementById("risk-value").textContent = a.risk;
  document.getElementById("price-value").textContent =
    a.price != null ? "$" + a.price.toFixed(2) : "—";
  document.getElementById("target-value").textContent =
    a.analystRating !== "N/A" ? a.analystRating : "—";

  // Sub-scores
  fillScore("technical-num", "technical-bar", a.scores.technical);
  fillScore("fundamental-num", "fundamental-bar", a.scores.fundamental);
  fillScore("momentum-num", "momentum-bar", a.scores.momentum);
  fillScore("sentiment-num", "sentiment-bar", a.scores.sentiment);
  fillScore("analyst-num", "analyst-bar", a.scores.analyst);

  // Factors
  fillList("bullish-list", a.bullish, "No notable bullish signals.");
  fillList("bearish-list", a.bearish, "No notable bearish signals.");

  // Explanation + sources
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
    const result = await analyze(ticker);
    render(result);
  } catch (err) {
    console.error(err);
    showError(err.message || "Analysis failed. Try another ticker.");
  }
});
