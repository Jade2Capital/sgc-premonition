/**
 * models/user.js
 * ---------------------------------------------------------------------------
 * All SQL that touches `users` lives here. Routes never write SQL.
 *
 * Every function returns a plain JS object (or null), never a driver-specific
 * result wrapper, so route code is identical on SQLite and Postgres.
 * ---------------------------------------------------------------------------
 */

import { query, queryOne, execute } from "../config/db.js";
import { newId, newAccessToken } from "../lib/ids.js";

/** Statuses a user account can be in. Mirrors the CHECK constraint. */
export const USER_STATUS = Object.freeze({
  PENDING: "pending",   // signed up, has not paid
  ACTIVE: "active",     // subscription in good standing
  PAST_DUE: "past_due", // payment failed, still in grace
  CANCELED: "canceled", // subscription ended
});

/**
 * Create a user.
 * @param {{name:string, email:string, primaryProfileType:string}} data
 * @return {Promise<object>} the created row (including access_token)
 */
export async function createUser({ name, email, primaryProfileType }) {
  const id = newId();
  const accessToken = newAccessToken();

  await execute(
    `INSERT INTO users (id, name, email, primary_profile_type, status, access_token)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, name, email.toLowerCase(), primaryProfileType, USER_STATUS.PENDING, accessToken]
  );

  // Insert-then-select rather than RETURNING: identical behaviour on both drivers.
  return findUserById(id);
}

export async function findUserById(id) {
  return queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
}

export async function findUserByEmail(email) {
  if (!email) return null;
  return queryOne(`SELECT * FROM users WHERE email = $1`, [String(email).toLowerCase()]);
}

export async function findUserByAccessToken(token) {
  if (!token) return null;
  return queryOne(`SELECT * FROM users WHERE access_token = $1`, [token]);
}

/**
 * Change a user's account status. Called by the Stripe webhook handler.
 * @param {string} userId
 * @param {string} status  one of USER_STATUS
 */
export async function setUserStatus(userId, status) {
  if (!Object.values(USER_STATUS).includes(status)) {
    throw new Error(`invalid user status: ${status}`);
  }
  await execute(
    `UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [status, userId]
  );
  return findUserById(userId);
}

/**
 * Update the profile type the user picked at signup.
 * Exposed so the dashboard can later let them switch lenses.
 */
export async function setPrimaryProfileType(userId, profileType) {
  await execute(
    `UPDATE users SET primary_profile_type = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [profileType, userId]
  );
  return findUserById(userId);
}

/** Rotate the bearer token (use if a token is ever exposed). */
export async function rotateAccessToken(userId) {
  const token = newAccessToken();
  await execute(
    `UPDATE users SET access_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [token, userId]
  );
  return token;
}

/** The flat read-model described in the build brief, backed by a view. */
export async function getUserOverview(userId) {
  return queryOne(`SELECT * FROM v_user_overview WHERE user_id = $1`, [userId]);
}

/** Simple admin listing. Newest first. */
export async function listUsers({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT id, name, email, primary_profile_type, status, created_at
       FROM users
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

/**
 * Strip secrets before a user object is put into an HTTP response.
 * ALWAYS run a user row through this before res.json().
 */
export function publicUser(user) {
  if (!user) return null;
  const { access_token, ...safe } = user;
  return safe;
}
