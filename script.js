/* ============================================================
   MarketLens — script.js  (LIVE ONLY — no demo mode)
   5-factor stock analysis · Finnhub + Stooq
   Features: autocomplete, chart, compare, watchlist, history,
   caching, export, keyboard shortcuts, dark/light theme.
   ============================================================ */

/* ---------------- CONFIG — EDIT THIS ---------------- */
const FINNHUB_KEY = "d978kb1r01qluk1jllpgd978kb1r01qluk1jllq0"; // <<< paste your Finnhub API key between the quotes
const CACHE_MINUTES = 15;                    // how long an analysis stays cached
/* ----------------------------------------------------- */

/* ============================================================
   DOM SHORTCUTS
   ============================================================ */
const $ = (id) => document.getElementById(id);

const input = $("ticker-input");
const suggestionsEl = $("suggestions");
const statusEl = $("status");
const resultsEl = $("results");

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setStatus(msg, kind = "loading") {
  statusEl.textContent = msg;
  statusEl.className = "status " + kind;
  show(statusEl);
}
function clearStatus() { hide(statusEl); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ============================================================
   FORMATTERS
   ============================================================ */
function fmtNum(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + Number(n).toFixed(d) + "%";
}
function fmtCap(millions) {
  if (!millions || isNaN(millions)) return "—";
  if (millions >= 1e6) return "$" + (millions / 1e6).toFixed(2) + "T";
  if (millions >= 1e3) return "$" + (millions / 1e3).toFixed(1) + "B";
  return "$" + millions.toFixed(0) + "M";
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ============================================================
   THEME
   ============================================================ */
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  document.documentElement.dataset.theme = saved || (prefersLight ? "light" : "dark");
})();

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  if (window.lastRows) drawChart(window.lastRows.slice(-chartDays)); // redraw chart in new colors
}
$("theme-toggle").addEventListener("click", toggleTheme);

/* ============================================================
   TABS
   ============================================================ */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "watchlist") renderWatchlist();
  });
});

/* ============================================================
   STORAGE HELPERS (watchlist · history · cache)
   ============================================================ */
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function getWatchlist() { return loadJSON("ml_watchlist", []); }
function setWatchlist(w) { saveJSON("ml_watchlist", w); updateWatchCount(); }
function updateWatchCount() { $("watch-count").textContent = getWatchlist().length; }

function getHistory() { return loadJSON("ml_history", []); }
function pushHistory(sym) {
  let h = getHistory().filter((s) => s !== sym);
  h.unshift(sym);
  h = h.slice(0, 10);
  saveJSON("ml_history", h);
  renderHistory();
}
function renderHistory() {
  const h = getHistory();
  if (!h.length) { hide($("history-strip")); return; }
  $("history-items").innerHTML = h
    .map((s) => `<a class="history-item" data-sym="${s}">${s}</a>`)
    .join("");
  show($("history-strip"));
}
$("history-items").addEventListener("click", (e) => {
  const sym = e.target.dataset.sym;
  if (sym) runAnalysis(sym);
});

function cacheGet(sym) {
  const c = loadJSON("ml_cache_" + sym, null);
  if (c && Date.now() - c.t < CACHE_MINUTES * 60 * 1000) return c.data;
  return null;
}
function cacheSet(sym, data) {
  saveJSON("ml_cache_" + sym, { t: Date.now(), data });
}

/* ============================================================
   DATA LAYER (Finnhub + Stooq) — LIVE ONLY
   ============================================================ */
async function finnhub(path, params = {}) {
  const url = new URL("https://finnhub.io/api/v1" + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("token", FINNHUB_KEY);
  const res = await fetch(url);
  if (res.status === 401) throw new Error("Finnhub 401 — API key invalid or missing (check line 10 of script.js)");
  if (res.status === 429) throw new Error("Finnhub 429 — rate limit hit, wait a minute and try again");
  if (!res.ok) throw new Error("Finnhub error " + res.status);
  return res.json();
}

async function stooqHistory(sym) {
  // Stooq uses lowercase symbols, dots become dashes, US suffix
  const s = sym.toLowerCase().replace(/\./g, "-") + ".us";
  const stooqUrl = `https://stooq.com/q/d/l/?s=${s}&i=d`;

  let csv = null;

  // Attempt 1: direct fetch
  try {
    const res = await fetch(stooqUrl);
    if (res.ok) csv = await res.text();
  } catch (e) {
    console.warn("Stooq direct fetch blocked (CORS), retrying via proxy…");
  }

  // Attempt 2: CORS proxy fallback
  if (!csv) {
    const res = await fetch("https://corsproxy.io/?url=" + encodeURIComponent(stooqUrl));
    if (!res.ok) throw new Error("Stooq unreachable (direct + proxy both failed)");
    csv = await res.text();
  }

  const lines = csv.trim().split("\n").slice(1); // drop header
  const rows = lines
    .map((l) => {
      const [date, , , , close] = l.split(",");
      return { date: new Date(date), close: parseFloat(close) };
    })
    .filter((r) => !isNaN(r.close));
  if (rows.length < 60) throw new Error("Stooq returned no price history for " + sym.toUpperCase() + " — ticker may not exist on Stooq");
  return rows.slice(-252); // ~1 trading year
}

async function fetchBundle(sym) {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 86400000);
  const d = (x) => x.toISOString().slice(0, 10);

  const [profile, quote, metricRes, recsArr, news, rows] = await Promise.all([
    finnhub("/stock/profile2", { symbol: sym }),
    finnhub("/quote", { symbol: sym }),
    finnhub("/stock/metric", { symbol: sym, metric: "all" }),
    finnhub("/stock/recommendation", { symbol: sym }),
    finnhub("/company-news", { symbol: sym, from: d(from), to: d(to) }),
    stooqHistory(sym),
  ]);
  if (!quote || !quote.c) throw new Error("No quote returned — check the ticker symbol");
  return {
    profile: profile || {},
    quote,
    metric: (metricRes && metricRes.metric) || {},
    recs: (recsArr && recsArr[0]) || null,
    news: (news || []).slice(0, 6),
    rows,
  };
}

