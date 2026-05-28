/**
 * /api/tournaments — public tournament storage.
 *
 * GET     → public, returns all user-added tournaments as JSON.
 * POST    → owner only, appends one tournament. Body: tournament object.
 * DELETE  → owner only, removes one tournament by ?id=<_id>.
 *
 * Storage is a single JSON blob in Netlify Blobs ("portfolio" store,
 * key "tournaments"). It's one document because the dataset is small
 * (a junior golfer plays maybe 10-30 tournaments a year). Switch to
 * per-record blobs only if/when that ever becomes a real concern.
 *
 * Owner auth: pass the plain password in the `X-Owner-Password` header.
 * The function hashes it with SHA-256 and compares to the env var
 * OWNER_PASSWORD_HASH. Same algorithm + hash as /api/auth.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "tournaments";

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

// Sanitize incoming tournament input to a known shape. Keeps the blob
// schema predictable even if a malicious caller throws junk at us.
function normalizeTournament(input) {
  if (!input || typeof input !== "object") return null;
  const name = (input.name || "").toString().trim();
  if (!name) return null;
  const safeRounds = Array.isArray(input.rounds) ? input.rounds.map((r) => ({
    round:  (r.round  || "").toString(),
    score:  (r.score  || "").toString(),
    course: (r.course || "").toString(),
  })) : [];
  return {
    _id:      Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    year:     (input.year     || new Date().getFullYear().toString()).toString(),
    date:     (input.date     || "").toString().trim(),
    name,
    division: (input.division || "").toString().trim(),
    place:    (input.place    || "").toString().trim(),
    total:    (input.total    || "").toString().trim(),
    points:   (input.points   || "").toString().trim(),
    rounds:   safeRounds,
    addedAt:  new Date().toISOString(),
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Strong consistency = read-after-write guaranteed (small latency cost,
  // worth it because reload UX should never show stale tournament data).
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const url   = new URL(req.url);

  // ---- GET: public read ----
  if (req.method === "GET") {
    const data = await readAll(store);
    return json(200, { tournaments: data });
  }

  // ---- POST: owner adds a tournament ----
  if (req.method === "POST") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const tournament = normalizeTournament(body);
    if (!tournament) return json(400, { error: "Tournament name is required" });

    const current = await readAll(store);
    current.unshift(tournament);
    await store.setJSON(BLOB_KEY, current);
    return json(201, { tournament });
  }

  // ---- DELETE: owner removes a tournament ----
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
