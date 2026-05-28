/**
 * /api/featured-swing — the single "headline" swing video at the top of the
 * Swing Video tab. Lets the portfolio owner (parent/kid with credentials)
 * swap it without ever editing source code.
 *
 * GET → public. Returns { videoUrl, embedUrl, kind, updatedAt } or null fields
 *        if nothing has been set yet (frontend falls back to the built-in default).
 * PUT → owner only. Body: { videoUrl }. Replaces whatever was there.
 *
 * We deliberately do NOT keep a history — featured = "currently up", one video.
 * If the owner wants the previous one back they can paste it again. YAGNI.
 *
 * Storage: single JSON blob in Netlify Blobs ("portfolio" store, key
 * "featured-swing"). Same auth + CORS conventions as the other endpoints.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { classifyVideoUrl } from "./_lib/url-classify.mjs";

const STORE_NAME = "portfolio";
const BLOB_KEY   = "featured-swing";
const MAX_URL_LEN = 500;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
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

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  // ---- GET: public read ----
  if (req.method === "GET") {
    const data = await store.get(BLOB_KEY, { type: "json" });
    // Null-coalesce so the frontend can always destructure safely.
    return json(200, data || { videoUrl: null, embedUrl: null, kind: null, updatedAt: null });
  }

  // ---- PUT: owner-only update ----
  if (req.method === "PUT") {
    if (!isOwner(req)) return json(401, { error: "Unauthorized" });

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const videoUrl = (body?.videoUrl || "").toString().trim().slice(0, MAX_URL_LEN);
    if (!videoUrl) return json(400, { error: "videoUrl is required" });

    const { kind, embedUrl } = classifyVideoUrl(videoUrl);
    if (!kind) {
      return json(400, {
        error: "Please paste a valid YouTube, Vimeo, or direct .mp4/.webm URL.",
      });
    }

    const next = {
      videoUrl,
      embedUrl,
      kind,
      updatedAt: new Date().toISOString(),
    };
    await store.setJSON(BLOB_KEY, next);
    return json(200, next);
  }

  return json(405, { error: "Method not allowed" });
}