/* ============================================================
   TECHNICAL INDICATORS
   ============================================================ */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function macd(values) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);
  const line = values.map((_, i) =>
    e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null
  );
  const valid = line.filter((v) => v !== null);
  const sig = ema(valid, 9);
  const macdVal = valid[valid.length - 1];
  const sigVal = sig[sig.length - 1];
  return { macd: macdVal, signal: sigVal, hist: macdVal - sigVal };
}

function bollingerPosition(values, period = 20) {
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  if (sd === 0) return 0.5;
  const last = values[values.length - 1];
  // 0 = at lower band, 1 = at upper band
  return (last - (mean - 2 * sd)) / (4 * sd);
}

function annualVolatility(values) {
  const rets = [];
  for (let i = 1; i < values.length; i++) rets.push(values[i] / values[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return sd * Math.sqrt(252) * 100; // %
}

function periodReturn(values, days) {
  if (values.length <= days) return null;
  return (values[values.length - 1] / values[values.length - 1 - days] - 1) * 100;
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/* ============================================================
   SCORING — each factor returns { score, reasons[] }
   ============================================================ */
function scoreTechnical(t) {
  let s = 50;
  const why = [];
  if (t.price > t.ma20) { s += 8; why.push("Price above MA20 (short-term uptrend)"); }
  else { s -= 8; why.push("Price below MA20 (short-term weakness)"); }
  if (t.price > t.ma50) { s += 8; why.push("Price above MA50 (medium-term uptrend)"); }
  else { s -= 8; why.push("Price below MA50"); }
  if (t.ma20 > t.ma50) { s += 6; why.push("MA20 above MA50 (bullish crossover)"); }
  else { s -= 6; why.push("MA20 below MA50 (bearish alignment)"); }

  if (t.rsi > 70) { s -= 10; why.push(`RSI ${t.rsi.toFixed(0)} — overbought`); }
  else if (t.rsi < 30) { s += 8; why.push(`RSI ${t.rsi.toFixed(0)} — oversold, possible rebound`); }
  else if (t.rsi >= 45 && t.rsi <= 65) { s += 6; why.push(`RSI ${t.rsi.toFixed(0)} — healthy zone`); }
  else { why.push(`RSI ${t.rsi.toFixed(0)} — neutral`); }

  if (t.macdHist > 0) { s += 8; why.push("MACD histogram positive (momentum building)"); }
  else { s -= 6; why.push("MACD histogram negative"); }

  if (t.boll > 0.95) { s -= 6; why.push("Pressing the upper Bollinger band (stretched)"); }
  else if (t.boll < 0.05) { s += 4; why.push("Near lower Bollinger band"); }

  return { score: clamp(Math.round(s)), reasons: why };
}

function scoreFundamental(m) {
  let s = 50;
  const why = [];
  const pe = m.peTTM ?? m.peBasicExclExtraTTM;
  if (pe && pe > 0) {
    if (pe < 18) { s += 12; why.push(`P/E ${pe.toFixed(1)} — attractively valued`); }
    else if (pe < 30) { s += 4; why.push(`P/E ${pe.toFixed(1)} — reasonable`); }
    else if (pe < 50) { s -= 6; why.push(`P/E ${pe.toFixed(1)} — expensive`); }
    else { s -= 12; why.push(`P/E ${pe.toFixed(1)} — very expensive`); }
  } else { why.push("No positive P/E (unprofitable or data missing)"); s -= 4; }

  const roe = m.roeTTM;
  if (roe != null) {
    if (roe > 20) { s += 10; why.push(`ROE ${roe.toFixed(1)}% — excellent profitability`); }
    else if (roe > 10) { s += 5; why.push(`ROE ${roe.toFixed(1)}% — solid`); }
    else if (roe < 0) { s -= 10; why.push(`ROE ${roe.toFixed(1)}% — losing money on equity`); }
  }

  const nm = m.netProfitMarginTTM;
  if (nm != null) {
    if (nm > 20) { s += 8; why.push(`Net margin ${nm.toFixed(1)}% — highly profitable`); }
    else if (nm > 8) { s += 4; why.push(`Net margin ${nm.toFixed(1)}% — healthy`); }
    else if (nm < 0) { s -= 8; why.push(`Negative net margin (${nm.toFixed(1)}%)`); }
  }

  const de = m["totalDebt/totalEquityQuarterly"];
  if (de != null) {
    if (de < 0.5) { s += 5; why.push(`Debt/equity ${de.toFixed(2)} — low leverage`); }
    else if (de > 1.5) { s -= 6; why.push(`Debt/equity ${de.toFixed(2)} — heavy debt load`); }
  }

  const rg = m.revenueGrowthTTMYoy;
  if (rg != null) {
    if (rg > 20) { s += 8; why.push(`Revenue growing ${rg.toFixed(1)}% YoY — fast grower`); }
    else if (rg > 5) { s += 4; why.push(`Revenue growing ${rg.toFixed(1)}% YoY`); }
    else if (rg < 0) { s -= 8; why.push(`Revenue shrinking (${rg.toFixed(1)}% YoY)`); }
  }

  return { score: clamp(Math.round(s)), reasons: why };
}

function scoreMomentum(mom) {
  let s = 50;
  const why = [];
  const bands = [
    [mom.r1m, 1.5, "1-month"],
    [mom.r3m, 1.0, "3-month"],
    [mom.r6m, 0.6, "6-month"],
  ];
  for (const [r, w, label] of bands) {
    if (r === null) continue;
    const add = clamp(r * w, -14, 14);
    s += add;
    why.push(`${label} return ${fmtPct(r)}`);
  }
  if (mom.pos52 != null) {
    if (mom.pos52 > 0.85) { s += 5; why.push("Trading near its 52-week high (strength)"); }
    else if (mom.pos52 < 0.2) { s -= 5; why.push("Trading near its 52-week low"); }
  }
  return { score: clamp(Math.round(s)), reasons: why };
}

const POS_WORDS = ["beat", "beats", "surge", "record", "growth", "upgrade", "raise", "raises", "strong", "profit", "wins", "expansion", "rally", "soar", "outperform", "buy"];
const NEG_WORDS = ["miss", "misses", "fall", "falls", "drop", "cut", "cuts", "downgrade", "lawsuit", "probe", "weak", "loss", "losses", "recall", "warning", "layoff", "decline", "plunge", "sell-off", "underperform"];

function scoreSentiment(news) {
  if (!news || !news.length) return { score: 50, reasons: ["No recent news found — neutral"], tagged: [] };
  let pos = 0, neg = 0;
  const tagged = news.map((n) => {
    const h = (n.headline || "").toLowerCase();
    const p = POS_WORDS.some((w) => h.includes(w));
    const g = NEG_WORDS.some((w) => h.includes(w));
    let tag = "neu";
    if (p && !g) { pos++; tag = "pos"; }
    else if (g && !p) { neg++; tag = "neg"; }
    return { ...n, tag };
  });
  const total = pos + neg;
  let s = 50;
  const why = [`${news.length} headlines scanned: ${pos} positive, ${neg} negative`];
  if (total > 0) {
    s = 50 + ((pos - neg) / news.length) * 45;
    if (pos > neg) why.push("News flow leans positive");
    else if (neg > pos) why.push("News flow leans negative");
    else why.push("News flow is mixed");
  } else why.push("Headlines are mostly neutral");
  return { score: clamp(Math.round(s)), reasons: why, tagged };
}

function scoreAnalyst(recs) {
  if (!recs) return { score: 50, reasons: ["No analyst coverage found — neutral"] };
  const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = recs;
  const total = strongBuy + buy + hold + sell + strongSell;
  if (!total) return { score: 50, reasons: ["No analyst ratings available"] };
  const raw = (2 * strongBuy + buy - sell - 2 * strongSell) / (2 * total); // -1..1
  const s = clamp(Math.round(50 + raw * 50));
  const why = [
    `${total} analysts: ${strongBuy} strong buy, ${buy} buy, ${hold} hold, ${sell + strongSell} sell`,
    raw > 0.3 ? "Street is clearly bullish" : raw < -0.1 ? "Street is cautious" : "Street is split",
  ];
  return { score: s, reasons: why };
}

/* ============================================================
   ANALYSIS PIPELINE
   ============================================================ */
const WEIGHTS = { technical: 0.25, fundamental: 0.25, momentum: 0.20, sentiment: 0.15, analyst: 0.15 };
const BUY_AT = 62, SELL_AT = 42; // calibrated thresholds

async function analyze(symRaw) {
  const sym = symRaw.trim().toUpperCase();
  const cached = cacheGet(sym);
  if (cached) return cached;

  const b = await fetchBundle(sym);
  const closes = b.rows.map((r) => r.close);
  const price = b.quote.c;

  const ma20a = sma(closes, 20), ma50a = sma(closes, 50);
  const tech = {
    price,
    ma20: ma20a[ma20a.length - 1],
    ma50: ma50a[ma50a.length - 1],
    rsi: rsi(closes),
    macdHist: macd(closes).hist,
    boll: bollingerPosition(closes),
    vol: annualVolatility(closes),
  };

  const high52 = b.metric["52WeekHigh"] ?? Math.max(...closes);
  const low52 = b.metric["52WeekLow"] ?? Math.min(...closes);
  const mom = {
    r1m: periodReturn(closes, 21),
    r3m: periodReturn(closes, 63),
    r6m: periodReturn(closes, 126),
    pos52: high52 > low52 ? (price - low52) / (high52 - low52) : 0.5,
  };

  const fTech = scoreTechnical(tech);
  const fFund = scoreFundamental(b.metric);
  const fMom = scoreMomentum(mom);
  const fSent = scoreSentiment(b.news);
  const fAna = scoreAnalyst(b.recs);

  const factors = {
    technical: fTech, fundamental: fFund, momentum: fMom, sentiment: fSent, analyst: fAna,
  };

  const overall = Math.round(
    Object.entries(WEIGHTS).reduce((acc, [k, w]) => acc + factors[k].score * w, 0)
  );
  const verdict = overall >= BUY_AT ? "BUY" : overall <= SELL_AT ? "SELL" : "HOLD";

  // confidence = how much the five factors agree
  const scores = Object.values(factors).map((f) => f.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const spread = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  const confidence = spread < 10 ? "High confidence" : spread < 18 ? "Medium confidence" : "Low confidence — factors disagree";

  // risk 0..100 from beta + volatility
  const beta = b.metric.beta ?? 1;
  const risk = clamp(Math.round((clamp(beta, 0, 2.5) / 2.5) * 50 + (clamp(tech.vol, 0, 80) / 80) * 50));

  const analysis = {
    sym, price, bundle: b, tech, mom, factors, overall, verdict, confidence,
    risk, high52, low52, rows: b.rows, taggedNews: fSent.tagged || [],
    time: Date.now(),
  };
  analysis.summary = buildSummary(analysis);
  cacheSet(sym, analysis);
  return analysis;
}

function buildSummary(a) {
  const name = a.bundle.profile.name || a.sym;
  const entries = Object.entries(a.factors);
  const best = entries.reduce((x, y) => (y[1].score > x[1].score ? y : x));
  const worst = entries.reduce((x, y) => (y[1].score < x[1].score ? y : x));
  const trend = a.tech.price > a.tech.ma50 ? "trading above its 50-day average" : "trading below its 50-day average";
  const riskWord = a.risk > 66 ? "high" : a.risk > 40 ? "moderate" : "low";
  const verdictLine =
    a.verdict === "BUY" ? "the overall picture leans positive"
    : a.verdict === "SELL" ? "the overall picture leans negative"
    : "the picture is mixed, suggesting patience";
  return `${name} scores ${a.overall}/100 — ${verdictLine}. Its strongest factor is ${best[0]} (${best[1].score}) while ${worst[0]} (${worst[1].score}) drags the score down. The stock is currently ${trend}, sits at ${(a.mom.pos52 * 100).toFixed(0)}% of its 52-week range, and carries ${riskWord} risk (beta ${fmtNum(a.bundle.metric.beta, 2)}, volatility ${a.tech.vol.toFixed(0)}%). ${a.confidence}. This is a model output for research — not financial advice.`;
}

/* ============================================================
   RENDERING
   ============================================================ */
let current = null;

function animateScore(target) {
  const el = $("score-value");
  const start = performance.now();
  const dur = 800;
  function step(now) {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))); // ease-out
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function render(a) {
  current = a;
  const p = a.bundle.profile, q = a.bundle.quote, m = a.bundle.metric;

  // profile
  if (p.logo) { $("p-logo").src = p.logo; show($("p-logo")); } else hide($("p-logo"));
  $("p-name").textContent = p.name || a.sym;
  $("p-symbol").textContent = a.sym;
  $("p-exchange").textContent = p.exchange || "—";
  $("p-industry").textContent = p.finnhubIndustry || "—";
  $("p-mcap").textContent = fmtCap(p.marketCapitalization);
  $("p-price").textContent = "$" + fmtNum(q.c);
  const chEl = $("p-change");
  chEl.textContent = `${q.d >= 0 ? "+" : ""}${fmtNum(q.d)} (${fmtPct(q.dp)}) today`;
  chEl.className = "p-change mono " + (q.d >= 0 ? "up" : "down");

  // gauge + verdict
  const C = 326.7;
  const arc = $("gauge-arc");
  arc.style.strokeDashoffset = C * (1 - a.overall / 100);
  const color = a.verdict === "BUY" ? "var(--up)" : a.verdict === "SELL" ? "var(--down)" : "var(--warn)";
  arc.style.stroke = color;
  animateScore(a.overall);
  const vb = $("verdict-badge");
  vb.textContent = a.verdict;
  vb.className = "verdict-badge " + a.verdict.toLowerCase();
  $("confidence").textContent = a.confidence;
  $("summary-text").textContent = a.summary;

  // watch button state
  const inList = getWatchlist().some((w) => w.sym === a.sym);
  const bw = $("btn-watch");
  bw.textContent = inList ? "★ In watchlist" : "☆ Add to watchlist";
  bw.classList.toggle("active", inList);

  renderFactors(a);
  window.lastRows = a.rows;
  drawChart(a.rows.slice(-chartDays));
  renderRange(a);
  renderMetricStrip(a);
  renderFundamentals(m);
  renderTechnicals(a.tech);
  renderAnalyst(a.bundle.recs);
  renderRisk(a);
  renderNews(a);

  show(resultsEl);
}

function factorColor(s) {
  return s >= BUY_AT ? "var(--up)" : s <= SELL_AT ? "var(--down)" : "var(--warn)";
}

function renderFactors(a) {
  const names = { technical: "Technical", fundamental: "Fundamental", momentum: "Momentum", sentiment: "Sentiment", analyst: "Analyst" };
  $("factor-grid").innerHTML = Object.entries(a.factors)
    .map(([k, f]) => `
      <div class="factor-card" data-f="${k}">
        <div class="factor-head">
          <span class="factor-name">${names[k]} · ${(WEIGHTS[k] * 100).toFixed(0)}%</span>
          <span class="factor-score" style="color:${factorColor(f.score)}">${f.score}</span>
        </div>
        <div class="factor-bar"><div class="factor-fill" style="background:${factorColor(f.score)}"></div></div>
        <div class="factor-why">${f.reasons.map((r) => "• " + escapeHtml(r)).join("<br>")}</div>
        <div class="factor-hint">click for details</div>
      </div>`)
    .join("");
  // animate bars after insert
  requestAnimationFrame(() => {
    document.querySelectorAll(".factor-card").forEach((card) => {
      const k = card.dataset.f;
      card.querySelector(".factor-fill").style.width = a.factors[k].score + "%";
      card.addEventListener("click", () => card.classList.toggle("open"));
    });
  });
}

function renderRange(a) {
  $("range-low").textContent = "$" + fmtNum(a.low52);
  $("range-high").textContent = "$" + fmtNum(a.high52);
  $("range-marker").style.left = clamp(a.mom.pos52 * 100, 1, 99) + "%";
}

function renderMetricStrip(a) {
  const cells = [
    ["RSI (14)", a.tech.rsi.toFixed(0)],
    ["1M return", fmtPct(a.mom.r1m)],
    ["3M return", fmtPct(a.mom.r3m)],
    ["6M return", fmtPct(a.mom.r6m)],
    ["Volatility", a.tech.vol.toFixed(0) + "%"],
    ["Beta", fmtNum(a.bundle.metric.beta, 2)],
  ];
  $("metric-strip").innerHTML = cells
    .map(([k, v]) => `<div class="metric-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

function statRow(k, v, cls = "") {
  return `<div class="stat-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
}

function renderFundamentals(m) {
  const pe = m.peTTM ?? m.peBasicExclExtraTTM;
  const rows = [
    ["P/E (TTM)", pe ? fmtNum(pe, 1) : "—", pe && pe < 25 ? "good" : pe > 45 ? "bad" : ""],
    ["P/S (TTM)", m.psTTM ? fmtNum(m.psTTM, 1) : "—", ""],
    ["EPS (TTM)", m.epsTTM ? "$" + fmtNum(m.epsTTM) : "—", ""],
    ["ROE", m.roeTTM != null ? fmtNum(m.roeTTM, 1) + "%" : "—", m.roeTTM > 15 ? "good" : m.roeTTM < 0 ? "bad" : ""],
    ["Net margin", m.netProfitMarginTTM != null ? fmtNum(m.netProfitMarginTTM, 1) + "%" : "—", m.netProfitMarginTTM > 15 ? "good" : m.netProfitMarginTTM < 0 ? "bad" : ""],
    ["Gross margin", m.grossMarginTTM != null ? fmtNum(m.grossMarginTTM, 1) + "%" : "—", ""],
    ["Debt / equity", m["totalDebt/totalEquityQuarterly"] != null ? fmtNum(m["totalDebt/totalEquityQuarterly"], 2) : "—", m["totalDebt/totalEquityQuarterly"] > 1.5 ? "bad" : ""],
    ["Dividend yield", m.dividendYieldIndicatedAnnual ? fmtNum(m.dividendYieldIndicatedAnnual, 2) + "%" : "0%", ""],
    ["Revenue growth YoY", m.revenueGrowthTTMYoy != null ? fmtPct(m.revenueGrowthTTMYoy) : "—", m.revenueGrowthTTMYoy > 10 ? "good" : m.revenueGrowthTTMYoy < 0 ? "bad" : ""],
    ["Beta", m.beta != null ? fmtNum(m.beta, 2) : "—", ""],
  ];
  $("fundamentals-grid").innerHTML = rows.map((r) => statRow(...r)).join("");
}

function renderTechnicals(t) {
  const rows = [
    ["Price", "$" + fmtNum(t.price), ""],
    ["MA20", "$" + fmtNum(t.ma20), t.price > t.ma20 ? "good" : "bad"],
    ["MA50", "$" + fmtNum(t.ma50), t.price > t.ma50 ? "good" : "bad"],
    ["RSI (14)", t.rsi.toFixed(1), t.rsi > 70 ? "bad" : t.rsi < 30 ? "good" : ""],
    ["MACD histogram", fmtNum(t.macdHist, 3), t.macdHist > 0 ? "good" : "bad"],
    ["Bollinger position", (t.boll * 100).toFixed(0) + "%", ""],
    ["Annualized volatility", t.vol.toFixed(1) + "%", t.vol > 50 ? "bad" : ""],
  ];
  $("technicals-grid").innerHTML = rows.map((r) => statRow(...r)).join("");
}

function renderAnalyst(recs) {
  const el = $("analyst-bars");
  if (!recs) {
    el.innerHTML = "";
    $("analyst-note").textContent = "No analyst coverage found for this ticker.";
    return;
  }
  const data = [
    ["Strong buy", recs.strongBuy || 0, "var(--up)"],
    ["Buy", recs.buy || 0, "#7fd4b8"],
    ["Hold", recs.hold || 0, "var(--warn)"],
    ["Sell", recs.sell || 0, "#e89795"],
    ["Strong sell", recs.strongSell || 0, "var(--down)"],
  ];
  const max = Math.max(1, ...data.map((d) => d[1]));
  el.innerHTML = data
    .map(([k, n, c]) => `
      <div class="abar">
        <span class="k">${k}</span>
        <div class="track"><div class="fill" data-w="${(n / max) * 100}" style="background:${c}"></div></div>
        <span class="n">${n}</span>
      </div>`)
    .join("");
  requestAnimationFrame(() => {
    el.querySelectorAll(".fill").forEach((f) => (f.style.width = f.dataset.w + "%"));
  });
  const total = data.reduce((a, d) => a + d[1], 0);
  $("analyst-note").textContent = `${total} analysts covering, latest month of ratings.`;
}

function renderRisk(a) {
  $("risk-fill").style.width = a.risk + "%";
  const word = a.risk > 66 ? "High" : a.risk > 40 ? "Moderate" : "Low";
  $("risk-label").textContent = `${word} risk — based on beta (${fmtNum(a.bundle.metric.beta, 2)}) and 1-year volatility (${a.tech.vol.toFixed(0)}%).`;
}

function renderNews(a) {
  const list = a.taggedNews.length ? a.taggedNews : (a.bundle.news || []).map((n) => ({ ...n, tag: "neu" }));
  if (!list.length) {
    $("news-list").innerHTML = `<li class="muted small">No recent news found.</li>`;
    return;
  }
  const tagText = { pos: "POSITIVE", neg: "NEGATIVE", neu: "NEUTRAL" };
  $("news-list").innerHTML = list
    .slice(0, 6)
    .map((n) => `
      <li class="news-item">
        <span class="sent-tag ${n.tag}">${tagText[n.tag]}</span>
        <div>
          <a href="${escapeHtml(n.url || "#")}" target="_blank" rel="noopener">${escapeHtml(n.headline)}</a>
          <div class="news-meta">${escapeHtml(n.source || "")} · ${fmtDate((n.datetime || 0) * 1000)}</div>
        </div>
      </li>`)
    .join("");
}

/* ============================================================
   PRICE CHART (canvas, DPR-aware, with hover tooltip)
   ============================================================ */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let chartGeo = null;   // saved geometry for tooltip
let chartDays = 252;   // visible range: 63 = 3M, 126 = 6M, 252 = 1Y

document.querySelectorAll(".range-btn").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    chartDays = parseInt(b.dataset.days, 10);
    if (window.lastRows) drawChart(window.lastRows.slice(-chartDays));
  });
});

