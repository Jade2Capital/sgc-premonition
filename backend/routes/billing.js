/**
 * routes/billing.js
 * ---------------------------------------------------------------------------
 * Stripe subscription billing — $9.99/month, recurring.
 *
 *   POST /api/create-checkout-session   → Stripe Checkout URL
 *   POST /api/webhook/stripe            → Stripe calls this; we update state
 *   GET  /api/billing/status            → the client polls this after redirect
 *   POST /api/billing/portal            → Stripe Customer Portal (cancel/update card)
 *
 * ── THE ONE THING TO UNDERSTAND ────────────────────────────────────────────
 * The browser NEVER tells us a payment succeeded. The success_url redirect is
 * a convenience for the human; it is trivially forgeable. The ONLY thing that
 * grants access is a signed webhook from Stripe. Every line below follows from
 * that rule.
 *
 * ── SUBSCRIPTION, NOT ONE-TIME ─────────────────────────────────────────────
 * The SGC System Build Guide used `mode: "payment"` (charge once). This is
 * `mode: "subscription"` with a recurring price, which is what a $9.99/month
 * product needs. The Stripe Price object must be created as "Recurring →
 * Monthly", not "One time" — see README for the click-by-click.
 * ---------------------------------------------------------------------------
 */

import express from "express";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { checkoutLimiter } from "../middleware/rateLimit.js";
import { requireUser } from "../middleware/auth.js";
import { getStripe, stripeConfigured, stripeTimestampToIso } from "../config/stripe.js";
import { env } from "../config/env.js";
import { validateId } from "../lib/validate.js";
import {
  findUserById,
  setUserStatus,
  USER_STATUS,
} from "../models/user.js";
import {
  upsertSubscription,
  findSubscriptionByUser,
  findSubscriptionByStripeId,
  mapStripeStatus,
  isEntitled,
  hasProcessedEvent,
  markEventProcessed,
  SUB_STATUS,
} from "../models/subscription.js";
import {
  notifySubscriptionActive,
  notifySubscriptionProblem,
} from "../services/notify.js";

const router = express.Router();


/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/create-checkout-session

   REQUEST
   { "userId": "…uuid…" }              // email is looked up server-side

   RESPONSE 200
   { "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_…",
     "sessionId":   "cs_test_…" }

   ERRORS
     404 user_not_found
     409 already_subscribed
     503 stripe_not_configured
   ═══════════════════════════════════════════════════════════════════════════ */

router.post(
  "/create-checkout-session",
  checkoutLimiter,
  asyncHandler(async (req, res) => {
    if (!stripeConfigured()) {
      throw new HttpError(
        503,
        "Payments are not configured on this server. Set STRIPE_SECRET and STRIPE_PRICE_ID.",
        { code: "stripe_not_configured" }
      );
    }

    const userId = validateId(req.body?.userId, "userId");
    const user = await findUserById(userId);
    if (!user) {
      throw new HttpError(404, "No signup found for that id. Please sign up again.", {
        code: "user_not_found",
      });
    }

    // Don't let an already-paying customer create a second subscription.
    const existing = await findSubscriptionByUser(user.id);
    if (isEntitled(existing)) {
      throw new HttpError(409, "This account already has an active subscription.", {
        code: "already_subscribed",
      });
    }

    const stripe = getStripe();

    // We pass the token on the success URL so the dashboard can authenticate
    // immediately after the redirect without the customer logging in.
    const successUrl =
      `${env.FRONTEND_URL}/dashboard.html` +
      `?checkout=success&session_id={CHECKOUT_SESSION_ID}&token=${user.access_token}`;
    const cancelUrl = `${env.FRONTEND_URL}/index.html?checkout=cancelled#signup`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription", // ← recurring. NOT "payment".
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],

      customer_email: user.email,
      client_reference_id: user.id,

      // metadata lands on the Checkout Session; subscription_data.metadata
      // lands on the Subscription itself. We set BOTH, because different
      // webhook events carry different objects and we want the user id on all
      // of them.
      metadata: { userId: user.id },
      subscription_data: { metadata: { userId: user.id } },

      success_url: successUrl,
      cancel_url: cancelUrl,

      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });

    // Record an "incomplete" subscription now so the account has a billing row
    // even if the customer abandons checkout. It flips to active on webhook.
    await upsertSubscription({
      userId: user.id,
      stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
      status: SUB_STATUS.INCOMPLETE,
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/webhook/stripe

   Stripe calls this. It is NOT called by your frontend.

   The raw request body is required for signature verification, so server.js
   mounts express.raw() on this path and skips the JSON parser. `req.body` here
   is a Buffer, not an object.

   Always responds 200 quickly. A non-2xx makes Stripe retry, and retrying a
   request that failed because of OUR bug just amplifies the bug.
   ═══════════════════════════════════════════════════════════════════════════ */

router.post(
  "/webhook/stripe",
  asyncHandler(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) {
      console.warn("[webhook] received but Stripe is not configured — ignoring");
      return res.sendStatus(200);
    }

    /* ── 1. Verify the signature ─────────────────────────────────────────── */
    let event;
    const signature = req.get("stripe-signature");

    if (env.STRIPE_WEBHOOK_SECRET) {
      try {
        event = stripe.webhooks.constructEvent(
          req.body,                    // Buffer — must be the raw bytes
          signature,
          env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        // 400 here is correct: the request was malformed or forged.
        console.error("[webhook] signature verification failed:", err.message);
        return res.status(400).json({ error: "invalid_signature", message: err.message });
      }
    } else {
      // Development escape hatch. Loud on purpose — anyone who can reach this
      // URL could grant themselves a subscription.
      console.warn(
        "[webhook] STRIPE_WEBHOOK_SECRET is not set — accepting UNVERIFIED webhook. " +
        "Never run production like this."
      );
      try {
        event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body);
      } catch {
        return res.status(400).json({ error: "invalid_payload" });
      }
    }

    /* ── 2. Idempotency: has this event already been handled? ────────────── */
    if (await hasProcessedEvent(event.id)) {
      console.log(`[webhook] ${event.id} (${event.type}) already processed — skipping`);
      return res.sendStatus(200);
    }

    /* ── 3. Handle it ────────────────────────────────────────────────────── */
    try {
      await handleStripeEvent(stripe, event);
      await markEventProcessed(event.id, event.type, { type: event.type });
    } catch (err) {
      // Log loudly, still return 200. Stripe retries do not fix our bugs, and
      // an endless retry storm makes the incident worse.
      console.error(`[webhook] handler failed for ${event.type} (${event.id}):`, err);
    }

    res.sendStatus(200);
  })
);


