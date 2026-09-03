/* ======================================================================
   hero-pop.js — motion + interaction layer for the hero.

   Deliberately DECOUPLED from the main portfolio script: it never calls
   into renderHero() and renderHero() never calls into it. It observes
   the DOM and reacts. That means owner edits, theme swaps, tournament
   adds and any future re-render all get the treatment for free, with
   zero extra wiring.

   Three tiny modules, one job each:
     Reveal   — staggered entrance for [data-reveal] nodes
     CountUp  — odometer roll on hero stat numbers
     ChartTip — hover readout for the Last-5 chart
   ====================================================================== */
(function () {
  "use strict";

  var REDUCED = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* -------------------------------------------------------------- */
  /* Shared easing. One curve, used by every animation in this file. */
  /* -------------------------------------------------------------- */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /* Generic rAF tween. Returns nothing; `onTick(progress)` does the work.
     Extracted so CountUp (and anything added later) doesn't re-implement
     the same six lines of requestAnimationFrame bookkeeping. */
  function tween(durationMs, onTick, onDone) {
    if (REDUCED) { onTick(1); if (onDone) onDone(); return; }
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var p = Math.min((now - start) / durationMs, 1);
      onTick(easeOutCubic(p));
      if (p < 1) requestAnimationFrame(frame);
      else if (onDone) onDone();
    }
    requestAnimationFrame(frame);
  }

  /* ================================================================
     Reveal — assigns a stagger index, then flips the hero to .is-in.
     The delays themselves live in CSS (calc(var(--reveal-i) * 80ms)),
     so adding a sixth stat card needs no JS change at all.
     ================================================================ */
  var Reveal = {
    init: function (hero) {
      this.index(hero);
      // Next frame, not now: guarantees the browser has painted the
      // pre-animation state so the transition actually runs.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { hero.classList.add("is-in"); });
      });
      // Re-index when the hero's children change (owner adds a stat, a
      // re-render replaces the analytics panel, etc).
      var self = this;
      new MutationObserver(function () { self.index(hero); })
        .observe(hero, { childList: true, subtree: true });
    },
    index: function (hero) {
      var nodes = hero.querySelectorAll("[data-reveal]");
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].style.setProperty("--reveal-i", i);
      }
    }
  };

  /* ================================================================
     CountUp — rolls hero stat numbers up to their final value.

     Watches .quick-stats for text changes instead of being called by
     the renderer. To avoid reacting to its own writes we remember the
     exact string we last wrote and ignore mutations that match it.
     ================================================================ */
  var NUMERIC = /^(\D*?)(-?\d+(?:\.\d+)?)(\D*)$/;

  var CountUp = {
    DURATION: 900,

    init: function (root) {
      var self = this;
      var run = function () { self.scan(root); };
      new MutationObserver(run).observe(root, {
        childList: true, subtree: true, characterData: true
      });
      run();
    },

    scan: function (root) {
      var nodes = root.querySelectorAll(".stat-num");
      for (var i = 0; i < nodes.length; i++) this.maybeAnimate(nodes[i]);
    },

    maybeAnimate: function (el) {
      var text = el.textContent.trim();
      if (text === el._fxLastWrite) return;   // our own write — ignore
      if (text === el._fxTarget) return;      // already settled here
      el._fxTarget = text;

      var parts = NUMERIC.exec(text);
      if (!parts) return;                     // "—", "N/A": nothing to roll

      var prefix = parts[1];
      var target = parseFloat(parts[2]);
      var suffix = parts[3];
      var decimals = (parts[2].split(".")[1] || "").length;
      var self = this;

      tween(this.DURATION, function (p) {
        self.write(el, prefix + (target * p).toFixed(decimals) + suffix);
      }, function () {
        self.write(el, text);                 // land exactly on the source string
      });
    },

    write: function (el, str) {
      el._fxLastWrite = str;
      el.textContent = str;
    }
  };

  /* ================================================================
     ChartTip — hover readout over the Last-5 chart.

     Reads its data straight off the <g class="hc-pt-g"> nodes that
     drawHeroChart() emits (data-label / data-value / data-vx / data-vy).
     The SVG is the single source of truth; this module owns no copy.
     ================================================================ */
  var ChartTip = {
    VB_W: 600, VB_H: 200,   // must match the SVG's viewBox

    init: function (wrap, svg) {
      var tip = document.createElement("div");
      tip.className = "hc-tip";
      tip.hidden = true;
      wrap.appendChild(tip);

      var self = this;
      wrap.addEventListener("pointermove", function (e) { self.update(e, wrap, svg, tip); });
      wrap.addEventListener("pointerleave", function () { self.hide(svg, tip); });
    },

    update: function (e, wrap, svg, tip) {
      var groups = svg.querySelectorAll(".hc-pt-g");
      if (!groups.length) { tip.hidden = true; return; }

      var box = svg.getBoundingClientRect();
      var scaleX = box.width / this.VB_W;
      var scaleY = box.height / this.VB_H;
      var mouseX = e.clientX - box.left;

      // Nearest point on the x-axis wins — matches how every real
      // leaderboard chart behaves.
      var best = null, bestDist = Infinity;
      for (var i = 0; i < groups.length; i++) {
        var px = parseFloat(groups[i].dataset.vx) * scaleX;
        var d = Math.abs(px - mouseX);
        if (d < bestDist) { bestDist = d; best = groups[i]; }
      }
      if (!best) return;

      for (var j = 0; j < groups.length; j++) {
        groups[j].classList.toggle("is-active", groups[j] === best);
      }

      tip.hidden = false;
      tip.innerHTML =
        '<span class="hc-tip-label"></span><span class="hc-tip-value"></span>';
      tip.querySelector(".hc-tip-label").textContent = best.dataset.label;
      tip.querySelector(".hc-tip-value").textContent = best.dataset.value;

      // Clamp inside the wrapper so the tooltip never escapes the card.
      var wrapBox = wrap.getBoundingClientRect();
      var left = (box.left - wrapBox.left) + parseFloat(best.dataset.vx) * scaleX;
      var top = (box.top - wrapBox.top) + parseFloat(best.dataset.vy) * scaleY;
      var half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half + 4,
        Math.min(left, wrapBox.width - half - 4)) + "px";
      tip.style.top = Math.max(4, top - tip.offsetHeight - 14) + "px";
    },

    hide: function (svg, tip) {
      tip.hidden = true;
      var groups = svg.querySelectorAll(".hc-pt-g.is-active");
      for (var i = 0; i < groups.length; i++) groups[i].classList.remove("is-active");
    }
  };

  /* ---------------------------------------------------------------- */
  function boot() {
    var hero = document.querySelector(".hero");
    if (!hero) return;

    Reveal.init(hero);

    var stats = hero.querySelector(".quick-stats");
    if (stats) CountUp.init(stats);

    var wrap = hero.querySelector(".hero-chart-wrap");
    var svg = document.getElementById("hero-chart");
    if (wrap && svg) ChartTip.init(wrap, svg);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