function drawChart(rows) {
  const canvas = $("price-chart");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const closes = rows.map((r) => r.close);
  const ma20a = sma(closes, 20), ma50a = sma(closes, 50);
  const pad = { l: 52, r: 12, t: 12, b: 24 };
  const min = Math.min(...closes) * 0.98;
  const max = Math.max(...closes) * 1.02;

  const x = (i) => pad.l + (i / (rows.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  chartGeo = { x, y, rows, pad, W, H };

  // gridlines + y labels
  ctx.strokeStyle = cssVar("--border");
  ctx.fillStyle = cssVar("--text-muted");
  ctx.font = "10px " + cssVar("--mono");
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = min + ((max - min) * g) / 4;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText("$" + v.toFixed(v > 100 ? 0 : 1), 6, yy + 3);
  }
  // x labels (5 dates)
  for (let g = 0; g <= 4; g++) {
    const i = Math.round(((rows.length - 1) * g) / 4);
    ctx.fillText(fmtDate(rows[i].date), x(i) - 14, H - 8);
  }

  // gradient fill under price
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  const accent = cssVar("--accent");
  grad.addColorStop(0, accent + "44");
  grad.addColorStop(1, accent + "00");
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(x(i), y(r.close)) : ctx.moveTo(x(0), y(r.close))));
  ctx.lineTo(x(rows.length - 1), H - pad.b);
  ctx.lineTo(x(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // helper for lines
  function line(arr, color, width) {
    ctx.beginPath();
    let started = false;
    arr.forEach((v, i) => {
      if (v === null) return;
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  line(ma50a, cssVar("--ma50"), 1.4);
  line(ma20a, cssVar("--ma20"), 1.4);
  line(closes, accent, 2.2);
}

// hover crosshair + tooltip
$("price-chart").addEventListener("mousemove", (e) => {
  if (!chartGeo) return;
  const rect = e.target.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const { rows, pad, H } = chartGeo;
  let best = 0, bd = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const d = Math.abs(chartGeo.x(i) - mx);
    if (d < bd) { bd = d; best = i; }
  }
  const r = rows[best];

  // redraw base chart, then overlay crosshair + point
  drawChart(rows);
  const ctx = $("price-chart").getContext("2d");
  const px = chartGeo.x(best), py = chartGeo.y(r.close);
  ctx.strokeStyle = cssVar("--text-muted");
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(px, pad.t);
  ctx.lineTo(px, H - pad.b);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(px, py, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = cssVar("--accent");
  ctx.fill();
  ctx.strokeStyle = cssVar("--bg");
  ctx.lineWidth = 2;
  ctx.stroke();

  const tip = $("chart-tip");
  tip.textContent = `${fmtDate(r.date)} · $${fmtNum(r.close)}`;
  tip.style.left = Math.min(px + 10, chartGeo.W - 130) + "px";
  tip.style.top = "10px";
  show(tip);
});
$("price-chart").addEventListener("mouseleave", () => {
  hide($("chart-tip"));
  if (chartGeo) drawChart(chartGeo.rows); // clear crosshair
});
window.addEventListener("resize", () => { if (window.lastRows) drawChart(window.lastRows.slice(-chartDays)); });

/* ============================================================
   MAIN FLOW
   ============================================================ */
async function runAnalysis(symRaw) {
  const sym = symRaw.trim().toUpperCase();
  if (!sym) return;
  hide(suggestionsEl);
  input.value = sym;
  setStatus(`Analyzing ${sym}…`, "loading");
  hide(resultsEl);
  try {
    const a = await analyze(sym);
    clearStatus();
    render(a);
    pushHistory(sym);
  } catch (err) {
    console.error(err);
    setStatus(err.message || `Could not analyze ${sym}.`, "error");
  }
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runAnalysis(input.value);
});

$("quick-chips").addEventListener("click", (e) => {
  if (e.target.dataset.sym) runAnalysis(e.target.dataset.sym);
});

/* ============================================================
   AUTOCOMPLETE (Finnhub symbol search)
   ============================================================ */
let suggestTimer = null;
let lastQuery = "";

input.addEventListener("input", () => {
  const q = input.value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) { hide(suggestionsEl); return; }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 300);
});

async function fetchSuggestions(q) {
  if (q === lastQuery) return;
  lastQuery = q;
  let results = [];
  try {
    const data = await finnhub("/search", { q });
    results = (data.result || [])
      .filter((r) => r.type === "Common Stock" && !r.symbol.includes("."))
      .slice(0, 6);
  } catch { results = []; }
  if (!results.length) { hide(suggestionsEl); return; }
  suggestionsEl.innerHTML = results
    .map((r) => `
      <div class="suggestion-item" data-sym="${escapeHtml(r.symbol)}">
        <span class="suggestion-symbol">${escapeHtml(r.symbol)}</span>
        <span class="suggestion-name">${escapeHtml(r.description || "")}</span>
      </div>`)
    .join("");
  show(suggestionsEl);
}

suggestionsEl.addEventListener("click", (e) => {
  const item = e.target.closest(".suggestion-item");
  if (item) runAnalysis(item.dataset.sym);
});

document.addEventListener("click", (e) => {
  if (!suggestionsEl.contains(e.target) && e.target !== input) hide(suggestionsEl);
});

/* ============================================================
   WATCHLIST
   ============================================================ */
$("btn-watch").addEventListener("click", () => {
  if (!current) return;
  let w = getWatchlist();
  if (w.some((x) => x.sym === current.sym)) {
    w = w.filter((x) => x.sym !== current.sym);
  } else {
    w.unshift({
      sym: current.sym,
      name: current.bundle.profile.name || current.sym,
      score: current.overall,
      verdict: current.verdict,
      price: current.price,
      changePct: current.bundle.quote.dp,
      t: Date.now(),
    });
  }
  setWatchlist(w);
  render(current); // refresh button state
});

function renderWatchlist() {
  const w = getWatchlist();
  const grid = $("watchlist-grid");
  if (!w.length) { show($("watchlist-empty")); grid.innerHTML = ""; return; }
  hide($("watchlist-empty"));
  grid.innerHTML = w
    .map((x) => `
      <div class="watch-card" data-sym="${x.sym}">
        <button class="watch-remove" data-remove="${x.sym}" title="Remove">✕</button>
        <div class="watch-head">
          <span class="watch-sym">${x.sym}</span>
          <span class="watch-score" style="color:${factorColor(x.score)}">${x.score}</span>
        </div>
        <div class="watch-name">${escapeHtml(x.name)}</div>
        <div class="watch-row">
          <span class="mono">$${fmtNum(x.price)}</span>
          <span class="watch-verdict ${x.verdict.toLowerCase()}">${x.verdict}</span>
        </div>
        <div class="watch-date">saved ${new Date(x.t).toLocaleDateString()}</div>
      </div>`)
    .join("");
}

$("watchlist-grid").addEventListener("click", (e) => {
  const rm = e.target.dataset.remove;
  if (rm) {
    setWatchlist(getWatchlist().filter((x) => x.sym !== rm));
    renderWatchlist();
    return;
  }
  const card = e.target.closest(".watch-card");
  if (card) {
    document.querySelector('[data-tab="analyze"]').click();
    runAnalysis(card.dataset.sym);
  }
});

/* ============================================================
   COMPARE MODE
   ============================================================ */
$("compare-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const syms = [$("cmp-1").value, $("cmp-2").value, $("cmp-3").value]
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(syms)];
  const st = $("compare-status");
  const out = $("compare-result");
  if (unique.length < 2) {
    st.textContent = "Enter at least two different tickers.";
    st.className = "status error";
    show(st); hide(out);
    return;
  }
  st.textContent = `Comparing ${unique.join(" vs ")}…`;
  st.className = "status loading";
  show(st); hide(out);
  try {
    const results = await Promise.all(unique.map((s) => analyze(s)));
    hide(st);
    renderCompare(results);
    show(out);
  } catch (err) {
    console.error(err);
    st.textContent = err.message || "Comparison failed — check the tickers.";
    st.className = "status error";
  }
});

