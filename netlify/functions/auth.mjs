/**
 * /api/auth — verify the owner password.
 *
 * The site treats anyone who can present a password matching the
 * OWNER_PASSWORD_HASH env var as the "owner". We never store the
 * plaintext password — only its SHA-256 hash, set in Netlify's
 * environment variable UI.
 *
 * Method: POST
 * Body:   { password: "<plaintext>" }
 * Reply:  200 { ok: true }   on success
 *         401 { ok: false }  on bad password
 */
import { createHash } from "node:crypto";

// Fallback hash used when OWNER_PASSWORD_HASH env var isn't set.
// Currently corresponds to the plaintext password: "Drip-Golf"
// To rotate: run
//   node -e "console.log(require('crypto').createHash('sha256').update('NEW_PW').digest('hex'))"
// and paste the result below (or, preferably, set OWNER_PASSWORD_HASH in Netlify).
const FALLBACK_PASSWORD_HASH =
  "8a9d062b257283fae7afee95aaac3856f61a986bae1f002bf421b99c39e72cbb";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const password = (body && body.password) || "";
  if (!password) return json(400, { error: "Password required" });

  // Prefer the env var (operationally easier to rotate without a deploy),
  // but fall back to the baked-in hash so the site works out of the box.
  const expected = (process.env.OWNER_PASSWORD_HASH || FALLBACK_PASSWORD_HASH).toLowerCase();

  if (sha256(password) === expected) {
    return json(200, { ok: true });
  }
  return json(401, { ok: false });
}
