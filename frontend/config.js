/**
 * config.js
 * ---------------------------------------------------------------------------
 * ★ THIS IS THE ONE FILE YOU EDIT WHEN YOU DEPLOY. ★
 *
 * Point API_BASE at wherever your backend is running.
 *
 *   Local development:  http://localhost:3000
 *   Render production:  https://sgc-premonition-api.onrender.com
 *
 * No trailing slash. No "/api" on the end — the code adds that.
 * ---------------------------------------------------------------------------
 */

const SGC_CONFIG = {
  /**
   * The backend URL.
   *
   * The logic below auto-detects localhost so you do not have to keep editing
   * this file while developing. When the page is served from anywhere else,
   * PRODUCTION_API is used — replace that value before you deploy.
   */
  PRODUCTION_API: "https://sgc-premonition-api.onrender.com",
  LOCAL_API: "http://localhost:3000",

  get API_BASE() {
    const host = window.location.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
    return isLocal ? this.LOCAL_API : this.PRODUCTION_API;
  },

  /** Where the access token is kept in the browser. */
  TOKEN_KEY: "sgc_premonition_token",

  /** Fallback price, shown before /api/config responds. */
  FALLBACK_PRICE: "$9.99/month",
};

/** Build a full API URL: apiUrl("/signup") → "http://localhost:3000/api/signup" */
function apiUrl(path) {
  return `${SGC_CONFIG.API_BASE}/api${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Shared fetch wrapper.
 *
 * Handles the three things every call needs: the bearer token, JSON encoding,
 * and turning an error response into a thrown Error the caller can display.
 */
async function api(path, { method = "GET", body = null, token = null } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    // fetch() only rejects on network-level failure, which almost always means
    // the backend is not running or CORS blocked the request.
    throw Object.assign(
      new Error(
        `Could not reach the SGC Premonition API at ${SGC_CONFIG.API_BASE}. ` +
        `Check that the backend is running and that FRONTEND_URL on the server matches this page's address.`
      ),
      { code: "network_error", cause: networkError }
    );
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    throw Object.assign(new Error(data.message || `Request failed (${response.status})`), {
      status: response.status,
      code: data.error,
      fields: data.fields,
    });
  }

  return data;
}

/* Token storage helpers. sessionStorage is deliberately NOT used, so the
   dashboard survives a browser restart. */
const tokenStore = {
  get() {
    try {
      return localStorage.getItem(SGC_CONFIG.TOKEN_KEY);
    } catch {
      return null; // private browsing with storage disabled
    }
  },
  set(token) {
    try {
      localStorage.setItem(SGC_CONFIG.TOKEN_KEY, token);
    } catch {
      /* nothing we can do; the ?token= URL still works */
    }
  },
  clear() {
    try {
      localStorage.removeItem(SGC_CONFIG.TOKEN_KEY);
    } catch { /* ignore */ }
  },
};