function renderCompare(list) {
  const rowDefs = [
    ["Price", (a) => "$" + fmtNum(a.price), null],
    ["Today", (a) => fmtPct(a.bundle.quote.dp), (a) => a.bundle.quote.dp],
    ["Overall score", (a) => `<span class="mono">${a.overall}</span>`, (a) => a.overall],
    ["Verdict", (a) => `<span class="watch-verdict ${a.verdict.toLowerCase()}">${a.verdict}</span>`, null],
    ["Technical", (a) => a.factors.technical.score, (a) => a.factors.technical.score],
    ["Fundamental", (a) => a.factors.fundamental.score, (a) => a.factors.fundamental.score],
    ["Momentum", (a) => a.factors.momentum.score, (a) => a.factors.momentum.score],
    ["Sentiment", (a) => a.factors.sentiment.score, (a) => a.factors.sentiment.score],
    ["Analyst", (a) => a.factors.analyst.score, (a) => a.factors.analyst.score],
    ["P/E", (a) => { const pe = a.bundle.metric.peTTM ?? a.bundle.metric.peBasicExclExtraTTM; return pe ? fmtNum(pe, 1) : "—"; }, null],
    ["Market cap", (a) => fmtCap(a.bundle.profile.marketCapitalization), null],
    ["Risk", (a) => a.risk + "/100", (a) => -a.risk],
    ["6M return", (a) => fmtPct(a.mom.r6m), (a) => a.mom.r6m ?? -Infinity],
  ];

  const head = `<tr><th></th>${list.map((a) => `<th>${a.sym}</th>`).join("")}</tr>`;
  const body = rowDefs
    .map(([label, fmt, val]) => {
      let winner = -1;
      if (val) {
        const vals = list.map(val);
        const max = Math.max(...vals);
        if (isFinite(max)) winner = vals.indexOf(max);
      }
      const cells = list
        .map((a, i) => `<td class="${i === winner ? "win" : ""}">${fmt(a)}</td>`)
        .join("");
      return `<tr><td>${label}</td>${cells}</tr>`;
    })
    .join("");

  $("compare-result").innerHTML = `<table class="cmp-table"><thead>${head}</thead><tbody>${body}</tbody></table>
    <p class="muted small center" style="margin-top:12px">Green = best in row · scores are model outputs, not advice.</p>`;
}

