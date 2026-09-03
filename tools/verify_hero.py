"""Visual + DOM smoke check for the redesigned hero.

Not a test suite -- a dev feedback loop. Loads the demo, dismisses the
owner gate as a visitor, then reports on the pieces the redesign added
and dumps screenshots at desktop + mobile widths.

    python tools/verify_hero.py
"""

import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:8765/ltselzer-portfolio.html"
SHOTS = pathlib.Path(__file__).resolve().parent.parent / "shots"

# selector -> how many nodes we expect at minimum. One table drives both
# the assertions and the report, so adding a check is a one-line change.
EXPECTED = {
    ".hero-identity": 1,
    ".hero-avatar": 1,
    "#player-meta span": 2,
    ".hero .stat": 5,
    "#hero-chart path.hc-line": 1,
    "#hero-chart g.hc-pt-g": 2,
    "#hero-chart linearGradient#hc-fill": 1,
    "#hero-form": 1,
    "#hero-form-rows li": 1,
}


def dismiss_gate(page):
    """The page opens on a visitor/owner chooser; take the visitor door."""
    btn = page.locator('.gate-role-btn[data-role="visitor"]')
    if btn.count():
        btn.first.click()
        page.wait_for_timeout(600)


def main():
    SHOTS.mkdir(exist_ok=True)
    console = []
    failures = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))
        # /api/* is served by Netlify Functions, which a plain static
        # server obviously doesn't have. The app degrades gracefully, so
        # those 404s are environmental noise -- anything else is a defect.
        bad_404 = []
        page.on("response", lambda r: r.status == 404
                and "/api/" not in r.url and bad_404.append(r.url))

        page.goto(URL, wait_until="networkidle")
        dismiss_gate(page)
        page.wait_for_timeout(2200)  # let count-ups + chart draw-in settle

        print("=== DOM ===")
        for sel, want in EXPECTED.items():
            got = page.locator(sel).count()
            ok = got >= want
            if not ok:
                failures.append(f"{sel}: expected >={want}, got {got}")
            print(f"  {'PASS' if ok else 'FAIL'}  {sel:<38} {got} (want >={want})")

        # Layout sanity: is the identity row actually horizontal?
        geom = page.evaluate("""() => {
          const img = document.querySelector('.hero .player-photo');
          const txt = document.querySelector('.hero-identity-text');
          const hero = document.querySelector('.hero');
          if (!img || !txt) return null;
          const a = img.getBoundingClientRect(), b = txt.getBoundingClientRect();
          return {
            sideBySide: b.left >= a.right - 4,
            heroHeight: Math.round(hero.getBoundingClientRect().height),
            overflowX: document.documentElement.scrollWidth >
                       document.documentElement.clientWidth,
            statNums: [...document.querySelectorAll('.stat-num')]
                        .map(n => n.textContent.trim()),
            // Contrast probes: a "transparent" background means the
            // panel skin silently lost the cascade again.
            paint: Object.fromEntries(
              ['.hero .stat', '.hero-analytics', '.hero-analytics-tiles li']
                .map(s => {
                  const n = document.querySelector(s);
                  const c = n && getComputedStyle(n);
                  return [s, n ? c.backgroundColor + ' | ' + c.borderTopColor : 'MISSING'];
                })),
            trendColor: (() => {
              const n = document.querySelector('.tile-value.trend-down, .tile-value.trend-up');
              return n ? n.className + ' -> ' + getComputedStyle(n).color : 'none';
            })(),
            formRows: [...document.querySelectorAll('#hero-form-rows li')]
                        .map(n => n.innerText.replace(/\\s+/g, ' ').trim()),
          };
        }""")
        print("\n=== LAYOUT ===")
        print(json.dumps(geom, indent=2))
        if geom and not geom["sideBySide"]:
            failures.append("identity row is not side-by-side at 1440px")
        if geom and geom["overflowX"]:
            failures.append("horizontal overflow at 1440px")

        # full_page is required: clip alone won't capture below the fold.
        page.screenshot(path=str(SHOTS / "hero-desktop.png"), full_page=True,
                        clip={"x": 0, "y": 0, "width": 1440,
                              "height": geom["heroHeight"] + 80})

        # Chart hover -> tooltip
        page.hover(".hero-chart-wrap")
        page.mouse.move(700, 0)  # nudge so pointermove fires inside the wrap
        box = page.locator(".hero-chart-wrap").bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.6,
                        box["y"] + box["height"] * 0.5)
        page.wait_for_timeout(400)
        tip = page.locator(".hc-tip")
        tip_visible = tip.count() > 0 and tip.first.is_visible()
        print(f"\n=== TOOLTIP === visible={tip_visible} "
              f"text={tip.first.inner_text() if tip_visible else '-'}")
        if not tip_visible:
            failures.append("chart hover tooltip did not appear")
        page.screenshot(path=str(SHOTS / "hero-tooltip.png"),
                        clip={"x": 0, "y": 0, "width": 1440, "height": 1000})

        # Mobile
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(800)
        m = page.evaluate("""() => ({
          overflowX: document.documentElement.scrollWidth >
                     document.documentElement.clientWidth,
          scrollW: document.documentElement.scrollWidth,
          heroHeight: Math.round(
            document.querySelector('.hero').getBoundingClientRect().height),
        })""")
        print("\n=== MOBILE ===")
        print(json.dumps(m, indent=2))
        if m["overflowX"]:
            failures.append(f"horizontal overflow at 390px (scrollW={m['scrollW']})")
        page.screenshot(path=str(SHOTS / "hero-mobile.png"),
                        clip={"x": 0, "y": 0, "width": 390,
                              "height": min(m["heroHeight"] + 40, 1600)})

        browser.close()

    print("\n=== CONSOLE ===")
    noise = [c for c in console
             if "favicon" not in c.lower()
             and "Failed to load resource" not in c]
    print("\n".join(noise) if noise else "  (only expected /api/ fallbacks)")
    errors = [c for c in noise if c.startswith(("[error]", "[pageerror]"))]
    errors += ["unexpected 404: " + u for u in bad_404]

    print("\n=== RESULT ===")
    for f in failures + errors:
        print("  FAIL:", f)
    if not failures and not errors:
        print("  All checks passed. Screenshots in", SHOTS)
    return 1 if (failures or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
