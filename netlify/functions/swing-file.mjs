/**
 * /api/swing-file — public binary read for owner-uploaded swing clips.
 *
 * Counterpart to /api/swing-upload. Given ?id=<blobId>, streams the bytes
 * back with the Content-Type that was captured at upload time, plus
 * aggressive cache headers (the ID is unique-per-upload, so the response
 * is effectively immutable).
 *
 * Public. No auth — anyone with the link should be able to view, exactly
 * like a YouTube/Vimeo embed would behave.
 */
import { getStore } from "@netlify/blobs";

const FILES_STORE = "swing-files";

const ID_PATTERN = /^[a-z0-9]{8,40}$/i;

function err(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }
  if (req.method !== "GET") return err(405, "Method not allowed");

  const id = new URL(req.url).searchParams.get("id");
  // Guard against weird ids — our own ids are short alphanumerics. Anything
  // else is almost certainly probing for traversal/SSRF tricks.
  if (!id || !ID_PATTERN.test(id)) return err(400, "Invalid id");

  const store  = getStore({ name: FILES_STORE });
  const result = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!result || !result.data) return err(404, "Not found");

  const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";

  return new Response(result.data, {
    status: 200,
    headers: {
      "Content-Type":  contentType,
      // ⚠️ iOS Safari REFUSES to play a <video src="..."> when the
      // initial response doesn't advertise Accept-Ranges. Netlify's CDN
      // happily serves 206 Partial Content for Range requests, but it
      // doesn't add Accept-Ranges to non-Range responses on its own —
      // we have to tell the client up-front that seeking is OK, or it
      // gives up and shows the broken-video icon. (Chrome / Firefox /
      // desktop Safari are forgiving; mobile Safari is not.)
      "Accept-Ranges": "bytes",
      // 1 day is a deliberate trade-off: long enough to give the CDN real
      // hit-rate, short enough that owner deletes propagate within a day.
      // We *don't* use `immutable` — that would pin stale copies for the
      // full TTL even after the underlying blob is purged.
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
