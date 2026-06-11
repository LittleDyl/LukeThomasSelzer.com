/**
 * /api/upcoming-tournaments — public list of upcoming tournaments.
 *
 * GET     → public, returns all owner-added upcoming tournaments as JSON.
 * POST    → owner only, appends one. Body: upcoming tournament object.
 * DELETE  → owner only, removes one by ?id=<_id>.
 *
 * This is intentionally separate from /api/tournaments (played tournaments)
 * because the schema differs (no rounds/scores yet, but date+location+
 * registration link). Combining them under one endpoint with a `status`
 * discriminator would violate SRP and complicate every read path for both.
 *
 * Storage = single JSON blob in Netlify Blobs ("portfolio" store, key
 * "upcoming-tournaments"). Same small-dataset reasoning as tournaments.mjs.
 *
 * Owner auth: pass the plain password in the `X-Owner-Password` header.
 * Hashed with SHA-256 and compared to OWNER_PASSWORD_HASH — exact same
 * convention as /api/auth and /api/tournaments.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { migratePastUpcoming } from "./_lib/migrate-upcoming.mjs";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "upcoming-tournaments";

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

// Read the blob (returns [] if it doesn't exist yet — first run).
async function readAll(store) {
  const data = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

// Light URL sanity check — accept http(s) only. Anything else gets
// silently dropped so we never echo back a `javascript:` URL into
// public HTML. The frontend also escapes, but defense-in-depth.
function safeUrl(input) {
  const raw = (input || "").toString().trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : "";
  } catch {
    return "";
  }
}

// Sanitize incoming input to a known shape. Keeps the blob schema
// predictable even if a malicious caller throws junk at us.
function normalizeUpcoming(input) {
  if (!input || typeof input !== "object") return null;
  const name = (input.name || "").toString().trim();
  if (!name) return null;
  return {
    _id:             Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name,
    date:            (input.date            || "").toString().trim(), // ISO yyyy-mm-dd preferred
    location:        (input.location        || "").toString().trim(),
    division:        (input.division        || "").toString().trim(),
    registrationUrl: safeUrl(input.registrationUrl),
    notes:           (input.notes           || "").toString().trim().slice(0, 500),
    addedAt:         new Date().toISOString(),
  };
}

// Sort by date ascending so the soonest is on top. Missing/invalid dates
// drop to the bottom (treated as +Infinity) — they're still visible but
// don't crowd out actually-dated entries.
function sortByDateAsc(list) {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.date || "") || Number.POSITIVE_INFINITY;
    const tb = Date.parse(b.date || "") || Number.POSITIVE_INFINITY;
    return ta - tb;
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const url   = new URL(req.url);

  // ---- GET: public read ----
  // Lazy graduation: any entries whose date has passed get moved to the
  // played-tournaments blob before we read back the still-upcoming list.
  // Idempotent + cheap (zero writes when there's nothing to migrate).
  if (req.method === "GET") {
    await migratePastUpcoming(store);
    const data = await readAll(store);
    return json(200, { upcoming: sortByDateAsc(data) });
  }

  // ---- POST: owner adds an upcoming tournament ----
  if (req.method === "POST") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const tournament = normalizeUpcoming(body);
    if (!tournament) return json(400, { error: "Tournament name is required" });

    const current = await readAll(store);
    current.push(tournament);
    await store.setJSON(BLOB_KEY, current);
    return json(201, { tournament });
  }

  // ---- DELETE: owner removes one ----
  if (req.method === "DELETE") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "id query param required" });

    const current = await readAll(store);
    const next    = current.filter((t) => t._id !== id);
    if (next.length === current.length) return json(404, { error: "Not found" });

    await store.setJSON(BLOB_KEY, next);
    return json(200, { ok: true, deletedId: id });
  }

  return json(405, { error: "Method not allowed" });
}
