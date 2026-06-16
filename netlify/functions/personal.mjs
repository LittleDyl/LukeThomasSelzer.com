/**
 * /api/personal — owner-edited Personal Bio fields, server-side.
 *
 * Replaces the previous localStorage-only implementation, which only
 * persisted edits on the editor's own device (so a parent editing on
 * the laptop would NOT see their changes on the phone, and neither
 * would any visitor). Now the overrides live in Netlify Blobs and
 * every device/browser sees the same content.
 *
 * GET     → public. Returns the overrides object, or `{}` if nothing
 *           has ever been saved. Shape is { fieldName: stringValue }.
 * PUT     → owner only. Body is the FULL overrides object — the client
 *           sends every field every save. No concept of patch.
 * DELETE  → owner only. Wipes overrides (Reset-to-Defaults).
 *
 * Storage: single JSON blob in Netlify Blobs ("portfolio" store, key
 * "personal-overrides"). Same strategy as /api/featured-swing — one
 * blob, last-write-wins. If the bio ever outgrows a single blob we
 * can shard later (YAGNI).
 *
 * Owner auth: pass the plain password in the `X-Owner-Password`
 * header. Identical to /api/tournaments, /api/swing-videos, etc.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "personal-overrides";

// Whitelist of accepted field names. Anything else in the PUT body
// is dropped on the floor — defense in depth so a future client bug
// can't slip surprise keys into the blob. Mirror with the FIELDS
// constant in the PersonalBio client module.
const ALLOWED_FIELDS = new Set([
  "name", "hometown", "class_year", "age", "currently_attending",
  "photo", "bio",
  // physical / contact details — surfaced on the Personal Bio tab and
  // in the visitor resume PDF. Stored as plain strings; the client
  // decides display formatting.
  "height", "weight", "home_address", "phone",
  // socials — keep aligned with SOCIAL_PLATFORMS on the client
  "instagram", "twitter", "tiktok", "youtube", "facebook", "linkedin", "website",
]);

// Generous cap — `bio` is the longest legitimate field, everything
// else is short. Anything over this is almost certainly a paste-bomb
// or someone trying to fill the blob; silently drop it rather than
// 400-ing the whole save.
const MAX_FIELD_LEN = 2000;

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

// Normalize the body: keep only whitelisted fields, trim strings,
// drop empties (so "clearing" a field in the form reverts to the
// hardcoded default rather than persisting an empty override).
function normalize(body) {
  if (!body || typeof body !== "object") return {};
  const out = {};
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    const raw = body[key];
    if (raw == null) continue;
    const v = raw.toString().trim();
    if (!v) continue;
    if (v.length > MAX_FIELD_LEN) continue;
    out[key] = v;
  }
  return out;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Strong consistency — same trade-off as /api/swing-videos. Small
  // latency hit, no "where'd my edit go?" after-save confusion.
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  // ---- GET: public read ----
  if (req.method === "GET") {
    const data = await store.get(BLOB_KEY, { type: "json" });
    return json(200, (data && typeof data === "object") ? data : {});
  }

  // ---- PUT: owner saves the full overrides object ----
  if (req.method === "PUT") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const next = normalize(body);
    await store.setJSON(BLOB_KEY, next);
    return json(200, next);
  }

  // ---- DELETE: owner wipes all overrides ("Reset to Defaults") ----
  if (req.method === "DELETE") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });
    await store.delete(BLOB_KEY);
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
