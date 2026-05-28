/**
 * /api/swing-upload — owner-only direct file upload for swing videos.
 *
 * For users who don't have a YouTube channel (or just don't want to deal
 * with one). Accepts a multipart/form-data POST with fields:
 *   - file:  the .mp4 / .webm bytes (required)
 *   - title: the video title         (required)
 *
 * Pipeline:
 *   1. auth check (X-Owner-Password, same convention as /api/swing-videos)
 *   2. validate content type + size
 *   3. write bytes into the "swing-files" blob store (metadata = contentType)
 *   4. append a new record to the "swing-videos" blob in the "portfolio" store
 *      (same shape as JSON-based POST /api/swing-videos, with `hostedFileId`
 *      so DELETE can clean up the binary later)
 *   5. return { video } — identical shape to POST /api/swing-videos so the
 *      frontend can treat both paths uniformly.
 *
 * ⚠️ Hard size cap = 5 MB (Lambda payload limit is 6 MB; we leave headroom
 *    for multipart overhead). For longer videos, paste a YouTube/Vimeo link
 *    via the regular /api/swing-videos POST.
 */
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const PORTFOLIO_STORE = "portfolio";
const FILES_STORE     = "swing-files";
const VIDEOS_KEY      = "swing-videos";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
// iPhones record .mov (video/quicktime). iOS Safari plays .mov back
// natively, so storing the original bytes works perfectly — no need to
// re-encode. Adding it to the whitelist lets iPhone users drop their
// raw clip straight in without any client-side compression dance.
const ALLOWED_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });
  if (!isOwner(req))            return json(401, { error: "Unauthorized" });

  // Parse multipart. req.formData() is a Web Standards method on Request —
  // throws if the body isn't multipart, which we catch as a 400.
  let form;
  try { form = await req.formData(); }
  catch { return json(400, { error: "Expected multipart/form-data body" }); }

  const file  = form.get("file");
  const title = (form.get("title") || "").toString().trim();

  if (!title) return json(400, { error: "Title is required" });
  if (title.length > 100) return json(400, { error: "Title is too long (max 100 chars)" });
  if (!file || typeof file === "string") return json(400, { error: "File is required" });

  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return json(400, { error: "Only .mp4 and .webm uploads are supported." });
  }
  if (file.size > MAX_BYTES) {
    return json(413, {
      error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
             `Limit is ${MAX_BYTES / 1024 / 1024} MB — please trim or compress, ` +
             `or paste a YouTube/Vimeo link instead.`,
    });
  }

  const bytes  = await file.arrayBuffer();
  const fileId = newId();

  // ---- 1) write the binary ----
  const files = getStore({ name: FILES_STORE, consistency: "strong" });
  await files.set(fileId, bytes, { metadata: { contentType } });

  // ---- 2) append the record to the public videos list ----
  // We deliberately do the same read-modify-write dance as swing-videos.mjs
  // here. Extracting a shared helper would be ~5 lines of "savings" and add
  // an import dependency — not worth it (YAGNI).
  const video = {
    _id:           newId(),
    title,
    kind:          "file",
    videoUrl:      `/api/swing-file?id=${fileId}`,
    embedUrl:      `/api/swing-file?id=${fileId}`,
    hostedFileId:  fileId,  // marker so DELETE can purge the binary
    addedAt:       new Date().toISOString(),
  };

  const portfolio = getStore({ name: PORTFOLIO_STORE, consistency: "strong" });
  const current   = await portfolio.get(VIDEOS_KEY, { type: "json" });
  const list      = Array.isArray(current) ? current : [];
  list.unshift(video);
  await portfolio.setJSON(VIDEOS_KEY, list);

  return json(201, { video });
}
