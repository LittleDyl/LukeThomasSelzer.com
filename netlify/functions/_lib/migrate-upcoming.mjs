/**
 * Shared helper: "graduate" past upcoming tournaments into the played
 * tournaments blob.
 *
 * Why a shared helper:
 *   Both /api/upcoming-tournaments GET and /api/tournaments GET want to
 *   surface the freshest possible view. Putting the migration in ONE
 *   place keeps the two endpoints honest (no drift in graduation rules)
 *   — classic DRY.
 *
 * Why "lazy" migration (on read) instead of a scheduled function:
 *   YAGNI. Either endpoint is hit on every page load, so the longest a
 *   graduate sits stale is between deploys getting any traffic at all.
 *   No cron, no extra config, no auth surface — just an idempotent
 *   read-side check. Costs at most one extra blob read; only writes
 *   when there's actually something to migrate.
 *
 * Idempotence:
 *   Running this twice in a row with no new graduates is a no-op (one
 *   blob read, zero writes). Safe to call from any number of endpoints.
 */

const UPCOMING_KEY = "upcoming-tournaments";
const PLAYED_KEY   = "tournaments";

// "Past" = strictly before the start of today in UTC. We compare in UTC
// because the blob doesn't carry a tz, and bumping a tournament to
// History one day early (in some TZs) is way better UX than letting it
// linger on the schedule a day late.
function isPast(dateStr) {
  if (!dateStr) return false; // No date = "TBD" = leave on the schedule.
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return false;
  const startOfTodayUTC = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  return ts < startOfTodayUTC;
}

// Convert an ISO yyyy-mm-dd to the legacy M/D/YYYY format used by every
// scraped + manually-added tournament in PORTFOLIO_DATA. Keeps the data
// shape in the played-tournaments blob homogeneous so the History sort
// (and any future M/D/YYYY-assuming consumer) just works.
function isoToUsDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw || "").trim());
  if (!m) return (raw || "").toString();
  const [, y, mo, d] = m;
  return `${parseInt(mo, 10)}/${parseInt(d, 10)}/${y}`;
}

// Convert the "upcoming" schema to the "played" schema. We preserve _id
// (so any client that had it cached doesn't end up with a phantom dupe)
// and stash the original location/notes/link in fields the History
// renderer already ignores gracefully — no scoring data yet, that's the
// owner's job to fill in later.
function toPlayedShape(upcoming) {
  const dateMs = Date.parse(upcoming.date || "");
  const year   = !Number.isNaN(dateMs)
    ? new Date(dateMs).getFullYear().toString()
    : new Date().getFullYear().toString();

  return {
    _id:      upcoming._id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    year,
    // Normalize to M/D/YYYY so the History sort treats graduated entries
    // identically to scraped ones (DRY: one date convention in the blob).
    date:     isoToUsDate(upcoming.date),
    name:     upcoming.name     || "",
    division: upcoming.division || "",
    place:    "",                 // TBD — owner fills in after the round.
    total:    "",
    points:   "",
    rounds:   [],
    addedAt:  upcoming.addedAt || new Date().toISOString(),
    // Breadcrumbs — purely informational, History renderer ignores
    // unknown keys. Makes future debugging painless.
    graduatedFrom:   "upcoming",
    graduatedAt:     new Date().toISOString(),
    location:        upcoming.location        || "",
    notes:           upcoming.notes           || "",
    registrationUrl: upcoming.registrationUrl || "",
  };
}

/**
 * @param {object} store — a Netlify Blobs store handle (strong consistency
 *                         recommended so the migration round-trips cleanly).
 * @returns {Promise<{migrated:number}>}
 */
export async function migratePastUpcoming(store) {
  const upcoming = await store.get(UPCOMING_KEY, { type: "json" });
  if (!Array.isArray(upcoming) || upcoming.length === 0) {
    return { migrated: 0 };
  }

  const stillUpcoming = [];
  const graduates     = [];
  for (const t of upcoming) {
    if (isPast(t.date)) graduates.push(toPlayedShape(t));
    else                stillUpcoming.push(t);
  }
  if (graduates.length === 0) return { migrated: 0 };

  // Prepend so the freshly graduated entries land at the top of History
  // — matches the convention used by the manual POST on /api/tournaments.
  const played     = await store.get(PLAYED_KEY, { type: "json" });
  const playedList = Array.isArray(played) ? played : [];
  const merged     = [...graduates, ...playedList];

  await store.setJSON(PLAYED_KEY,   merged);
  await store.setJSON(UPCOMING_KEY, stillUpcoming);

  return { migrated: graduates.length };
}
