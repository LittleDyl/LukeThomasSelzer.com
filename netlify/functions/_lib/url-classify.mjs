/**
 * Shared video-URL classifier.
 *
 * Lives under `_lib/` so Netlify doesn't deploy it as its own function —
 * it's a helper module, not an HTTP handler. Both /api/featured-swing and
 * /api/swing-videos import this so the parsing rules stay in exactly
 * one place (DRY). If we ever support a new provider, we change it here.
 *
 * Returns { kind, embedUrl } where kind is "youtube" | "vimeo" | "file" | null.
 * `kind: null` means "we don't know how to embed this — reject it."
 */
export function classifyVideoUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return { kind: null, embedUrl: null }; }

  // Only http(s). No javascript:, data:, file:, etc. — XSS guardrail.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: null, embedUrl: null };
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  // ---- YouTube ----
  // Handles: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID,
  // youtube.com/shorts/ID. Bails on anything weirder.
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    let id = "";
    if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
    else if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] || "";
    else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] || "";
    if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      return { kind: "youtube", embedUrl: `https://www.youtube.com/embed/${id}` };
    }
  }
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").split("/")[0];
    if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      return { kind: "youtube", embedUrl: `https://www.youtube.com/embed/${id}` };
    }
  }

  // ---- Vimeo ----
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments.find((s) => /^\d+$/.test(s));
    if (id) {
      return { kind: "vimeo", embedUrl: `https://player.vimeo.com/video/${id}` };
    }
  }

  // ---- Direct video file (mp4 / webm / mov) ----
  // .mov matches video/quicktime (raw iPhone clips); kept in lockstep with
  // SERVER_ALLOWED_TYPES on the client. Browsers play .mov natively when
  // the underlying codec is H.264, which is what iOS produces by default.
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url.pathname)) {
    return { kind: "file", embedUrl: url.toString() };
  }

  return { kind: null, embedUrl: null };
}
