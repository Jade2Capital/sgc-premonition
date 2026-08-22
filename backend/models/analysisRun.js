/**
 * models/analysisRun.js
 * ---------------------------------------------------------------------------
 * All SQL that touches `analysis_runs` — the stored history of every
 * Premonition analysis.
 *
 * This history is not just an audit log; it is a PRODUCT FEATURE. The
 * predictive engine's trajectory reading is only real once a brand has two
 * runs to compare, so persisting every run is what makes the second month of
 * a subscription worth more than the first.
 * ---------------------------------------------------------------------------
 */

import { query, queryOne, execute, stringifyJson, parseJson } from "../config/db.js";
import { newId } from "../lib/ids.js";

/** Raw DB row → JS object with JSON columns parsed. */
async function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    risk_flags:       (await parseJson(row.risk_flags)) ?? [],
    strengths:        (await parseJson(row.strengths)) ?? [],
    weaknesses:       (await parseJson(row.weaknesses)) ?? [],
    improvement_plan: (await parseJson(row.improvement_plan)) ?? [],
    raw_payload:      await parseJson(row.raw_payload),
  };
}

/**
 * Persist one analysis.
 *
 * @param {object} args
 * @param {string} args.brandId
 * @param {string} args.userId
 * @param {object} args.scored     from scoring.scoreBrand()
 * @param {object} args.predicted  from predictive.runPredictive()
 * @param {object} args.report     from report.buildReport()
 * @param {object} args.signal     the AnalysisSignal from the AI provider
 */
export async function createAnalysisRun({ brandId, userId, scored, predicted, report, signal }) {
  const id = newId();

  // IMPORTANT: run_at is set by the APPLICATION, not by the database default.
  //
  // SQLite's CURRENT_TIMESTAMP has one-SECOND resolution. Two analyses in the
  // same second get identical timestamps, and `ORDER BY run_at DESC` then
  // returns them in arbitrary order — which silently corrupts "latest run",
  // "previous run", and the whole trajectory calculation. An ISO string with
  // milliseconds fixes it, sorts correctly as text, and behaves identically on
  // Postgres. Every ORDER BY in this file also adds `id` as a tiebreaker.
  const runAt = new Date().toISOString();

  await execute(
    `INSERT INTO analysis_runs (
       id, brand_id, user_id,
       influence_score, identity_score, infrastructure_score,
       intelligence_score, impact_score,
       overall_score, tier,
       trajectory_label, risk_flags, forecast_notes,
       summary, strengths, weaknesses, improvement_plan,
       engine_version, ai_provider, raw_payload,
       run_at
     ) VALUES (
       $1,$2,$3,
       $4,$5,$6,
       $7,$8,
       $9,$10,
       $11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,$20,
       $21
     )`,
    [
      id,
      brandId,
      userId,
      scored.categories.influence,
      scored.categories.identity,
      scored.categories.infrastructure,
      scored.categories.intelligence,
      scored.categories.impact,
      scored.overall,
      scored.tier.label,
      predicted.trajectory.label,
      stringifyJson(predicted.riskFlags),
      predicted.trajectory.notes,
      report.overview,
      stringifyJson(report.strengths),
      stringifyJson(report.weaknesses),
      stringifyJson(predicted.improvementPlan),
      signal.version ?? "v1-stub",
      signal.provider ?? "stub",
      stringifyJson({
        subScores: scored.subScores,
        weights: scored.weights,
        confidence: report.confidence,
        breakdown: report.breakdown,
        nextAnalysis: report.nextAnalysis,
        providerMeta: signal.meta ?? null,
      }),
      runAt,
    ]
  );

  return findAnalysisRunById(id);
}

export async function findAnalysisRunById(id) {
  const row = await queryOne(`SELECT * FROM analysis_runs WHERE id = $1`, [id]);
  return hydrate(row);
}

/** The most recent run for a brand, or null. */
export async function findLatestRunForBrand(brandId) {
  const row = await queryOne(
    `SELECT * FROM analysis_runs WHERE brand_id = $1 ORDER BY run_at DESC, id DESC LIMIT 1`,
    [brandId]
  );
  return hydrate(row);
}

/**
 * The run BEFORE the latest one. This is what the predictive engine compares
 * against to produce a real period-over-period trajectory.
 */
export async function findPreviousRunForBrand(brandId) {
  const { rows } = await query(
    `SELECT * FROM analysis_runs WHERE brand_id = $1 ORDER BY run_at DESC, id DESC LIMIT 2`,
    [brandId]
  );
  return rows.length >= 2 ? hydrate(rows[1]) : null;
}

/** Full history for a brand, newest first. */
export async function listRunsForBrand(brandId, { limit = 24 } = {}) {
  const { rows } = await query(
    `SELECT * FROM analysis_runs WHERE brand_id = $1 ORDER BY run_at DESC, id DESC LIMIT $2`,
    [brandId, limit]
  );
  return Promise.all(rows.map(hydrate));
}

/**
 * The population for SECTOR BENCHMARKING: the LATEST run of each brand in a
 * sector — one row per brand, never one row per run.
 *
 * WHY THIS MATTERS: a customer who re-analyses twenty times would otherwise
 * contribute twenty rows and drag the whole sector mean toward themselves,
 * while a customer who ran once contributes one. Benchmarks are per-brand
 * comparisons, so the population must be per-brand.
 *
 * The correlated subquery ("this row is the newest run for its brand") is
 * valid SQL on both SQLite and Postgres.
 */
export async function runsInSector(sector, { excludeBrandId = null, limit = 500 } = {}) {
  if (!sector) return [];

  const sql = `
    SELECT r.influence_score, r.identity_score, r.infrastructure_score,
           r.intelligence_score, r.impact_score, r.overall_score
      FROM analysis_runs r
      JOIN brands b ON b.id = r.brand_id
     WHERE LOWER(b.sector) = LOWER($1)
       ${excludeBrandId ? "AND r.brand_id <> $2" : ""}
       AND r.id = (
             SELECT r2.id
               FROM analysis_runs r2
              WHERE r2.brand_id = r.brand_id
              ORDER BY r2.run_at DESC, r2.id DESC
              LIMIT 1
           )
     ORDER BY r.run_at DESC, r.id DESC
     LIMIT ${excludeBrandId ? "$3" : "$2"}`;

  const params = excludeBrandId ? [sector, excludeBrandId, limit] : [sector, limit];
  const { rows } = await query(sql, params);
  return rows;
}

/** How many analyses has this user run? Used for soft rate limiting. */
export async function countRunsForUserSince(userId, isoTimestamp) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM analysis_runs WHERE user_id = $1 AND run_at >= $2`,
    [userId, isoTimestamp]
  );
  return Number(row?.n ?? 0);
}

/**
 * Compact shape for the dashboard's score-history sparkline.
 * Returned oldest-first so it can be plotted left to right.
 */
export async function scoreHistory(brandId, { limit = 12 } = {}) {
  const { rows } = await query(
    `SELECT id, run_at, overall_score, tier, trajectory_label
       FROM analysis_runs
      WHERE brand_id = $1
      ORDER BY run_at DESC, id DESC
      LIMIT $2`,
    [brandId, limit]
  );
  return rows.reverse();
}
