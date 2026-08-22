/**
 * routes/auth.js
 * ---------------------------------------------------------------------------
 * Signup and "who am I" routes.
 *
 *   POST /api/signup      create user + brand, return an access token
 *   GET  /api/me          the signed-in user, their brand, and their status
 *
 * ---------------------------------------------------------------------------
 */

import express from "express";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireUser } from "../middleware/auth.js";
import { signupLimiter } from "../middleware/rateLimit.js";
import { validateSignup } from "../lib/validate.js";
import {
  createUser,
  findUserByEmail,
  publicUser,
} from "../models/user.js";
import { createBrand, findPrimaryBrandForUser } from "../models/brand.js";
import { findSubscriptionByUser, isEntitled } from "../models/subscription.js";
import { findLatestRunForBrand, scoreHistory } from "../models/analysisRun.js";
import { notifySignup } from "../services/notify.js";
import { CATEGORY_BY_KEY } from "../services/matrix.js";
import { env } from "../config/env.js";

const router = express.Router();

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/signup

   REQUEST
   {
     "name": "Jadrian",
     "email": "user@example.com",
     "brand_name": "Iron Market Records",
     "sector": "Music",
     "region": "US",
     "description": "Independent label focused on AI-assisted production.",
     "primary_profile_type": "influence",

     // optional richer intake — accepted, not required
     "website_url": "https://ironmarket.example",
     "social_links": "https://instagram.com/x, https://x.com/y",
     "mission": "...",
     "values": "craft, transparency, speed",
     "tagline": "...",
     "audience_profile": "..."
   }

   RESPONSE 201
   {
     "userId": "…uuid…",
     "brandId": "…uuid…",
     "accessToken": "…64 hex chars…",
     "status": "pending",
     "message": "Signup created. Proceed to payment.",
     "nextStep": "create-checkout-session"
   }

   ERRORS
     400 validation_error   → body.fields maps field name → message
     409 email_in_use       → that email already signed up
   ═══════════════════════════════════════════════════════════════════════════ */

router.post(
  "/signup",
  signupLimiter,
  asyncHandler(async (req, res) => {
    // 1. Validate and clean. Throws ValidationError (400) on bad input.
    const data = validateSignup(req.body);

    // 2. One account per email in v1.
    const existing = await findUserByEmail(data.email);
    if (existing) {
      throw new HttpError(
        409,
        "That email address has already signed up. Use your dashboard link, or contact support to recover access.",
        { code: "email_in_use" }
      );
    }

    // 3. Create the user, then the brand they want analysed.
    const user = await createUser({
      name: data.name,
      email: data.email,
      primaryProfileType: data.primaryProfileType,
    });

    const brand = await createBrand({
      userId: user.id,
      brandName: data.brandName,
      sector: data.sector,
      region: data.region,
      description: data.description,
      websiteUrl: data.websiteUrl,
      socialLinks: data.socialLinks,
      mission: data.mission,
      values: data.values,
      tagline: data.tagline,
      audienceProfile: data.audienceProfile,
    });

    // 4. Alert the operator. Fire and forget — never blocks the response.
    notifySignup({ user, brand }).catch(() => {});

    // 5. Hand back the token. This is the ONLY time it is returned in full on
    //    a create; the client must store it.
    res.status(201).json({
      userId: user.id,
      brandId: brand.id,
      accessToken: user.access_token,
      status: user.status,
      primaryProfileType: user.primary_profile_type,
      message: "Signup created. Proceed to payment.",
      nextStep: "create-checkout-session",
    });
  })
);


/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/me
   Everything the dashboard needs in one round trip.

   HEADERS  Authorization: Bearer <accessToken>

   RESPONSE 200
   {
     "user":         { id, name, email, primary_profile_type, status, created_at },
     "profile":      { key, label, question, summary },
     "brand":        { id, brand_name, sector, region, description, ... },
     "subscription": { status, plan_name, price, current_period_end } | null,
     "entitled":     true,
     "latestRun":    { … } | null,
     "history":      [ { run_at, overall_score, tier } … ],
     "plan":         { name, priceUsd, interval }
   }
   ═══════════════════════════════════════════════════════════════════════════ */

router.get(
  "/me",
  requireUser,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const brand = await findPrimaryBrandForUser(user.id);
    const subscription = await findSubscriptionByUser(user.id);

    const latestRun = brand ? await findLatestRunForBrand(brand.id) : null;
    const history = brand ? await scoreHistory(brand.id, { limit: 12 }) : [];

    const category = CATEGORY_BY_KEY[user.primary_profile_type] ?? null;

    res.json({
      user: publicUser(user),
      profile: category
        ? {
            key: category.key,
            label: category.label,
            question: category.question,
            summary: category.summary,
          }
        : null,
      brand,
      subscription: subscription
        ? {
            status: subscription.status,
            plan_name: subscription.plan_name,
            price: Number(subscription.price),
            currency: subscription.currency,
            interval_unit: subscription.interval_unit,
            current_period_end: subscription.current_period_end,
          }
        : null,
      entitled: isEntitled(subscription) || !env.REQUIRE_ACTIVE_SUBSCRIPTION,
      latestRun,
      history,
      plan: {
        name: env.PLAN_NAME,
        priceUsd: env.PLAN_PRICE_USD,
        interval: "month",
      },
    });
  })
);

export default router;
