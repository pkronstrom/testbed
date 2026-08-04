/**
 * The flat viewport (spec §15). Two modes, because they answer different
 * questions:
 *
 *   hull    plan and profile orthographics — the drawing you judge a SHAPE by
 *           while dragging sliders. Designed curve against the faceted chain,
 *           so the cost of the segment budget is visible.
 *   panels  the developed cut patterns — the drawing you judge a BUILD by.
 *
 * The spec's "flat" view means the second. The first is here because sliding a
 * rocker slider and watching a 3D boat rotate tells you much less than
 * watching a profile change.
 *
 * Panels mode hover-links to the 3D view both ways (§15: "this single feature
 * does more for comprehension than any amount of labelling").
 *
 * Geometry comes from the same `panels` output the exporter uses, so the
 * viewer and the blueprint cannot disagree. The LAYOUT differs on purpose: the
 * export is a cut layout on the roll, this is a reading layout.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const f2 = (v) => (Math.abs(v) < 1e-3 ? '0' : v.toFixed(2));
  const pathData = (pts, close) =>
    'M ' + pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join(' L ') + (close ? ' Z' : '');

  function create(container) {
    const svg = el('svg', { class: 'v2d' });
    const root2 = el('g', {});
    svg.appendChild(root2);
    container.appendChild(svg);

    let mode = 'hull';
    let design = null;
    let view = { x: 0, y: 0, k: 1 };
    let content = { w: 1, h: 1 };
    let hoverHandler = null;
    const groups = new Map();

    function applyView() {
      root2.setAttribute('transform', `translate(${f2(view.x)} ${f2(view.y)}) scale(${view.k})`);
    }

    function fit() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      const pad = 40;
      const k = Math.min((w - pad * 2) / content.w, (h - pad * 2) / content.h);
      view.k = isFinite(k) && k > 0 ? k : 1;
      view.x = (w - content.w * view.k) / 2;
      view.y = (h - content.h * view.k) / 2;
      applyView();
    }

    // ---- interaction: wheel zoom about the cursor, drag to pan ------------
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const s = Math.exp(-e.deltaY * 0.0015);
      view.x = cx - (cx - view.x) * s;
      view.y = cy - (cy - view.y) * s;
      view.k *= s;
      applyView();
    }, { passive: false });

    let dragging = null;
    svg.addEventListener('pointerdown', (e) => {
      dragging = { x: e.clientX - view.x, y: e.clientY - view.y };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      view.x = e.clientX - dragging.x;
      view.y = e.clientY - dragging.y;
      applyView();
    });
    svg.addEventListener('pointerup', (e) => {
      dragging = null;
      svg.releasePointerCapture(e.pointerId);
    });

    function clear() {
      while (root2.firstChild) root2.removeChild(root2.firstChild);
      groups.clear();
    }

    // ---- hull orthographics ----------------------------------------------
    function drawHull() {
      const sk = design.skeleton;
      const hc = sk.hullCurves;
      const loa = design.params.primary.loa;
      const halfBeam = design.params.primary.beam / 2;

      const cx = (x) => loa / 2 - x;                 // bow to the left
      const planTop = 0;
      const py = (yv) => planTop + halfBeam - yv;

      const design4 = [], outer = [], inner = [];
      for (let i = 0; i <= 300; i++) {
        const t = i / 300;
        const q = hc.pointAt(t), r = hc.rAt(t);
        design4.push([cx(q[0]), py(q[1])]);
        outer.push([cx(q[0]), py(q[1] + r)]);
        inner.push([cx(q[0]), py(q[1] - r)]);
      }
      const mirror = (pts) => pts.map(([a, b]) => [a, 2 * py(0) - b]);

      root2.appendChild(el('line', { class: 'v-axis', x1: 0, y1: py(0), x2: loa, y2: py(0) }));
      for (const pts of [outer, inner, mirror(outer), mirror(inner)]) {
        root2.appendChild(el('path', { class: 'v-tube', d: pathData(pts) }));
      }
      root2.appendChild(el('path', { class: 'v-design', d: pathData(design4) }));
      root2.appendChild(el('path', { class: 'v-design', d: pathData(mirror(design4)) }));

      const chain = sk.nodes.map((nd) => [cx(nd.p[0]), py(nd.p[1])]);
      root2.appendChild(el('path', { class: 'v-facet', d: pathData(chain, true) }));
      for (const nd of sk.nodes) {
        root2.appendChild(el('circle', { class: 'v-node', cx: cx(nd.p[0]), cy: py(nd.p[1]), r: 6 }));
      }
      root2.appendChild(label(4, py(0) - halfBeam - 14, 'PLAN — designed curve in blue, faceted chain in red'));

      // profile
      let zLo = Infinity, zHi = -Infinity;
      for (let i = 0; i <= 300; i++) {
        const t = i / 300;
        zLo = Math.min(zLo, hc.keel.at(t));
        zHi = Math.max(zHi, hc.sheer.at(t));
      }
      const profTop = planTop + 2 * halfBeam + 120;
      const pz = (z) => profTop + (zHi - z);

      const keel = [], sheer = [], centre = [];
      for (let i = 0; i <= 300; i++) {
        const t = i / 300;
        const x = cx(hc.pointAt(t)[0]);
        keel.push([x, pz(hc.keel.at(t))]);
        sheer.push([x, pz(hc.sheer.at(t))]);
        centre.push([x, pz(hc.zAt(t))]);
      }
      root2.appendChild(el('line', { class: 'v-axis', x1: 0, y1: pz(0), x2: loa, y2: pz(0) }));
      root2.appendChild(el('path', { class: 'v-tube', d: pathData(keel) }));
      root2.appendChild(el('path', { class: 'v-tube', d: pathData(sheer) }));
      root2.appendChild(el('path', { class: 'v-design', d: pathData(centre) }));
      const prof = sk.nodes.filter((nd) => nd.p[1] >= 0).map((nd) => [cx(nd.p[0]), pz(nd.p[2])]);
      root2.appendChild(el('path', { class: 'v-facet', d: pathData(prof) }));
      for (const nd of sk.nodes) {
        if (nd.p[1] < 0) continue;
        root2.appendChild(el('circle', { class: 'v-node', cx: cx(nd.p[0]), cy: pz(nd.p[2]), r: 6 }));
        root2.appendChild(el('circle', { class: 'v-sphere', cx: cx(nd.p[0]), cy: pz(nd.p[2]), r: nd.rho }));
      }
      root2.appendChild(label(4, pz(zHi) - 14, 'PROFILE — keel and sheer; circles are the joint spheres'));
      root2.appendChild(label(4, pz(0) + 20, 'baseline (midship keel datum)'));

      content = { w: loa, h: profTop + (zHi - zLo) + 40 };
    }

    const label = (x, y, text) => {
      const t = el('text', { class: 'v-label', x, y });
      t.textContent = text;
      return t;
    };

    // ---- flat panels ------------------------------------------------------
    function drawPanels() {
      const built = design.built;
      if (!built) {
        content = { w: 800, h: 200 };
        root2.appendChild(label(0, 40, 'Computing panels…'));
        return;
      }

      const B = P.nest.bounds;
      const gap = 90;
      let x = 0, rowH = 0, y = 0, maxW = 0;
      const perRow = 5;
      let i = 0;

      const place = (id, outline, extras, sub) => {
        const b = B(outline);
        const g = el('g', { class: 'v-panel', 'data-id': id });
        const ox = x - b.x0, oy = y - b.y0;
        const m = (p) => [p[0] + ox, p[1] + oy];
        g.appendChild(el('path', { class: 'v-cut', d: pathData(outline.map(m), true) }));
        if (extras) extras(g, m, b);
        const t = el('text', { class: 'v-id', x: x + b.w / 2, y: y + b.h / 2, 'text-anchor': 'middle' });
        t.textContent = id;
        g.appendChild(t);
        if (sub) {
          const s = el('text', { class: 'v-sub', x: x + b.w / 2, y: y + b.h / 2 + 26, 'text-anchor': 'middle' });
          s.textContent = sub;
          g.appendChild(s);
        }
        g.addEventListener('pointerenter', () => setHover(id));
        g.addEventListener('pointerleave', () => setHover(null));
        root2.appendChild(g);
        groups.set(id, g);

        x += b.w + gap;
        rowH = Math.max(rowH, b.h);
        maxW = Math.max(maxW, x);
        if (++i % perRow === 0) { x = 0; y += rowH + gap; rowH = 0; }
      };

      for (const panel of built.tube) {
        place(panel.id, panel.outline, (g, m) => {
          for (const r of panel.rulings) {
            g.appendChild(el('path', { class: 'v-ruling', d: pathData([m(r[0]), m(r[1])]) }));
          }
          g.appendChild(el('path', { class: 'v-seam', d: pathData(panel.seamCurve.map(m)) }));
        }, `${Math.round(P.nest.bounds(panel.outline).w)} × ${Math.round(P.nest.bounds(panel.outline).h)} mm`);
      }

      const fp = P.nest.floorPart(built.floor);
      place('FLOOR', fp.outline, (g, m) => {
        g.appendChild(el('path', { class: 'v-zone', d: pathData(built.floor.outline.map(m), true) }));
        for (const z of built.floor.zones) {
          const a = m(z.from);
          g.appendChild(el('circle', { class: 'v-reg', cx: a[0], cy: a[1], r: 9 }));
        }
      }, `incl. ${Math.round(built.floor.tabWidth)} mm developed tab`);

      content = { w: Math.max(maxW, 800), h: y + rowH + 60 };
    }

    function setHover(id) {
      for (const [key, g] of groups) g.classList.toggle('hot', key === id);
      if (hoverHandler) hoverHandler(id);
    }

    function draw() {
      clear();
      if (!design || !design.skeleton) return;
      if (mode === 'hull') drawHull(); else drawPanels();
      fit();
    }

    window.addEventListener('resize', fit);

    return {
      setDesign(d) { design = d; draw(); },
      setMode(m) { if (m === mode) return; mode = m; draw(); },
      getMode: () => mode,
      onHover(fn) { hoverHandler = fn; },
      /** Highlight from outside (the 3D view picked a panel). */
      highlight(id) {
        for (const [key, g] of groups) g.classList.toggle('hot', key === id);
      },
      resize: fit,
    };
  }

  P.view2d = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
