/**
 * routes/analysis.js
 * ---------------------------------------------------------------------------
 * The product itself.
 *
 *   POST /api/analyze-brand        run a Premonition analysis
 *   GET  /api/analysis/:id         fetch one stored run
 *   GET  /api/brands/:id/runs      history for a brand
 *   GET  /api/brands/:id/benchmark sector benchmark for a brand's latest run
 *   PATCH /api/brands/:id          update intake (improves the next run)
 *
 * THE ORCHESTRATION, in order:
 *   AI provider → scoring engine → predictive engine → report builder → DB
 *
 * Each stage is a pure function in services/. This file only wires them
 * together and handles HTTP concerns. That is why the engines are testable
 * without a server and why swapping the stub for a real model changes nothing
 * here.
 * ---------------------------------------------------------------------------
 */

import express from "express";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireUser, requireSubscription } from "../middleware/auth.js";
import { analysisLimiter } from "../middleware/rateLimit.js";
import { validateId, clean, cleanMultiline, normaliseUrl, parseLinkList, parseValueList } from "../lib/validate.js";

import { getProvider, buildBrandContext, intakeCompleteness } from "../services/ai/index.js";
import { scoreBrand } from "../services/scoring.js";
import { runPredictive } from "../services/predictive.js";
import { buildReport, ADVISORY_NOTICE } from "../services/report.js";
import { benchmarkAgainstSector, competitiveInsights } from "../services/competitive.js";

import {
  findBrandById,
  findPrimaryBrandForUser,
  updateBrand,
  userOwnsBrand,
} from "../models/brand.js";
import {
  createAnalysisRun,
  findAnalysisRunById,
  findLatestRunForBrand,
  listRunsForBrand,
  runsInSector,
  scoreHistory,
} from "../models/analysisRun.js";

const router = express.Router();


/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/analyze-brand

   HEADERS  Authorization: Bearer <accessToken>

   REQUEST
   { "brandId": "…uuid…" }        // optional — defaults to the user's brand

   RESPONSE 201
   {
     "runId": "…uuid…",
     "brandId": "…uuid…",
     "runAt": "2026-08-22T…",

     "scores": {
       "influence": 72, "identity": 80, "infrastructure": 65,
       "intelligence": 78, "impact": 70, "overall": 74
     },
     "tier": { "label": "Strong", "note": "…" },
     "weights": { "influence": 0.283, … },

     "trajectory": { "label": "Rising", "delta": null, "basis": "…", "notes": "…" },
     "riskFlags":  [ { "code": "PROMISE_DELIVERY_GAP", "severity": "high", … } ],

     "report": {
       "overview": "…",
       "breakdown": [ { "key":"identity","label":"Identity","score":80,… } ],
       "strengths": [ … ], "weaknesses": [ … ],
       "improvementPlan": [ { "week":1,"category":"impact","action":"…" } ],
       "nextAnalysis": { "inDays": 30, "reason": "…" },
       "confidence": { "value":0.35, "label":"Preliminary", … }
     },

     "engine": { "provider": "stub", "version": "v1-stub" },
     "advisoryNotice": "…"
   }

   ERRORS
     401 missing_token / invalid_token
     402 subscription_required
     403 forbidden              → brand belongs to another user
     404 brand_not_found
     429 rate_limited
   ═══════════════════════════════════════════════════════════════════════════ */

