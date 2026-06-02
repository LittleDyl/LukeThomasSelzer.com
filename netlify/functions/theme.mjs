/**
 * /api/theme — owner-customizable site color scheme.
 *
 * GET     → public. Returns the saved theme { primary, accent } or `{}`
 *           if nothing's been customized. Frontend uses {} to mean
 *           "fall back to the hardcoded :root defaults."
 * PUT     → owner only. Body: { primary?, accent? } as #RRGGBB hex.
 *           Either field can be omitted to leave that color at its
 *           default; an empty/missing field doesn't get persisted.
 * DELETE  → owner only. Wipes the theme blob entirely ("Reset to
 *           Defaults"), so the site reverts to its original green.
 *
 * Storage: single JSON blob in Netlify Blobs ("portfolio" store, key
 * "theme"). Mirrors the strategy used by /api/personal and
 * /api/featured-swing — one blob, one writer, last-write-wins.
 *
 * Owner auth: same X-Owner-Password header as every other
 * owner-mutating endpoint on the site.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "theme";

// Strict hex-color regex: exactly 6 hex digits, leading # required.
// The <input type="color"> element only ever emits this format, so
// rejecting anything else also rejects copy-paste mistakes upstream.
const HEX_RE = /^#[0-9a-f]{6}$/i;

const ALLOWED_FIELDS = new Set(["primary", "accent"]);

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Owner-Password",
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function isOwner(req) {
  const password = req.headers.get("x-owner-password");
  if (!password) return false;
  const expected = process.env.OWNER_PASSWORD_HASH;
  if (!expected) {
    console.error("OWNER_PASSWORD_HASH env var not configured");
    return false;
  }
  return sha256(password) === expected.toLowerCase();
}

// Keep only whitelisted, well-formed hex fields. Anything else is
// silently dropped — defense in depth against a buggy client.
function normalize(body) {
  if (!body || typeof body !== "object") return {};
  const out = {};
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    const v = (body[key] ?? "").toString().trim().toLowerCase();
    if (!HEX_RE.test(v)) continue;
    out[key] = v;
  }
  return out;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Strong consistency — small latency cost, no "where'd my theme go?"
  // race after save. Same trade-off as our other owner endpoints.
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  if (req.method === "GET") {
    const data = await store.get(BLOB_KEY, { type: "json" });
    return json(200, (data && typeof data === "object") ? data : {});
  }

  if (req.method === "PUT") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const next = normalize(body);
    await store.setJSON(BLOB_KEY, next);
    return json(200, next);
  }

  if (req.method === "DELETE") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });
    await store.delete(BLOB_KEY);
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
