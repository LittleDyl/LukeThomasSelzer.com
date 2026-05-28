/**
 * /api/swing-videos — owner-curated gallery of additional swing videos.
 *
 * GET     → public, returns every saved video as JSON.
 * POST    → owner only, appends one video. Body: { title, videoUrl }.
 * DELETE  → owner only, removes one video by ?id=<_id>.
 *
 * Storage: single JSON blob in Netlify Blobs ("portfolio" store,
 * key "swing-videos"). Same shape/strategy as /api/tournaments — if the
 * gallery ever outgrows a single blob we can shard per-record then, not
 * before (YAGNI).
 *
 * Owner auth: pass the plain password in the `X-Owner-Password` header.
 * Hashed with SHA-256 and compared to OWNER_PASSWORD_HASH — identical
 * to /api/tournaments + /api/auth (DRY at the contract level).
 *
 * URL validation is delegated to `_lib/url-classify.mjs` so the rules
 * stay in one place and stay consistent with /api/featured-swing.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { classifyVideoUrl } from "./_lib/url-classify.mjs";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "swing-videos";
const FILES_STORE = "swing-files"; // sibling store for owner-uploaded binaries

// ⚠️ Hard ceiling on how many videos the gallery can hold at once.
// Mirrored on the client (MAX_VIDEOS in SwingVideos). Keep BOTH in sync
// or the UX will lie about why the upload failed.
const MAX_VIDEOS = 2;

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

// Validate + normalize a video submission. Rejects unsupported URLs at the
// source so we never persist garbage that the frontend can't render.
function normalizeVideo(input) {
  if (!input || typeof input !== "object") return { error: "Invalid body" };
  const title    = (input.title    || "").toString().trim();
  const videoUrl = (input.videoUrl || "").toString().trim();
  if (!title)    return { error: "Title is required" };
  if (!videoUrl) return { error: "Video URL is required" };
  if (title.length > 100) return { error: "Title is too long (max 100 chars)" };

  const { kind, embedUrl } = classifyVideoUrl(videoUrl);
  if (!kind) {
    return { error: "Unsupported video URL — use YouTube, Vimeo, or a direct .mp4/.webm link." };
  }

  return {
    video: {
      _id:      Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title,
      videoUrl,
      embedUrl,
      kind,
      addedAt:  new Date().toISOString(),
    },
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Strong consistency = read-after-write guaranteed. Worth the small
  // latency cost so the owner never sees their freshly-added clip vanish
  // on the next render.
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const url   = new URL(req.url);

  // ---- GET: public read ----
  if (req.method === "GET") {
    const data = await readAll(store);
    return json(200, { videos: data });
  }

  // ---- POST: owner adds a video ----
  if (req.method === "POST") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const result = normalizeVideo(body);
    if (result.error) return json(400, { error: result.error });

    const current = await readAll(store);
    // Hard cap. Frontend already hides the form at the limit, but the
    // server is the real gatekeeper — a curl POST gets the same 409.
    if (current.length >= MAX_VIDEOS) {
      return json(409, {
        error: `Gallery is full (limit: ${MAX_VIDEOS}). Delete a video before adding another.`,
      });
    }
    current.unshift(result.video);
    await store.setJSON(BLOB_KEY, current);
    return json(201, { video: result.video });
  }

  // ---- DELETE: owner removes a video ----
  if (req.method === "DELETE") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "id query param required" });

    const current = await readAll(store);
    const target  = current.find((v) => v._id === id);
    if (!target) return json(404, { error: "Not found" });

    const next = current.filter((v) => v._id !== id);
    await store.setJSON(BLOB_KEY, next);

    // If this record pointed at a self-hosted upload, purge the binary too
    // so we don't accumulate orphaned blobs. Best-effort: a failure here
    // shouldn't roll back the record deletion the user just confirmed.
    if (target.hostedFileId) {
      try {
        const files = getStore({ name: FILES_STORE, consistency: "strong" });
        await files.delete(target.hostedFileId);
      } catch (err) {
        console.warn("swing-videos: failed to purge hosted file", target.hostedFileId, err);
      }
    }

    return json(200, { ok: true, deletedId: id });
  }

  return json(405, { error: "Method not allowed" });
}
