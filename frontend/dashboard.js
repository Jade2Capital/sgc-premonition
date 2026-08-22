/**
 * dashboard.js — SGC Premonition Dashboard
 * ---------------------------------------------------------------------------
 * The dashboard is a small state machine. Exactly one state is visible at a
 * time, and every path through the app ends in one of them:
 *
 *   loading    → fetching /api/me
 *   noauth     → no access token anywhere
 *   pending    → paid, but the Stripe webhook has not landed yet (we poll)
 *   unpaid     → signed in, no active subscription
 *   dashboard  → the real thing
 *
 * ── THE STRIPE REDIRECT RACE, AND WHY `pending` EXISTS ─────────────────────
 * When Stripe redirects the customer back here, two things are in flight: the
 * browser redirect, and Stripe's webhook call to our server. The browser
 * usually wins. So arriving with ?checkout=success does NOT mean the server
 * knows about the payment yet.
 *
 * We never trust the redirect. We poll /api/billing/status until the webhook
 * has done its work — which is the only correct way to handle this.
 * ---------------------------------------------------------------------------
 */

/* eslint-env browser */
"use strict";

const $  = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STATE MACHINE
   ═══════════════════════════════════════════════════════════════════════════ */

const STATES = ["loading", "noauth", "pending", "unpaid", "dashboard"];

function showState(name) {
  for (const state of STATES) {
    $(`#state-${state}`)?.classList.toggle("hidden", state !== name);
  }
}

/** Session-wide state. */
const state = {
  token: null,
  me: null,        // the /api/me payload
  latestRun: null, // the run currently rendered
};


/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN RESOLUTION

   Priority: ?token= in the URL (fresh from a Stripe redirect or an email link)
   beats whatever is in localStorage, because it is more recent.
   ═══════════════════════════════════════════════════════════════════════════ */

function resolveToken() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");

  if (fromUrl) {
    tokenStore.set(fromUrl);

    // Strip the token from the visible URL so it does not end up in a
    // screenshot, a shared link, or the browser history bar. The value is
    // already saved in localStorage.
    params.delete("token");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (query ? `?${query}` : "")
    );

    return fromUrl;
  }

  return tokenStore.get();
}


/* ═══════════════════════════════════════════════════════════════════════════
   STATUS MESSAGES
   ═══════════════════════════════════════════════════════════════════════════ */

function setStatus(selector, message, type = "error") {
  const box = $(selector);
  if (!box) return;
  if (!message) {
    box.className = "form-status";
    box.textContent = "";
    return;
  }
  box.className = `form-status visible ${type}`;
  box.textContent = message;
}