router.post(
  "/analyze-brand",
  requireUser,
  requireSubscription,
  analysisLimiter,
  asyncHandler(async (req, res) => {
    const user = req.user;

    /* ── 1. Resolve the brand, and check the caller owns it ──────────────── */
    let brand;
    if (req.body?.brandId) {
      const brandId = validateId(req.body.brandId, "brandId");
      if (!(await userOwnsBrand(user.id, brandId))) {
        throw new HttpError(403, "That brand does not belong to this account.", {
          code: "forbidden",
        });
      }
      brand = await findBrandById(brandId);
    } else {
      brand = await findPrimaryBrandForUser(user.id);
    }

    if (!brand) {
      throw new HttpError(404, "No brand found for this account.", { code: "brand_not_found" });
    }

    /* ── 2. AI LAYER — produce the eight sub-dimension signals ───────────── */
    const provider = getProvider();
    const ctx = buildBrandContext(brand, user);
    const completeness = intakeCompleteness(ctx);
    const signal = await provider.analyze(ctx);

    /* ── 3. SCORING ENGINE — five categories + weighted overall + tier ───── */
    const scored = scoreBrand({
      subScores: signal.subScores,
      primaryProfileType: user.primary_profile_type,
    });

    /* ── 4. PREDICTIVE ENGINE — risk flags, trajectory, 30-day plan ──────── */
    const previousRun = await findLatestRunForBrand(brand.id); // null on first run
    const predictiveContext = {
      categories: scored.categories,
      overall: scored.overall,
      spread: scored.spread.spread,
      primaryProfileType: user.primary_profile_type,
      intakeCompleteness: completeness,
      previous: previousRun
        ? {
            overall: Number(previousRun.overall_score),
            categories: {
              influence: Number(previousRun.influence_score),
              identity: Number(previousRun.identity_score),
              infrastructure: Number(previousRun.infrastructure_score),
              intelligence: Number(previousRun.intelligence_score),
              impact: Number(previousRun.impact_score),
            },
          }
        : null,
    };
    const predicted = runPredictive(predictiveContext, scored.ranked);

    /* ── 5. REPORTING — turn numbers into a document ─────────────────────── */
    const report = buildReport({ brand, user, scored, predicted, signal, completeness });

    /* ── 6. PERSIST — history is what makes month two worth paying for ───── */
    const run = await createAnalysisRun({
      brandId: brand.id,
      userId: user.id,
      scored,
      predicted,
      report,
      signal,
    });

    /* ── 7. Respond ──────────────────────────────────────────────────────── */
    res.status(201).json({
      runId: run.id,
      brandId: brand.id,
      brandName: brand.brand_name,
      runAt: run.run_at,

      scores: { ...scored.categories, overall: scored.overall },
      tier: { label: scored.tier.label, note: scored.tier.note },
      weights: scored.weights,
      spread: scored.spread,

      trajectory: predicted.trajectory,
      riskFlags: predicted.riskFlags,

      report: {
        overview: report.overview,
        breakdown: report.breakdown,
        strengths: report.strengths,
        weaknesses: report.weaknesses,
        improvementPlan: report.improvementPlan,
        nextAnalysis: report.nextAnalysis,
        confidence: report.confidence,
      },

      // Sub-dimension detail. Useful for debugging and for a future "show your
      // working" panel in the UI.
      subScores: scored.subScores,

      engine: { provider: signal.provider, version: signal.version },
      advisoryNotice: ADVISORY_NOTICE,
    });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/analysis/:id — fetch one stored run
   ═══════════════════════════════════════════════════════════════════════════ */

router.get(
  "/analysis/:id",
  requireUser,
  asyncHandler(async (req, res) => {
    const id = validateId(req.params.id, "id");
    const run = await findAnalysisRunById(id);

    if (!run) throw new HttpError(404, "Analysis not found.", { code: "not_found" });
    if (run.user_id !== req.user.id) {
      throw new HttpError(403, "That analysis belongs to another account.", { code: "forbidden" });
    }

    res.json({ run, advisoryNotice: ADVISORY_NOTICE });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/brands/:id/runs — history + sparkline data
   ═══════════════════════════════════════════════════════════════════════════ */

router.get(
  "/brands/:id/runs",
  requireUser,
  asyncHandler(async (req, res) => {
    const brandId = validateId(req.params.id, "id");
    if (!(await userOwnsBrand(req.user.id, brandId))) {
      throw new HttpError(403, "That brand does not belong to this account.", { code: "forbidden" });
    }

    const runs = await listRunsForBrand(brandId, { limit: 24 });
    const history = await scoreHistory(brandId, { limit: 12 });

    res.json({ brandId, count: runs.length, runs, history });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/brands/:id/benchmark — sector benchmarking (Competitive Layer)

   Works today against every stored run in the same sector. Returns
   `available: false` with a clear explanation until there are enough peers.
   ═══════════════════════════════════════════════════════════════════════════ */

router.get(
  "/brands/:id/benchmark",
  requireUser,
  requireSubscription,
  asyncHandler(async (req, res) => {
    const brandId = validateId(req.params.id, "id");
    if (!(await userOwnsBrand(req.user.id, brandId))) {
      throw new HttpError(403, "That brand does not belong to this account.", { code: "forbidden" });
    }

    const brand = await findBrandById(brandId);
    const latest = await findLatestRunForBrand(brandId);

    if (!latest) {
      throw new HttpError(404, "Run an analysis first — there is nothing to benchmark yet.", {
        code: "no_runs",
      });
    }

    // Rebuild the scored shape from the stored row.
    const scored = {
      categories: {
        influence: Number(latest.influence_score),
        identity: Number(latest.identity_score),
        infrastructure: Number(latest.infrastructure_score),
        intelligence: Number(latest.intelligence_score),
        impact: Number(latest.impact_score),
      },
      overall: Number(latest.overall_score),
    };

    const sectorRuns = await runsInSector(brand.sector, { excludeBrandId: brandId });
    const benchmark = benchmarkAgainstSector({ scored, sector: brand.sector, sectorRuns });

    res.json({
      brandId,
      basedOnRunId: latest.id,
      benchmark,
      insights: competitiveInsights(benchmark),
      advisoryNotice: ADVISORY_NOTICE,
    });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   PATCH /api/brands/:id — update intake

   Richer intake produces a better analysis, so give customers a way to add to
   it after signup without re-registering.

   REQUEST (all fields optional)
   { "website_url": "…", "social_links": "…, …", "mission": "…",
     "values": "craft, speed", "tagline": "…", "audience_profile": "…",
     "description": "…", "sector": "…", "region": "…", "brand_name": "…" }
   ═══════════════════════════════════════════════════════════════════════════ */

router.patch(
  "/brands/:id",
  requireUser,
  asyncHandler(async (req, res) => {
    const brandId = validateId(req.params.id, "id");
    if (!(await userOwnsBrand(req.user.id, brandId))) {
      throw new HttpError(403, "That brand does not belong to this account.", { code: "forbidden" });
    }

    const body = req.body ?? {};
    const patch = {};

    if (body.brand_name !== undefined) patch.brandName = clean(body.brand_name).slice(0, 160);
    if (body.sector !== undefined) patch.sector = clean(body.sector).slice(0, 80);
    if (body.region !== undefined) patch.region = clean(body.region).slice(0, 80);
    if (body.description !== undefined) patch.description = cleanMultiline(body.description).slice(0, 4000);
    if (body.website_url !== undefined) patch.websiteUrl = normaliseUrl(body.website_url);
    if (body.social_links !== undefined) patch.socialLinks = parseLinkList(body.social_links);
    if (body.mission !== undefined) patch.mission = cleanMultiline(body.mission).slice(0, 1000);
    if (body.values !== undefined) patch.values = parseValueList(body.values);
    if (body.tagline !== undefined) patch.tagline = clean(body.tagline).slice(0, 200);
    if (body.audience_profile !== undefined) {
      patch.audienceProfile = cleanMultiline(body.audience_profile).slice(0, 1000);
    }

    const brand = await updateBrand(brandId, patch);
    res.json({ brand, message: "Brand intake updated. Run a new analysis to see the effect." });
  })
);

export default router;