/**
 * The webhook state machine.
 *
 * Every branch does the same three things:
 *   1. work out WHICH user this is about
 *   2. update the local subscription cache
 *   3. update the user's account status to match
 */
async function handleStripeEvent(stripe, event) {
  const object = event.data.object;

  switch (event.type) {
    /* ── The customer finished checkout ─────────────────────────────────── */
    case "checkout.session.completed": {
      const userId = object.metadata?.userId || object.client_reference_id;
      if (!userId) {
        console.warn("[webhook] checkout.session.completed with no userId — ignoring");
        return;
      }

      const user = await findUserById(userId);
      if (!user) {
        console.warn(`[webhook] checkout.session.completed for unknown user ${userId}`);
        return;
      }

      // Fetch the subscription to get its real status and period end. The
      // session object only has ids.
      let stripeStatus = "active";
      let periodEnd = null;

      if (object.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(object.subscription);
          stripeStatus = sub.status;
          periodEnd = stripeTimestampToIso(sub.current_period_end);
        } catch (err) {
          console.warn("[webhook] could not retrieve subscription:", err.message);
        }
      }

      const localStatus = mapStripeStatus(stripeStatus);

      const subscription = await upsertSubscription({
        userId: user.id,
        stripeCustomerId: object.customer ?? null,
        stripeSubscriptionId: object.subscription ?? null,
        status: localStatus,
        currentPeriodEnd: periodEnd,
      });

      await setUserStatus(
        user.id,
        localStatus === SUB_STATUS.ACTIVE ? USER_STATUS.ACTIVE : USER_STATUS.PENDING
      );

      console.log(`[webhook] user ${user.id} → ${localStatus}`);
      notifySubscriptionActive({ user, subscription }).catch(() => {});
      return;
    }

    /* ── A monthly renewal succeeded ────────────────────────────────────── */
    case "invoice.paid": {
      const stripeSubscriptionId = object.subscription;
      if (!stripeSubscriptionId) return;

      const local = await findSubscriptionByStripeId(stripeSubscriptionId);
      if (!local) {
        console.warn(`[webhook] invoice.paid for unknown subscription ${stripeSubscriptionId}`);
        return;
      }

      let periodEnd = null;
      try {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        periodEnd = stripeTimestampToIso(sub.current_period_end);
      } catch { /* non-fatal */ }

      await upsertSubscription({
        userId: local.user_id,
        stripeSubscriptionId,
        status: SUB_STATUS.ACTIVE,
        currentPeriodEnd: periodEnd,
      });
      await setUserStatus(local.user_id, USER_STATUS.ACTIVE);

      console.log(`[webhook] renewal paid for user ${local.user_id}`);
      return;
    }

    /* ── A renewal failed ───────────────────────────────────────────────── */
    case "invoice.payment_failed": {
      const stripeSubscriptionId = object.subscription;
      if (!stripeSubscriptionId) return;

      const local = await findSubscriptionByStripeId(stripeSubscriptionId);
      if (!local) return;

      await upsertSubscription({
        userId: local.user_id,
        stripeSubscriptionId,
        status: SUB_STATUS.PAST_DUE,
      });
      await setUserStatus(local.user_id, USER_STATUS.PAST_DUE);

      const user = await findUserById(local.user_id);
      console.warn(`[webhook] payment failed for user ${local.user_id} → past_due`);
      notifySubscriptionProblem({
        user,
        status: "past_due",
        detail: `Invoice ${object.id} failed. Stripe will retry automatically.`,
      }).catch(() => {});
      return;
    }

    /* ── Plan or status changed in Stripe ───────────────────────────────── */
    case "customer.subscription.updated": {
      const local = await findSubscriptionByStripeId(object.id);
      const userId = local?.user_id || object.metadata?.userId;
      if (!userId) return;

      const localStatus = mapStripeStatus(object.status);

      await upsertSubscription({
        userId,
        stripeCustomerId: object.customer ?? null,
        stripeSubscriptionId: object.id,
        status: localStatus,
        currentPeriodEnd: stripeTimestampToIso(object.current_period_end),
      });

      const userStatus =
        localStatus === SUB_STATUS.ACTIVE ? USER_STATUS.ACTIVE
        : localStatus === SUB_STATUS.PAST_DUE ? USER_STATUS.PAST_DUE
        : localStatus === SUB_STATUS.CANCELED ? USER_STATUS.CANCELED
        : USER_STATUS.PENDING;

      await setUserStatus(userId, userStatus);
      console.log(`[webhook] subscription updated: user ${userId} → ${localStatus}`);
      return;
    }

    /* ── Cancelled ──────────────────────────────────────────────────────── */
    case "customer.subscription.deleted": {
      const local = await findSubscriptionByStripeId(object.id);
      const userId = local?.user_id || object.metadata?.userId;
      if (!userId) return;

      await upsertSubscription({
        userId,
        stripeSubscriptionId: object.id,
        status: SUB_STATUS.CANCELED,
      });
      await setUserStatus(userId, USER_STATUS.CANCELED);

      const user = await findUserById(userId);
      console.log(`[webhook] subscription cancelled for user ${userId}`);
      notifySubscriptionProblem({
        user,
        status: "canceled",
        detail: "Subscription ended.",
      }).catch(() => {});
      return;
    }

    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/billing/status

   The dashboard polls this for a few seconds after the Stripe redirect,
   because the webhook and the browser redirect race each other. This is the
   correct way to handle that race: poll for the webhook's effect, never trust
   the redirect itself.

   HEADERS  Authorization: Bearer <accessToken>
   RESPONSE { "status": "active", "entitled": true, "userStatus": "active",
              "currentPeriodEnd": "2026-09-22T…", "plan": {…} }
   ═══════════════════════════════════════════════════════════════════════════ */

router.get(
  "/billing/status",
  requireUser,
  asyncHandler(async (req, res) => {
    const subscription = await findSubscriptionByUser(req.user.id);
    res.json({
      status: subscription?.status ?? "none",
      entitled: isEntitled(subscription),
      userStatus: req.user.status,
      currentPeriodEnd: subscription?.current_period_end ?? null,
      plan: {
        name: env.PLAN_NAME,
        priceUsd: env.PLAN_PRICE_USD,
        interval: "month",
      },
    });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/billing/portal

   Sends the customer to Stripe's hosted Customer Portal so they can update a
   card or cancel. Building your own cancel flow is a lot of work and a
   compliance surface; the portal is free and handles it.

   Enable it once at: Stripe Dashboard → Settings → Billing → Customer portal
   ═══════════════════════════════════════════════════════════════════════════ */

router.post(
  "/billing/portal",
  requireUser,
  asyncHandler(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) {
      throw new HttpError(503, "Payments are not configured on this server.", {
        code: "stripe_not_configured",
      });
    }

    const subscription = await findSubscriptionByUser(req.user.id);
    if (!subscription?.stripe_customer_id) {
      throw new HttpError(404, "No Stripe customer on file for this account.", {
        code: "no_customer",
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: `${env.FRONTEND_URL}/dashboard.html?token=${req.user.access_token}`,
    });

    res.json({ portalUrl: session.url });
  })
);

export default router;
