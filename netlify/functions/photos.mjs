/**
 * /api/photos — owner-curated public photo gallery.
 *
 * GET     → public, returns every saved photo as JSON.
 * POST    → owner only, appends one photo. Body: { caption, photoUrl }.
 * DELETE  → owner only, removes one photo by ?id=<_id>.
 *
 * Mirrors /api/swing-videos intentionally: same storage strategy (single
 * JSON blob in the "portfolio" store), same auth convention, same shape
 * of responses. Different file purely for separation of concerns — if
 * one gallery's rules diverge later, we won't tangle them up here.
 *
 * Storage: Netlify Blobs, "portfolio" store, key "photos".
 *
 * Note: actual image bytes live in Supabase Storage (uploaded direct
 * from the browser to bypass the 5 MB Netlify Functions payload cap).
 * This endpoint only stores the photo's public URL + a caption. The
 * URL is validated as http(s) before persisting — see normalizePhoto().
 *
 * Owner auth: pass the plain password in the `X-Owner-Password` header.
 * Hashed with SHA-256 and compared to OWNER_PASSWORD_HASH — identical
 * to /api/swing-videos + /api/auth (DRY at the contract level).
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "photos";
const MAX_URL_LEN     = 500;
const MAX_CAPTION_LEN = 140;

// ⚠️ Hard ceiling on how many photos the gallery can hold at once.
// Mirrored on the client (MAX_PHOTOS in PhotoGallery). Keep BOTH in sync
// or the UX will lie about why the upload failed.
const MAX_PHOTOS = 24;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

async function readAll(store) {
  const data = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

// Cheap http(s)-only URL guard. We're not classifying providers here
// (unlike swing-videos) — any reachable public image works.
function isSafeHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

// Validate + normalize a photo submission.
function normalizePhoto(input) {
  if (!input || typeof input !== "object") return { error: "Invalid body" };
  const caption  = (input.caption  || "").toString().trim();
  const photoUrl = (input.photoUrl || "").toString().trim();

  if (!photoUrl)                    return { error: "Photo URL is required" };
  if (photoUrl.length > MAX_URL_LEN) return { error: "Photo URL is too long" };
  if (!isSafeHttpUrl(photoUrl))      return { error: "Photo URL must be http(s)" };
  if (caption.length > MAX_CAPTION_LEN) {
    return { error: `Caption is too long (max ${MAX_CAPTION_LEN} chars)` };
  }

  return {
    photo: {
      _id:      Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      caption,
      photoUrl,
      addedAt:  new Date().toISOString(),
    },
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Strong consistency = read-after-write guaranteed. Same trade-off
  // as /api/swing-videos — small latency hit, no "where'd my photo go?"
  // moment after upload.
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const url   = new URL(req.url);

  // ---- GET: public read ----
  if (req.method === "GET") {
    const data = await readAll(store);
    return json(200, { photos: data });
  }

  // ---- POST: owner adds a photo ----
  if (req.method === "POST") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const result = normalizePhoto(body);
    if (result.error) return json(400, { error: result.error });

    const current = await readAll(store);
    if (current.length >= MAX_PHOTOS) {
      return json(409, {
        error: `Gallery is full (limit: ${MAX_PHOTOS}). Delete a photo before adding another.`,
      });
    }
    current.unshift(result.photo);
    await store.setJSON(BLOB_KEY, current);
    return json(201, { photo: result.photo });
  }

  // ---- DELETE: owner removes a photo ----
  if (req.method === "DELETE") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "id query param required" });

    const current = await readAll(store);
    const target  = current.find((p) => p._id === id);
    if (!target) return json(404, { error: "Not found" });

    const next = current.filter((p) => p._id !== id);
    await store.setJSON(BLOB_KEY, next);

    // We deliberately do NOT purge the file from Supabase Storage here.
    // Reasons: (a) the same uploaded image could be reused in the main
    // hero photo via the edit form, (b) the bucket is public and cheap,
    // (c) a "deleted" gallery entry could be re-pasted as a URL later.
    // If orphan cleanup becomes a real problem we can add it then (YAGNI).

    return json(200, { ok: true, deletedId: id });
  }

  return json(405, { error: "Method not allowed" });
}