/* ============================================================
   EXPORT + COPY
   ============================================================ */
$("btn-export").addEventListener("click", () => {
  if (!current) return;
  const data = {
    symbol: current.sym,
    generated: new Date(current.time).toISOString(),
    price: current.price,
    overallScore: current.overall,
    verdict: current.verdict,
    confidence: current.confidence,
    risk: current.risk,
    factors: Object.fromEntries(
      Object.entries(current.factors).map(([k, f]) => [k, { score: f.score, reasons: f.reasons }])
    ),
    summary: current.summary,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${current.sym}_analysis.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("btn-copy").addEventListener("click", async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(`${current.sym} — ${current.overall}/100 (${current.verdict})\n${current.summary}`);
    $("btn-copy").textContent = "Copied ✓";
    setTimeout(() => ($("btn-copy").textContent = "Copy summary"), 1500);
  } catch {}
});

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "/" && !typing) {
    e.preventDefault();
    document.querySelector('[data-tab="analyze"]').click();
    input.focus();
  }
  if ((e.key === "t" || e.key === "T") && !typing) toggleTheme();
  if (e.key === "Escape") { hide(suggestionsEl); input.blur(); }
});

/* ============================================================
   INIT
   ============================================================ */
updateWatchCount();
renderHistory();
if (!FINNHUB_KEY || FINNHUB_KEY === "YOUR_FINNHUB_KEY_HERE") {
  setStatus("No API key set — paste your Finnhub key on line 10 of script.js.", "error");
}
