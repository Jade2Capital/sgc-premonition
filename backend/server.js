/**
 * server.js
 * ---------------------------------------------------------------------------
 * SGC PREMONITION — application entry point.
 *
 * START IT:
 *   cd backend
 *   npm install
 *   cp .env.example .env      # then fill in your values
 *   npm run migrate
 *   npm start
 *
 * MIDDLEWARE ORDER MATTERS HERE. Read the comments before reordering anything.
 * In particular, the Stripe webhook needs the RAW request body and therefore
 * must be mounted before express.json() ever sees it.
 * ---------------------------------------------------------------------------
 */

import express from "express";
import cors from "cors";

import { env, validateEnv, isProduction } from "./config/env.js";
import { getDb, closeDb } from "./config/db.js";
import { migrate } from "./db/migrate.js";

import metaRoutes from "./routes/meta.js";
import authRoutes from "./routes/auth.js";
import billingRoutes from "./routes/billing.js";
import analysisRoutes from "./routes/analysis.js";

import { notFoundHandler, errorHandler } from "./middleware/errors.js";

const app = express();

/* ═══════════════════════════════════════════════════════════════════════════
   1. TRUST PROXY

   Render terminates TLS in front of your app. Without this, req.ip is the
   proxy's address and the rate limiter would treat every visitor as one
   person.
   ═══════════════════════════════════════════════════════════════════════════ */
app.set("trust proxy", 1);
app.disable("x-powered-by");


/* ═══════════════════════════════════════════════════════════════════════════
   2. CORS

   The frontend is hosted separately (GitHub Pages / Render Static), so the
   browser will send cross-origin requests. Allow-list rather than "*", because
   "*" would let any site on the internet call this API with a stolen token.
   ═══════════════════════════════════════════════════════════════════════════ */
const allowedOrigins = new Set(
  [
    env.FRONTEND_URL,
    ...env.EXTRA_CORS_ORIGINS.split(",").map((s) => s.trim()),
    // Local development conveniences.
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ].filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = a same-origin request, curl, or a mobile webview.
      // Those are not browser cross-origin requests, so let them through.
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);

      // `file://` pages send Origin: null — common when a beginner double-clicks
      // index.html. Allowed outside production only.
      if (origin === "null" && !isProduction) return callback(null, true);

      console.warn(`[cors] blocked origin: ${origin}`);
      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: false, // we use bearer tokens, not cookies
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   3. BODY PARSING — the Stripe webhook exception

   Stripe signs the exact bytes it sent. If express.json() parses and
   re-serialises the body, the signature will not match and every webhook
   fails. So: raw parser on the webhook path, JSON parser everywhere else.

   This is the single most common way a Stripe integration silently breaks.
   ═══════════════════════════════════════════════════════════════════════════ */
const STRIPE_WEBHOOK_PATH = "/api/webhook/stripe";

app.use(STRIPE_WEBHOOK_PATH, express.raw({ type: "application/json", limit: "1mb" }));

app.use((req, res, next) => {
  if (req.originalUrl === STRIPE_WEBHOOK_PATH) return next(); // already raw
  return express.json({ limit: "256kb" })(req, res, next);
});


/* ═══════════════════════════════════════════════════════════════════════════
   4. REQUEST LOGGING

   One line per request. Enough to debug, short enough to read. Deliberately
   does not log request bodies — they contain email addresses and, on the
   webhook path, payment metadata.
   ═══════════════════════════════════════════════════════════════════════════ */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    // Strip the query string: it can carry an access token.
    const path = req.originalUrl.split("?")[0];
    console.log(`${req.method} ${path} ${res.statusCode} ${ms}ms`);
  });
  next();
});


/* ═══════════════════════════════════════════════════════════════════════════
   5. ROUTES

   All mounted under /api so the same domain could later serve the frontend
   from / without a collision.
   ═══════════════════════════════════════════════════════════════════════════ */
app.use("/api", metaRoutes);      // /api/health, /api/matrix, /api/config, /api/legal
app.use("/api", authRoutes);      // /api/signup, /api/me
app.use("/api", billingRoutes);   // /api/create-checkout-session, /api/webhook/stripe, …
app.use("/api", analysisRoutes);  // /api/analyze-brand, /api/analysis/:id, …

/** Root: a friendly pointer rather than a 404, so a bare URL is not confusing. */
app.get("/", (_req, res) => {
  res.json({
    service: "SGC Premonition API",
    tagline: "PR Intelligence • AI Foresight • Brand Protection",
    docs: "See README.md",
    health: "/api/health",
  });
});


/* ═══════════════════════════════════════════════════════════════════════════
   6. ERROR HANDLING — must be last
   ═══════════════════════════════════════════════════════════════════════════ */
app.use(notFoundHandler);
app.use(errorHandler);


/* ═══════════════════════════════════════════════════════════════════════════
   7. BOOT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Start the HTTP server.
 * Exported (rather than run at import) so tests can start it on a random port.
 */
export async function start({ port = env.PORT, runMigrations = true } = {}) {
  // Configuration warnings are printed, not fatal — a beginner should be able
  // to boot and browse before they have Stripe keys.
  const problems = validateEnv();
  if (problems.length) {
    console.warn("\n[config] warnings:");
    for (const p of problems) console.warn(`  • ${p}`);
    console.warn("");
  }

  await getDb();
  if (runMigrations) await migrate();

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      console.log("");
      console.log("  ███  SGC PREMONITION");
      console.log("       PR Intelligence • AI Foresight • Brand Protection");
      console.log("");
      console.log(`  API      http://localhost:${actualPort}`);
      console.log(`  Health   http://localhost:${actualPort}/api/health`);
      console.log(`  Frontend ${env.FRONTEND_URL}`);
      console.log(`  DB       ${env.DB_DRIVER}`);
      console.log(`  AI       ${env.AI_PROVIDER}`);
      console.log(`  Plan     $${env.PLAN_PRICE_USD.toFixed(2)}/month`);
      console.log("");
      resolve(server);
    });
  });
}

/** Close cleanly so Render's deploys do not drop in-flight requests. */
function installShutdownHandlers(server) {
  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal} received — closing`);
    server.close(async () => {
      await closeDb();
      console.log("[shutdown] done");
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Run directly (`npm start`) but not when imported by a test.
const isDirectRun = process.argv[1] && process.argv[1].endsWith("server.js");
if (isDirectRun) {
  start()
    .then(installShutdownHandlers)
    .catch((err) => {
      console.error("[boot] failed to start:", err);
      process.exit(1);
    });
}

export { app };
