/**
 * routes/meta.js
 * ---------------------------------------------------------------------------
 * Public, unauthenticated routes that describe the system.
 *
 *   GET /api/health     liveness + DB check (point Render's health check here)
 *   GET /api/matrix     the Premonition Matrix™ — the frontend renders from this
 *   GET /api/config     public config the frontend needs (price, flags)
 *   GET /api/legal      the disclaimer text, served from one canonical source
 *
 * Serving the matrix and the legal text from the API rather than hard-coding
 * them in HTML means the site copy and the engine can never disagree.
 * ---------------------------------------------------------------------------
 */

import express from "express";
import { asyncHandler } from "../middleware/errors.js";
import { pingDb } from "../config/db.js";
import { publicMatrixPayload } from "../services/matrix.js";
import { ADVISORY_NOTICE } from "../services/report.js";
import { stripeConfigured } from "../config/stripe.js";
import { env } from "../config/env.js";

const router = express.Router();
const BOOTED_AT = Date.now();

/* ── GET /api/health ─────────────────────────────────────────────────────── */
router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const dbOk = await pingDb();
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      service: "sgc-premonition-backend",
      version: "1.0.0",
      env: env.NODE_ENV,
      db: { driver: env.DB_DRIVER, ok: dbOk },
      stripe: { configured: stripeConfigured() },
      ai: { provider: env.AI_PROVIDER },
      uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
      time: new Date().toISOString(),
    });
  })
);

/* ── GET /api/matrix ─────────────────────────────────────────────────────── */
router.get("/matrix", (_req, res) => {
  res.json(publicMatrixPayload());
});

/* ── GET /api/config ─────────────────────────────────────────────────────── */
router.get("/config", (_req, res) => {
  res.json({
    productName: "SGC Premonition",
    tagline: "PR Intelligence • AI Foresight • Brand Protection",
    plan: {
      name: env.PLAN_NAME,
      priceUsd: env.PLAN_PRICE_USD,
      interval: "month",
      displayPrice: `$${env.PLAN_PRICE_USD.toFixed(2)}/month`,
    },
    paymentsEnabled: stripeConfigured(),
    aiProvider: env.AI_PROVIDER,
    // Never expose secret keys here. Only the price is public information.
  });
});

/* ── GET /api/legal ──────────────────────────────────────────────────────── */
router.get("/legal", (_req, res) => {
  res.json({
    advisoryNotice: ADVISORY_NOTICE,
    points: [
      "SGC Premonition is an AI advisory tool.",
      "Outputs are generated algorithmically and may not reflect complete, accurate, or context-specific information.",
      "It does not provide legal, regulatory, compliance, crisis management, or professional PR services.",
      "All recommendations should be reviewed by qualified professionals before implementation.",
      "STC and Jade 2 Capital disclaim all liability for decisions made or actions taken based on the system's insights.",
    ],
    lastUpdated: "2026-08-22",
  });
});

export default router;
