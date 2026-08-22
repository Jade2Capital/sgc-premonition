/**
 * models/subscription.js
 * ---------------------------------------------------------------------------
 * All SQL that touches `subscriptions`, plus the idempotency helpers for
 * Stripe webhook processing.
 *
 * IMPORTANT MENTAL MODEL: Stripe is the source of truth for billing. This
 * table is a local CACHE of Stripe's state, updated by webhooks. Never bill
 * from this table; never let it disagree with Stripe for long.
 * ---------------------------------------------------------------------------
 */

import { query, queryOne, execute, stringifyJson } from "../config/db.js";
import { newId } from "../lib/ids.js";
import { env } from "../config/env.js";

/** Mirrors the CHECK constraint on subscriptions.status. */
export const SUB_STATUS = Object.freeze({
  INCOMPLETE: "incomplete",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
});

/**
 * Map a Stripe subscription status onto ours.
 * Stripe has more states than we need; this is the deliberate narrowing.
 */
export function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return SUB_STATUS.ACTIVE;
    case "past_due":
      return SUB_STATUS.PAST_DUE;
    case "unpaid":
      return SUB_STATUS.UNPAID;
    case "canceled":
    case "incomplete_expired":
      return SUB_STATUS.CANCELED;
    case "incomplete":
    default:
      return SUB_STATUS.INCOMPLETE;
  }
}

export async function findSubscriptionByUser(userId) {
  return queryOne(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
}

export async function findSubscriptionByStripeId(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  return queryOne(
    `SELECT * FROM subscriptions WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId]
  );
}

/**
 * Create or update the local subscription record for a user.
 *
 * This is an UPSERT written the portable way (select, then insert or update)
 * because Postgres `ON CONFLICT` and SQLite `ON CONFLICT` differ enough in the
 * details that one statement for both is not worth the subtlety.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} [args.stripeCustomerId]
 * @param {string} [args.stripeSubscriptionId]
 * @param {string} [args.status]              one of SUB_STATUS
 * @param {string} [args.currentPeriodEnd]    ISO string
 */
export async function upsertSubscription({
  userId,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  status = SUB_STATUS.INCOMPLETE,
  currentPeriodEnd = null,
}) {
  const existing =
    (stripeSubscriptionId && (await findSubscriptionByStripeId(stripeSubscriptionId))) ||
    (await findSubscriptionByUser(userId));

  if (existing) {
    await execute(
      `UPDATE subscriptions
          SET stripe_customer_id     = COALESCE($1, stripe_customer_id),
              stripe_subscription_id = COALESCE($2, stripe_subscription_id),
              status                 = $3,
              current_period_end     = COALESCE($4, current_period_end),
              updated_at             = CURRENT_TIMESTAMP
        WHERE id = $5`,
      [stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd, existing.id]
    );
    return queryOne(`SELECT * FROM subscriptions WHERE id = $1`, [existing.id]);
  }

  const id = newId();
  await execute(
    `INSERT INTO subscriptions
       (id, user_id, stripe_customer_id, stripe_subscription_id,
        plan_name, price, currency, interval_unit, status, current_period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      env.PLAN_NAME,
      env.PLAN_PRICE_USD,
      "usd",
      "month",
      status,
      currentPeriodEnd,
    ]
  );
  return queryOne(`SELECT * FROM subscriptions WHERE id = $1`, [id]);
}

/** True when the user may use paid features. */
export function isEntitled(subscription) {
  if (!subscription) return false;
  // past_due keeps access during Stripe's retry window — cancelling a paying
  // customer's access on the first failed charge is how you lose them.
  return [SUB_STATUS.ACTIVE, SUB_STATUS.PAST_DUE].includes(subscription.status);
}


/* ═══════════════════════════════════════════════════════════════════════════
   WEBHOOK IDEMPOTENCY

   Stripe retries deliveries. Without this, a retry double-processes an event.
   Call hasProcessedEvent() first; call markEventProcessed() after success.
   ═══════════════════════════════════════════════════════════════════════════ */

export async function hasProcessedEvent(eventId) {
  const row = await queryOne(`SELECT id FROM webhook_events WHERE id = $1`, [eventId]);
  return Boolean(row);
}

export async function markEventProcessed(eventId, type, payload = null) {
  try {
    await execute(
      `INSERT INTO webhook_events (id, type, payload) VALUES ($1, $2, $3)`,
      [eventId, type, stringifyJson(payload)]
    );
  } catch (err) {
    // A UNIQUE violation here means a concurrent delivery beat us to it.
    // That is the system working correctly, not an error worth surfacing.
    if (!/unique|duplicate/i.test(err.message)) throw err;
  }
}

/** Recent webhook deliveries — useful when debugging a billing complaint. */
export async function recentWebhookEvents(limit = 20) {
  const { rows } = await query(
    `SELECT id, type, processed_at FROM webhook_events ORDER BY processed_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