function setLoading(button, isLoading, loadingText = "Working…") {
  if (!button) return;
  button.classList.toggle("is-loading", isLoading);
  button.disabled = isLoading;
  const label = $(".btn-text", button);
  if (!label) return;
  if (isLoading) {
    label.dataset.original = label.dataset.original || label.textContent;
    label.textContent = loadingText;
  } else if (label.dataset.original) {
    label.textContent = label.dataset.original;
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   RENDERING
   ═══════════════════════════════════════════════════════════════════════════ */

const CATEGORY_ORDER = ["influence", "identity", "infrastructure", "intelligence", "impact"];

/** Header: brand name and the three chips. */
function renderHeader(me) {
  $("#brand-title").textContent = me.brand?.brand_name || "Your brand";

  const profileChip = $("#chip-profile");
  profileChip.textContent = me.profile ? `${me.profile.label} profile` : "No profile";

  const sectorChip = $("#chip-sector");
  if (me.brand?.sector) {
    sectorChip.textContent = me.brand.sector;
    sectorChip.classList.remove("hidden");
  } else {
    sectorChip.classList.add("hidden");
  }

  const statusChip = $("#chip-status");
  const status = me.subscription?.status ?? "none";
  statusChip.textContent = status === "active" ? "Subscription active" : status;
  statusChip.className =
    "chip " + (status === "active" ? "good" : status === "past_due" ? "warn" : "bad");
}

/**
 * Tier definitions from GET /api/matrix.
 *
 * Fresh analyses return the tier note inline, but a run loaded from the
 * database stores only the tier LABEL. Rather than duplicate the tier copy in
 * this file (where it would drift from the engine), we look the note up from
 * the same endpoint the landing page uses.
 */
let tierTable = [];

async function loadTiers() {
  try {
    const matrix = await api("/matrix");
    tierTable = matrix.tiers || [];
  } catch {
    tierTable = [];
  }
}

function tierNoteFor(label, fallback = "") {
  const tier = tierTable.find((t) => t.label === label);
  return tier?.note || fallback;
}

/** The big number, tier, and trajectory. */
function renderScoreHero(run) {
  $("#overall-score").textContent = run.scores.overall;
  $("#tier-label").textContent = run.tier.label;
  $("#tier-note").textContent = tierNoteFor(run.tier.label, run.tier.note);

  const chip = $("#trajectory-chip");
  const label = run.trajectory.label;
  chip.textContent =
    run.trajectory.delta === null
      ? `Trajectory: ${label}`
      : `Trajectory: ${label} (${run.trajectory.delta > 0 ? "+" : ""}${run.trajectory.delta})`;
  chip.className =
    "chip " +
    (label === "Accelerating" || label === "Rising" ? "good"
      : label === "Declining" ? "bad"
      : "");

  $("#trajectory-notes").textContent = run.trajectory.notes;
}

/** The five category bars. */
function renderBars(run, primaryKey) {
  const container = $("#bars");
  const rows = CATEGORY_ORDER.map((key) => {
    const score = run.scores[key];
    const weight = run.weights?.[key];
    const breakdown = (run.report?.breakdown || []).find((b) => b.key === key);

    return el("div", { class: "bar-row" },
      el("div", { class: "bar-label" },
        el("span", { class: "name" },
          key.charAt(0).toUpperCase() + key.slice(1),
          key === primaryKey ? el("span", { class: "primary-tag", text: "your lens" }) : null
        ),
        el("span", { class: "val", text: String(score) })
      ),
      el("div", { class: "bar-track" }, el("div", { class: "bar-fill", "data-width": String(score) })),
      el("div", {
        class: "bar-meta",
        text: breakdown
          ? `${breakdown.reading} · weight ${(weight * 100).toFixed(1)}% · contributes ${breakdown.weightedContribution} points`
          : "",
      })
    );
  });

  container.replaceChildren(...rows);

  // Animate the fills on the next frame so the transition actually runs.
  requestAnimationFrame(() => {
    $$(".bar-fill", container).forEach((fill) => {
      fill.style.width = `${fill.dataset.width}%`;
    });
  });
}

/** Crisis signals. */
function renderRiskFlags(run) {
  const container = $("#risk-flags");
  const flags = run.riskFlags || [];

  if (flags.length === 0) {
    container.replaceChildren(
      el("p", {
        class: "muted",
        style: "margin:0;",
        text: "No crisis signals raised in this run. Nothing in the score surface indicates narrative instability, a promise/delivery gap, or identity drift.",
      })
    );
    return;
  }

  container.replaceChildren(
    ...flags.map((flag) =>
      el("div", { class: `flag ${flag.severity}` },
        el("div", { class: "flag-bar" }),
        el("div", {},
          el("h4", {},
            flag.title,
            el("span", { class: "sev", text: flag.severity })
          ),
          el("p", { text: flag.detail }),
          el("p", { class: "because", text: flag.because })
        )
      )
    )
  );
}

/** Strengths / weaknesses lists. */
function renderPoints(selector, items, emptyText) {
  const list = $(selector);
  if (!items || items.length === 0) {
    list.replaceChildren(el("li", { class: "muted", text: emptyText }));
    return;
  }
  list.replaceChildren(...items.map((item) => el("li", { text: item })));
}

/** The 30-day plan. */
function renderPlan(run) {
  const container = $("#plan");
  const plan = run.report?.improvementPlan || [];

  container.replaceChildren(
    ...plan.map((step) =>
      el("div", { class: "plan-step" },
        el("div", { class: "plan-week", text: `Week ${step.week}` }),
        el("div", { class: "plan-body" },
          el("h4", { text: step.label }),
          el("p", { text: step.action })
        )
      )
    )
  );
}

/** Score history sparkline. */
function renderHistory(history) {
  const container = $("#spark");
  const note = $("#history-note");

  if (!history || history.length < 2) {
    $("#history-card").classList.add("hidden");
    return;
  }
  $("#history-card").classList.remove("hidden");

  const max = Math.max(...history.map((h) => h.overall_score), 100);

  container.replaceChildren(
    ...history.map((point, index) =>
      el("div", {
        class: `spark-bar${index === history.length - 1 ? " current" : ""}`,
        style: `height:${Math.max(6, (point.overall_score / max) * 100)}%`,
        title: `${point.overall_score} — ${new Date(point.run_at).toLocaleDateString()}`,
      }, el("span", { text: String(point.overall_score) }))
    )
  );

  const first = history[0].overall_score;
  const last = history[history.length - 1].overall_score;
  const delta = last - first;
  note.textContent =
    `${history.length} runs. ` +
    (delta === 0
      ? "No net movement across the period."
      : `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} points across the period.`);
}

/** Confidence panel. */
function renderConfidence(run) {
  const confidence = run.report?.confidence;
  if (!confidence) {
    $("#confidence-card").classList.add("hidden");
    return;
  }
  $("#confidence-card").classList.remove("hidden");
  $("#confidence-label").textContent = confidence.label;
  $("#confidence-intake").textContent =
    `intake ${Math.round(confidence.intakeCompleteness * 100)}% complete`;
  $("#confidence-note").textContent = confidence.note;
}

/** Next-analysis recommendation. */
function renderNextAnalysis(run) {
  const next = run.report?.nextAnalysis;
  if (!next) return;
  $("#next-analysis").textContent = `In ${next.inDays} days. ${next.reason}`;
}

/**
 * Sector benchmark. Loaded separately because it is a second request and the
 * rest of the report should not wait on it.
 */
async function renderBenchmark(brandId) {
  const container = $("#benchmark");
  container.replaceChildren(el("p", { class: "muted", style: "margin:0;", text: "Loading benchmark…" }));

  try {
    const data = await api(`/brands/${brandId}/benchmark`, { token: state.token });
    const benchmark = data.benchmark;

    if (!benchmark.available) {
      container.replaceChildren(el("p", { class: "muted", style: "margin:0;", text: benchmark.note }));
      return;
    }

    const rows = benchmark.categories.map((category) =>
      el("div", { class: "bar-row" },
        el("div", { class: "bar-label" },
          el("span", { class: "name", text: category.label }),
          el("span", {
            class: "val",
            text: `${category.score} vs ${category.sectorMean} avg`,
          })
        ),
        el("div", { class: "bar-track" },
          el("div", { class: "bar-fill", "data-width": String(category.percentile) })
        ),
        el("div", { class: "bar-meta", text: `${category.percentile}th percentile in ${benchmark.sector}` })
      )
    );

    container.replaceChildren(
      el("p", { class: "muted", style: "font-size:.86rem;" },
        `Compared against ${benchmark.sample} analysed brand${benchmark.sample === 1 ? "" : "s"} ` +
        `in ${benchmark.sector}. Overall: ${benchmark.overall.score} against a sector mean of ` +
        `${benchmark.overall.sectorMean} (${benchmark.overall.percentile}th percentile).`
      ),
      ...rows,
      data.insights?.length
        ? el("ul", { class: "point-list plus mt-5" },
            ...data.insights.map((insight) => el("li", { text: insight })))
        : null
    );

    requestAnimationFrame(() => {
      $$(".bar-fill", container).forEach((fill) => { fill.style.width = `${fill.dataset.width}%`; });
    });
  } catch (err) {
    container.replaceChildren(
      el("p", { class: "muted", style: "margin:0;", text: `Benchmark unavailable: ${err.message}` })
    );
  }
}

/**
 * Render a complete analysis.
 * Accepts BOTH shapes: the live POST /api/analyze-brand response, and a stored
 * `analysis_runs` row from /api/me. normaliseRun() below reconciles them.
 */
function renderRun(run, me) {
  $("#no-run").classList.add("hidden");
  $("#results").classList.remove("hidden");

  renderScoreHero(run);
  renderBars(run, me.profile?.key);
  renderRiskFlags(run);
  renderPoints("#strengths", run.report?.strengths, "No specific strengths surfaced in this run.");
  renderPoints("#weaknesses", run.report?.weaknesses, "No specific weaknesses surfaced in this run.");
  renderPlan(run);
  renderConfidence(run);
  renderNextAnalysis(run);
  $("#overview-text").textContent = run.report?.overview || "";

  if (me.brand?.id) renderBenchmark(me.brand.id);
}

/**
 * Convert a stored DB row into the same shape as a fresh analysis response.
 *
 * The API returns two different shapes for the same thing: POST /analyze-brand
 * returns a rich nested object; /api/me returns the flat database row. Rather
 * than teach every render function about both, we normalise once, here.
 */
function normaliseRun(row) {
  if (!row) return null;
  if (row.scores) return row; // already the live shape

  const raw = row.raw_payload || {};
  return {
    runId: row.id,
    runAt: row.run_at,
    scores: {
      influence: Number(row.influence_score),
      identity: Number(row.identity_score),
      infrastructure: Number(row.infrastructure_score),
      intelligence: Number(row.intelligence_score),
      impact: Number(row.impact_score),
      overall: Number(row.overall_score),
    },
    tier: { label: row.tier, note: "" },
    weights: raw.weights || {},
    trajectory: {
      label: row.trajectory_label,
      delta: null,
      notes: row.forecast_notes || "",
    },
    riskFlags: row.risk_flags || [],
    report: {
      overview: row.summary || "",
      breakdown: raw.breakdown || [],
      strengths: row.strengths || [],
      weaknesses: row.weaknesses || [],
      improvementPlan: row.improvement_plan || [],
      nextAnalysis: raw.nextAnalysis,
      confidence: raw.confidence,
    },
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   ACTIONS
   ═══════════════════════════════════════════════════════════════════════════ */

/** Run a new analysis. */
async function runAnalysis(button) {
  setStatus("#dash-status", "");
  setLoading(button, true, "Analysing…");

  try {
    const run = await api("/analyze-brand", {
      method: "POST",
      token: state.token,
      body: state.me.brand?.id ? { brandId: state.me.brand.id } : {},
    });

    state.latestRun = run;
    renderRun(run, state.me);

    // Refresh /api/me so the history sparkline includes this run.
    try {
      state.me = await api("/me", { token: state.token });
      renderHistory(state.me.history);
    } catch { /* the report is already on screen; a stale sparkline is fine */ }

    setStatus("#dash-status", "Analysis complete.", "success");
    setTimeout(() => setStatus("#dash-status", ""), 4000);
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if (err.status === 402) {
      showState("unpaid");
      return;
    }
    if (err.status === 429) {
      setStatus("#dash-status", err.message, "info");
      return;
    }
    setStatus("#dash-status", err.message || "Analysis failed. Please try again.", "error");
    console.error("[analysis] failed:", err);
  } finally {
    setLoading(button, false);
  }
}

/** Send the customer (back) to Stripe Checkout. */
async function startCheckout(button) {
  setStatus("#unpaid-status", "");
  setLoading(button, true, "Opening checkout…");

  try {
    const checkout = await api("/create-checkout-session", {
      method: "POST",
      body: { userId: state.me.user.id },
    });
    window.location.href = checkout.checkoutUrl;
  } catch (err) {
    setLoading(button, false);
    setStatus("#unpaid-status", err.message || "Could not open checkout.", "error");
  }
}

/** Open Stripe's Customer Portal so they can update a card or cancel. */
async function openBillingPortal(event) {
  event.preventDefault();
  try {
    const portal = await api("/billing/portal", { method: "POST", token: state.token });
    window.location.href = portal.portalUrl;
  } catch (err) {
    setStatus("#dash-status", err.message || "Billing portal is unavailable.", "error");
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   THE STRIPE REDIRECT RACE — poll until the webhook lands
   ═══════════════════════════════════════════════════════════════════════════ */

const POLL_ATTEMPTS = 12;    // 12 × 2.5s ≈ 30 seconds
const POLL_INTERVAL_MS = 2500;

async function waitForSubscription() {
  showState("pending");

  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    $("#pending-attempts").textContent = `Checking… (${attempt} of ${POLL_ATTEMPTS})`;

    try {
      const status = await api("/billing/status", { token: state.token });
      if (status.entitled) return true;
    } catch (err) {
      console.warn("[billing] poll failed:", err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return false;
}


/* ═══════════════════════════════════════════════════════════════════════════
   MODAL
   ═══════════════════════════════════════════════════════════════════════════ */

function wireModal() {
  const modal = $("#disclaimer-modal");

  $("#nav-disclaimer")?.addEventListener("click", (event) => {
    event.preventDefault();
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
  });

  const close = () => {
    modal.classList.remove("open");
    document.body.style.overflow = "";
  };

  $$("[data-close-modal]").forEach((button) => button.addEventListener("click", close));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════════ */

async function init() {
  wireModal();
  showState("loading");

  /* ── No token: offer the recovery path ─────────────────────────────────── */
  state.token = resolveToken();
  if (!state.token) {
    showState("noauth");

    $("#paste-token-btn")?.addEventListener("click", () => {
      $("#paste-token-panel").classList.toggle("hidden");
      $("#manual-token")?.focus();
    });

    $("#manual-token-btn")?.addEventListener("click", () => {
      const value = $("#manual-token").value.trim();
      // Accept either a bare token or a full dashboard URL pasted whole.
      const token = value.includes("token=") ? value.split("token=")[1].split("&")[0] : value;
      if (!token) return;
      tokenStore.set(token);
      window.location.href = "dashboard.html";
    });

    return;
  }

  /* ── Load the account (and the tier table, in parallel) ────────────────── */
  const tiersLoading = loadTiers();

  try {
    state.me = await api("/me", { token: state.token });
    await tiersLoading;
  } catch (err) {
    if (err.status === 401) {
      tokenStore.clear();
      showState("noauth");
      return;
    }
    showState("noauth");
    const box = $("#state-noauth");
    box.prepend(el("div", { class: "form-status visible error", text: err.message }));
    return;
  }

  /* ── Just came back from Stripe? Wait for the webhook. ─────────────────── */
  const params = new URLSearchParams(window.location.search);
  const justPaid = params.get("checkout") === "success";

  if (justPaid && !state.me.entitled) {
    const succeeded = await waitForSubscription();
    if (succeeded) {
      state.me = await api("/me", { token: state.token }); // reload with the new status
    } else {
      showState("unpaid");
      $("#unpaid-title").textContent = "We have not seen your payment yet";
      $("#unpaid-body").textContent =
        "Stripe has not confirmed the subscription with our server. If you completed payment, " +
        "it usually appears within a minute — reload this page. If it does not, contact support " +
        "and nothing further will be charged.";
      $("#resume-checkout").classList.add("hidden");
      return;
    }
  }

  /* ── Not entitled ──────────────────────────────────────────────────────── */
  if (!state.me.entitled) {
    showState("unpaid");

    const status = state.me.subscription?.status;
    if (status === "canceled") {
      $("#unpaid-title").textContent = "Your subscription has ended";
      $("#unpaid-body").textContent =
        "Your brand and every past analysis are still here. Restart your subscription to run a new one.";
    } else if (status === "past_due") {
      $("#unpaid-title").textContent = "There is a problem with your payment";
      $("#unpaid-body").textContent =
        "Stripe could not take the last payment. Update your card to keep your analyses running.";
    }

    $("#resume-checkout")?.addEventListener("click", (event) =>
      startCheckout(event.currentTarget));
    return;
  }

  /* ── The real dashboard ────────────────────────────────────────────────── */
  showState("dashboard");
  renderHeader(state.me);
  renderHistory(state.me.history);

  $("#nav-billing")?.classList.remove("hidden");
  $("#nav-signout")?.classList.remove("hidden");
  $("#nav-billing")?.addEventListener("click", openBillingPortal);
  $("#nav-signout")?.addEventListener("click", (event) => {
    event.preventDefault();
    tokenStore.clear();
    window.location.href = "index.html";
  });

  $("#print-btn")?.addEventListener("click", () => window.print());
  $("#run-btn")?.addEventListener("click", (event) => runAnalysis(event.currentTarget));
  $("#first-run-btn")?.addEventListener("click", (event) => runAnalysis(event.currentTarget));

  const latest = normaliseRun(state.me.latestRun);
  if (latest) {
    state.latestRun = latest;
    renderRun(latest, state.me);
  } else {
    $("#no-run").classList.remove("hidden");
    $("#results").classList.add("hidden");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
