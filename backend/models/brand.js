/**
 * models/brand.js
 * ---------------------------------------------------------------------------
 * All SQL that touches `brands`.
 *
 * JSON COLUMNS: `social_links` and `brand_values` are JSONB on Postgres and
 * TEXT on SQLite. Every read goes through hydrate() and every write through
 * stringifyJson(), so callers always see real JS arrays.
 * ---------------------------------------------------------------------------
 */

import { query, queryOne, execute, stringifyJson, parseJson } from "../config/db.js";
import { newId } from "../lib/ids.js";

/** Convert raw DB row → JS object with parsed JSON columns. */
async function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    social_links: (await parseJson(row.social_links)) ?? [],
    brand_values: (await parseJson(row.brand_values)) ?? [],
  };
}

/**
 * Create a brand owned by a user.
 *
 * @param {object} data
 * @param {string} data.userId
 * @param {string} data.brandName
 * @param {string} [data.sector]
 * @param {string} [data.region]
 * @param {string} [data.description]
 * @param {string} [data.websiteUrl]
 * @param {string[]} [data.socialLinks]
 * @param {string} [data.mission]
 * @param {string[]} [data.values]
 * @param {string} [data.tagline]
 * @param {string} [data.audienceProfile]
 */
export async function createBrand(data) {
  const id = newId();

  await execute(
    `INSERT INTO brands
       (id, user_id, brand_name, sector, region, description,
        website_url, social_links, mission, brand_values, tagline, audience_profile)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      data.userId,
      data.brandName,
      data.sector ?? null,
      data.region ?? null,
      data.description ?? null,
      data.websiteUrl ?? null,
      stringifyJson(data.socialLinks ?? []),
      data.mission ?? null,
      stringifyJson(data.values ?? []),
      data.tagline ?? null,
      data.audienceProfile ?? null,
    ]
  );

  return findBrandById(id);
}

export async function findBrandById(id) {
  const row = await queryOne(`SELECT * FROM brands WHERE id = $1`, [id]);
  return hydrate(row);
}

/** Every brand a user owns, newest first. */
export async function findBrandsByUser(userId) {
  const { rows } = await query(
    `SELECT * FROM brands WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return Promise.all(rows.map(hydrate));
}

/** The user's first/primary brand — what the v1 dashboard shows. */
export async function findPrimaryBrandForUser(userId) {
  const row = await queryOne(
    `SELECT * FROM brands WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  return hydrate(row);
}

/**
 * Partial update. Only the keys you pass are written.
 * Column names are looked up in an allow-list, never interpolated from input —
 * this is what keeps the dynamic SQL below injection-safe.
 */
export async function updateBrand(id, patch = {}) {
  const COLUMNS = {
    brandName: "brand_name",
    sector: "sector",
    region: "region",
    description: "description",
    websiteUrl: "website_url",
    mission: "mission",
    tagline: "tagline",
    audienceProfile: "audience_profile",
  };
  const JSON_COLUMNS = {
    socialLinks: "social_links",
    values: "brand_values",
  };

  const sets = [];
  const params = [];
  let n = 1;

  for (const [key, column] of Object.entries(COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = $${n++}`);
      params.push(patch[key]);
    }
  }
  for (const [key, column] of Object.entries(JSON_COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = $${n++}`);
      params.push(stringifyJson(patch[key]));
    }
  }

  if (sets.length === 0) return findBrandById(id);

  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  params.push(id);

  await execute(`UPDATE brands SET ${sets.join(", ")} WHERE id = $${n}`, params);
  return findBrandById(id);
}

/** Does this user own this brand? Used for authorisation on every brand route. */
export async function userOwnsBrand(userId, brandId) {
  const row = await queryOne(
    `SELECT id FROM brands WHERE id = $1 AND user_id = $2`,
    [brandId, userId]
  );
  return Boolean(row);
}
