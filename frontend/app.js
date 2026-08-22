/**
 * app.js — SGC Premonition landing page
 * ---------------------------------------------------------------------------
 * Responsibilities, in order of importance:
 *
 *   1. SIGNUP FLOW    form → POST /api/signup → POST /api/create-checkout-session
 *                     → redirect to Stripe
 *   2. LIVE COPY      render the Matrix cards and the price from the API, so the
 *                     page and the scoring engine can never disagree
 *   3. POLISH         profile preview, scroll reveals, disclaimer modal
 *
 * Depends on config.js for `api()`, `tokenStore`, and `SGC_CONFIG`.
 * ---------------------------------------------------------------------------
 */

/* eslint-env browser */
"use strict";

/* ═══════════════════════════════════════════════════════════════════════════
   Small DOM helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const $  = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** Create an element with attributes and children in one call. */
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
   1. LIVE CONFIG — price shown on the page comes from the server
   ═══════════════════════════════════════════════════════════════════════════ */

let paymentsEnabled = true;

async function loadConfig() {
  try {
    const config = await api("/config");
    paymentsEnabled = config.paymentsEnabled;

    // Update every price label on the page at once.
    const display = config.plan.displayPrice || SGC_CONFIG.FALLBACK_PRICE;
    $$(".cta-price, #cta-price").forEach((node) => { node.textContent = display; });
    const amount = $("#price-amount");
    if (amount) amount.textContent = `$${Number(config.plan.priceUsd).toFixed(2)}`;

    if (!paymentsEnabled) {
      showStatus(
        "Payments are not configured on the server yet. You can still submit the form — your " +
        "signup will be saved, and you will get a link to your dashboard.",
        "info"
      );
    }
  } catch (err) {
    // Not fatal: the page has hard-coded fallback prices. Only log it.
    console.warn("[config] could not load:", err.message);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   2. MATRIX CARDS — rendered from GET /api/matrix
   ═══════════════════════════════════════════════════════════════════════════ */

/** Cached so the dropdown preview can use it without a second request. */
let matrixCategories = [];

async function loadMatrix() {
  const grid = $("#matrix-grid");
  if (!grid) return;

  try {
    const matrix = await api("/matrix");
    matrixCategories = matrix.categories;

    grid.replaceChildren(
      ...matrix.categories.map((category, index) =>
        el("article", { class: "matrix-card reveal" },
          el("span", { class: "matrix-num", text: String(index + 1).padStart(2, "0") }),
          el("h3", { text: category.label }),
          el("p", { class: "q", text: category.question }),
          el("p", { text: category.description }),
          el("div", { class: "signals" },
            (category.signals || []).map((signal) => el("span", { class: "signal", text: signal }))
          ),
          el("div", {
            class: "weight-note",
            text: `Base weight in your overall score: ${Math.round(category.weight * 100)}%`,
          })
        )
      )
    );

    observeReveals();
    updateProfilePreview(); // the dropdown may already have a value (browser autofill)
  } catch (err) {
    // The hard-coded fallback cards in index.html stay on screen.
    console.warn("[matrix] could not load, using static fallback:", err.message);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   3. PROFILE PREVIEW — explain the dropdown choice as it is made
   ═══════════════════════════════════════════════════════════════════════════ */

function updateProfilePreview() {
  const select = $("#primary_profile_type");
  const preview = $("#profile-preview");
  if (!select || !preview) return;

  const category = matrixCategories.find((c) => c.key === select.value);

  if (!category) {
    preview.classList.remove("visible");
    preview.replaceChildren();
    return;
  }

  // The lens maths, mirrored from the backend's effectiveWeights():
  //   boosted = weight × 1.4, then all five weights re-normalised to sum to 1.
  //   Since only one weight changes, the new sum is (1 + weight × 0.4).
  const boostedWeight = (category.weight * 1.4) / (1 + category.weight * 0.4);

  preview.replaceChildren(
    el("strong", { text: `${category.label} — ${category.question}` }),
    el("span", { text: `${category.summary} ` }),
    el("span", {
      class: "muted",
      text: `Choosing this raises ${category.label}'s weight in your overall score from ` +
            `${Math.round(category.weight * 100)}% to roughly ${Math.round(boostedWeight * 100)}%.`,
    })
  );
  preview.classList.add("visible");
}


/* ═══════════════════════════════════════════════════════════════════════════
   4. SIGNUP FLOW
   ═══════════════════════════════════════════════════════════════════════════ */

/** Show a message under the form. type: "error" | "success" | "info" */
function showStatus(message, type = "error") {
  const box = $("#form-status");
  if (!box) return;
  box.className = `form-status visible ${type}`;
  box.textContent = message;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearStatus() {
  const box = $("#form-status");
  if (box) box.className = "form-status";
}

/** Clear every red field outline. */
function clearFieldErrors() {
  $$("[data-field]").forEach((field) => {
    field.classList.remove("has-error");
    const message = $(".field-error", field);
    if (message) message.textContent = "";
  });
}

/**
 * Paint field-level errors returned by the API.
 * The backend sends `fields: { email: "…", brand_name: "…" }`, which maps
 * one-to-one onto the `data-field` attributes in the markup.
 */
function showFieldErrors(fields = {}) {
  let firstErrorField = null;

  for (const [name, message] of Object.entries(fields)) {
    const field = $(`[data-field="${name}"]`);
    if (!field) continue;
    field.classList.add("has-error");
    const target = $(".field-error", field);
    if (target) target.textContent = message;
    if (!firstErrorField) firstErrorField = field;
  }

  if (firstErrorField) {
    firstErrorField.scrollIntoView({ behavior: "smooth", block: "center" });
    $("input, select, textarea", firstErrorField)?.focus();
  }
}

/** Toggle the submit button's loading state. */
function setSubmitting(isSubmitting) {
  const button = $("#submit-btn");
  if (!button) return;
  button.classList.toggle("is-loading", isSubmitting);
  button.disabled = isSubmitting;
  const label = $(".btn-text", button);
  if (label) {
    label.textContent = isSubmitting ? "Creating your account…" : "";
    if (!isSubmitting) {
      label.replaceChildren(
        document.createTextNode("Start Premonition for "),
        el("span", { class: "cta-price", text: SGC_CONFIG.FALLBACK_PRICE })
      );
      loadConfig(); // restore the live price
    }
  }
}

/** Read the form into the JSON shape POST /api/signup expects. */
function readForm() {
  const value = (id) => ($(`#${id}`)?.value ?? "").trim();
  return {
    name: value("name"),
    email: value("email"),
    brand_name: value("brand_name"),
    sector: value("sector"),
    region: value("region"),
    description: value("description"),
    primary_profile_type: value("primary_profile_type"),
    // Optional intake
    website_url: value("website_url"),
    social_links: value("social_links"),
    mission: value("mission"),
    values: value("values"),
    tagline: value("tagline"),
    audience_profile: value("audience_profile"),
  };
}

/**
 * The whole signup + payment sequence.
 *
 *   1. POST /api/signup                → user + brand created, token returned
 *   2. store the token                 → so the dashboard works after redirect
 *   3. POST /api/create-checkout-session
 *   4. window.location = checkoutUrl   → Stripe takes it from here
 *
 * Step 2 happens BEFORE step 3 on purpose: if anything fails at the payment
 * stage, the customer still has an account and a dashboard link, and has not
 * lost the twenty minutes they spent on the intake form.
 */
async function handleSignup(event) {
  event.preventDefault();
  clearStatus();
  clearFieldErrors();
  setSubmitting(true);

  const payload = readForm();

  try {
    /* ── 1 & 2. Create the account, keep the token ─────────────────────── */
    const signup = await api("/signup", { method: "POST", body: payload });
    tokenStore.set(signup.accessToken);

    /* ── 3. Payments off? Stop here, but do not lose the signup ────────── */
    if (!paymentsEnabled) {
      showStatus(
        "Your account was created, but payments are not configured on this server yet, so " +
        "checkout was skipped. Your dashboard is ready — open it from the link below.",
        "success"
      );
      const dashboard = el("a", {
        href: `dashboard.html?token=${encodeURIComponent(signup.accessToken)}`,
        class: "btn btn-primary mt-4",
        text: "Open my Premonition Dashboard",
      });
      $("#form-status").append(el("div", { class: "mt-4" }, dashboard));
      setSubmitting(false);
      return;
    }

    /* ── 4. Off to Stripe ──────────────────────────────────────────────── */
    showStatus("Account created. Taking you to secure checkout…", "success");

    const checkout = await api("/create-checkout-session", {
      method: "POST",
      body: { userId: signup.userId },
    });

    window.location.href = checkout.checkoutUrl;
    // No setSubmitting(false) here — we are navigating away, and re-enabling
    // the button would invite a double submission during the redirect.
  } catch (err) {
    setSubmitting(false);

    if (err.fields) {
      showFieldErrors(err.fields);
      showStatus("Please fix the highlighted fields and try again.", "error");
      return;
    }

    if (err.status === 409) {
      showStatus(
        "That email has already signed up. If that was you, open your dashboard — " +
        "your access link was saved in this browser when you registered.",
        "error"
      );
      return;
    }

    if (err.code === "network_error") {
      showStatus(err.message, "error");
      return;
    }

    showStatus(err.message || "Something went wrong. Please try again.", "error");
    console.error("[signup] failed:", err);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   5. DISCLAIMER MODAL
   ═══════════════════════════════════════════════════════════════════════════ */

function openModal() {
  const modal = $("#disclaimer-modal");
  if (!modal) return;
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
  $("[data-close-modal]", modal)?.focus();
}

function closeModal() {
  const modal = $("#disclaimer-modal");
  if (!modal) return;
  modal.classList.remove("open");
  document.body.style.overflow = "";
}

function wireModal() {
  ["#nav-disclaimer", "#footer-disclaimer", "#inline-disclaimer"].forEach((selector) => {
    $(selector)?.addEventListener("click", (event) => {
      event.preventDefault();
      openModal();
    });
  });

  $$("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));

  // Click the backdrop to dismiss.
  $("#disclaimer-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "disclaimer-modal") closeModal();
  });

  // Escape to dismiss.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
}

/** Pull the canonical disclaimer text from the API so it is defined once. */
async function loadLegal() {
  try {
    const legal = await api("/legal");
    const list = $("#disclaimer-points");
    if (list && Array.isArray(legal.points)) {
      list.replaceChildren(...legal.points.map((point) => el("li", { text: point })));
    }
  } catch {
    /* The hard-coded copy in the HTML stays — it says the same thing. */
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   6. SCROLL REVEALS
   ═══════════════════════════════════════════════════════════════════════════ */

let revealObserver = null;

function observeReveals() {
  // Users who asked for reduced motion get everything visible immediately.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    $$(".reveal").forEach((node) => node.classList.add("shown"));
    return;
  }

  // Old browsers without IntersectionObserver keep everything visible.
  if (!("IntersectionObserver" in window)) {
    document.documentElement.classList.remove("js-reveal");
    return;
  }

  // Opt IN to the hidden-then-fade behaviour only now that we know JS runs and
  // the observer exists. See the .js-reveal note in styles.css.
  document.documentElement.classList.add("js-reveal");

  if (!revealObserver) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("shown");
            revealObserver.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
  }

  $$(".reveal:not(.shown)").forEach((node) => revealObserver.observe(node));
}


/* ═══════════════════════════════════════════════════════════════════════════
   7. BOOT
   ═══════════════════════════════════════════════════════════════════════════ */

function init() {
  $("#year") && ($("#year").textContent = String(new Date().getFullYear()));

  $("#signup-form")?.addEventListener("submit", handleSignup);
  $("#primary_profile_type")?.addEventListener("change", updateProfilePreview);

  wireModal();
  observeReveals();

  // Fire the three API calls together rather than in sequence.
  loadConfig();
  loadMatrix();
  loadLegal();

  // Returning from a cancelled Stripe checkout.
  const params = new URLSearchParams(window.location.search);
  if (params.get("checkout") === "cancelled") {
    showStatus(
      "Checkout was cancelled — nothing was charged. Your signup details are still here; " +
      "submit again whenever you are ready.",
      "info"
    );
  }

  // Someone who already has a token gets a way back to their dashboard.
  const existingToken = tokenStore.get();
  if (existingToken) {
    const link = $('a[href="dashboard.html"]');
    if (link) link.href = `dashboard.html?token=${encodeURIComponent(existingToken)}`;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
