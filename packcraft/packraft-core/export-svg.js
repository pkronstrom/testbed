/**
 * SVG blueprint export (spec §8.3, §8.6). 1 mm = 1 SVG unit, so the file is
 * measurable on screen and prints 1:1 from a browser.
 *
 * This is the Phase 2 deliverable. Tiling, calibration squares and the
 * hand-rolled PDF writer are Phase 4; what matters here is that every panel is
 * present, labelled, and carries the annotations that decide whether a build
 * succeeds rather than merely looks right:
 *
 *   - Fore/aft arrow on EVERY panel. Panels are not symmetric front-to-back
 *     and the tutorial flags mis-orientation as an easy error (§8.3).
 *   - Mated edge labels, e / e-prime, so every seam edge names its partner.
 *   - Ruling lines: cone generators, a match-mark system intrinsic to the
 *     geometry rather than bolted on (§8.6).
 *   - Segment-keyed registration zones on the floor, with a mark at every
 *     zone boundary (§7.4d). Structural, not a convenience.
 *   - High-risk corner markers where two tube sections meet the floor -- the
 *     one verified failure point (§7.4c).
 *   - The cut-or-keep instruction, which flips with coating orientation.
 *   - A self-verification block: per-panel edge lengths and mated-pair
 *     lengths, so a traced outline can be checked with a tape BEFORE cutting.
 *   - The fabric-folding note: fold coated face to coated face and one cut
 *     yields a matched L/R pair (§8.6).
 *
 * Deliberately NOT here: seam allowance. Butt seams carry zero (§7.4), so the
 * panel outline IS the net structural geometry and cut line and net line are
 * the same line.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./nest.js');
    require('./panels.js');
  }
  const P = root.Packraft || (root.Packraft = {});

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Fixed precision everywhere: the output must be byte-stable across runs
  // (gate G2.5), and floating noise in the 12th decimal would break that.
  const n2 = (v) => (Math.abs(v) < 5e-3 ? '0' : v.toFixed(2));
  const pathOf = (pts) => 'M ' + pts.map((p) => `${n2(p[0])} ${n2(p[1])}`).join(' L ') + ' Z';

  const STYLE = `
  text { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; fill: #111; }
  .cut { fill: #fbfaf7; stroke: #111; stroke-width: 1; }
  .roll { fill: #ffffff; stroke: #b9b0a0; stroke-width: 2; stroke-dasharray: 20 10; }
  .floor-cut { fill: #f4f1ea; stroke: #111; stroke-width: 1; }
  .tab { fill: none; stroke: #111; stroke-width: 0.6; stroke-dasharray: 8 4; }
  .ruling { fill: none; stroke: #cfc6b4; stroke-width: 0.3; }
  .seam { fill: none; stroke: #2b7bb9; stroke-width: 1; }
  .zone { fill: none; stroke: #2b7bb9; stroke-width: 1.2; }
  .reg { fill: none; stroke: #2b7bb9; stroke-width: 1.2; }
  .risk { fill: none; stroke: #c0392b; stroke-width: 1.6; }
  .arrow { fill: none; stroke: #111; stroke-width: 1.4; }
  /* Sizes are in CONTENT units, and the content unit is a millimetre. So
     these are physical text heights on the printed pattern, not screen px:
     a panel ID is 24 mm tall so it is findable across a taped-up floor, and
     body text is 5 mm so it is readable but does not swamp a tile. */
  .id { font-size: 24px; font-weight: 600; }
  .sub { font-size: 6px; fill: #555; }
  .lab { font-size: 6px; fill: #2b7bb9; }
  .risklab { font-size: 5px; fill: #c0392b; }
  .pair { font-size: 6px; fill: #b8791f; font-weight: 600; }
  .h1 { font-size: 14px; font-weight: 600; }
  .h2 { font-size: 7px; font-weight: 600; }
  .body { font-size: 5px; }
  .mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 4.5px; }
`;

  /** Fore/aft arrow, drawn along the panel's long axis (§8.3). */
  function foreArrow(x, y, len) {
    const h = 7;
    return [
      `<path class="arrow" d="M ${n2(x)} ${n2(y)} L ${n2(x + len)} ${n2(y)}"/>`,
      `<path class="arrow" d="M ${n2(x + len - h * 1.6)} ${n2(y - h)} L ${n2(x + len)} ${n2(y)} L ${n2(x + len - h * 1.6)} ${n2(y + h)}"/>`,
      `<text class="sub" x="${n2(x)}" y="${n2(y - 8)}">FORE</text>`,
    ].join('\n');
  }

  const crosshair = (p, cls, r) => {
    const s = r || 6;
    return `<g class="${cls}"><circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="${s}"/>`
      + `<path d="M ${n2(p[0] - s * 1.7)} ${n2(p[1])} L ${n2(p[0] + s * 1.7)} ${n2(p[1])}`
      + ` M ${n2(p[0])} ${n2(p[1] - s * 1.7)} L ${n2(p[0])} ${n2(p[1] + s * 1.7)}"/></g>`;
  };

  /**
   * Render every part into one SVG.
   * @param {object} design {params, skeleton, panels, nest}
   */
  /**
   * The set of shapes that actually need PRINTING, with how many of each to
   * cut.
   *
   * The hull is bilaterally symmetric (§3.4b), so R1..Rn are mirrors of
   * L1..Ln -- printing both is ~40% more paper for no information. §8.6's own
   * cutting method already assumes you do not: fold the fabric coated face to
   * coated face, cut through both layers, and one outline yields the matched
   * pair. So each port panel is drawn once and marked "cut 2".
   *
   * Girth strips are plain rectangles, so they collapse harder still: only
   * distinct LENGTHS need drawing, each with its count.
   *
   * Fabric consumption is NOT halved by any of this -- you still buy enough
   * for the whole boat. The numbers in the notes come from the full nest; this
   * only decides what gets drawn.
   */
  function printSet(built) {
    const parts = [];

    for (const panel of built.tube) {
      if (panel.role === 'starboard') continue;   // drawn as its port partner
      parts.push({
        id: panel.id,
        outline: panel.outline,
        role: panel.role,
        qty: panel.role === 'port' ? 2 : 1,
        mirrored: panel.role === 'port',
        pairId: panel.role === 'port' ? 'R' + panel.id.slice(1) : null,
        panel,
      });
    }

    const byLength = new Map();
    for (const s of built.strips) {
      const key = s.length.toFixed(1);
      if (byLength.has(key)) byLength.get(key).qty++;
      else byLength.set(key, { id: s.id, outline: s.outline, role: 'strip', qty: 1, strip: s, seams: [] });
      byLength.get(key).seams.push(s.seamId);
    }
    for (const s of byLength.values()) parts.push(s);

    const fp = P.nest.floorPart(built.floor);
    parts.push({ id: 'FLOOR', outline: fp.outline, role: 'floor', qty: 1, floorPart: fp, floor: built.floor });

    return parts;
  }

  /**
   * Render every part into one SVG.
   * @param {object} design {params, skeleton, panels, nest}
   */
  function buildBody(design) {
    const { params, panels: built, nest: nested } = design;

    const parts = [];
    const occupancy = [];
    const set = printSet(built);
    const tubeParts = set.filter((p) => p.role !== 'floor');
    const floorParts = set.filter((p) => p.role === 'floor');

    let cursorY = 0;
    let totalW = 0;

    const rolls = [
      { name: 'Tube fabric', fabric: params.materials.tube, c: nested.tube, items: tubeParts },
      { name: 'Floor fabric', fabric: params.materials.floor, c: nested.floor, items: floorParts },
    ];

    for (const roll of rolls) {
      const width = roll.fabric.usableWidth;
      const top = cursorY;
      const placed = P.nest.shelfNest(roll.items, width, 40);
      const byId = new Map(roll.items.map((p) => [p.id, p]));
      const drawnLength = placed.reduce((m, q) => Math.max(m, q.x + q.w), 0);

      const g = [`<g id="roll-${esc(roll.name.replace(/\s+/g, '-'))}">`];
      g.push(`<rect class="roll" x="0" y="${n2(top)}" width="${n2(drawnLength)}" height="${n2(width)}"/>`);
      g.push(`<text class="h2" x="0" y="${n2(top - 14)}">${esc(roll.name)} — unique shapes only, `
        + `${n2(drawnLength / 1000)} m of ${width} mm drawn. `
        + `BUY ${roll.c.linearMetres.toFixed(2)} linear m for the whole boat.</text>`);

      for (const q of placed) {
        const rec = byId.get(q.id);
        if (!rec) continue;
        const m = (p) => [p[0] + q.dx, p[1] + q.dy + top];
        g.push(renderPart(rec, q, m, top));
        occupancy.push({ x: q.x, y: q.y + top, w: q.w, h: q.h });
      }
      g.push('</g>');
      parts.push(g.join('\n'));

      cursorY = top + width + 200;
      totalW = Math.max(totalW, drawnLength);
    }

    // Verification block, below the rolls.
    const notes = verificationBlock(design, 0, cursorY + 40);
    parts.push(notes.svg);
    occupancy.push({ x: 0, y: cursorY + 20, w: notes.width, h: notes.height });
    const h = cursorY + notes.height + 80;

    return {
      body: `<text class="h1" x="0" y="-50">Packraft cutting pattern — 1 mm = 1 unit — `
        + `print at 100%, "Fit to page" OFF</text>\n` + parts.join('\n'),
      x: -80, y: -120, width: totalW + 160, height: h + 200,
      style: STYLE,
      // Where ink actually lands. Most of a roll diagram is blank, so the
      // tiler uses this to drop sheets that would print nothing.
      occupancy,
    };
  }

  /** The whole drawing as one standalone SVG. */
  function render(design) {
    const b = buildBody(design);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(b.width)}mm" height="${n2(b.height)}mm" `
      + `viewBox="${n2(b.x)} ${n2(b.y)} ${n2(b.width)} ${n2(b.height)}">\n<style>${b.style}</style>\n`
      + b.body + '\n</svg>\n';
  }

  /** One nested part, with everything a builder needs printed on it. */
  function renderPart(rec, q, m, top) {
    const g = [];
    const cx = q.x + q.w / 2, cy = q.y + top + q.h / 2;

    if (rec.strip) {
      const s = rec.strip;
      g.push(`<path class="cut" d="${pathOf(s.outline.map(m))}"/>`);
      g.push(`<text class="sub" x="${n2(q.x + 8)}" y="${n2(q.y + top + s.width - 14)}">`
        + `STRIP · cut ${rec.qty} × ${n2(s.length)} × ${n2(s.width)} mm · `
        + `seams ${esc(rec.seams.join(', '))}</text>`);
      return g.join('\n');
    }

    if (rec.floorPart) {
      const floor = rec.floor;
      g.push(`<path class="floor-cut" d="${pathOf(rec.floorPart.outline.map(m))}"/>`);
      // The tube's landing line (the tutorial's e-e'): a MARKED line, not a
      // cut edge, and the tab band's fold line.
      g.push(`<path class="zone" d="${pathOf(floor.outline.map(m))}"/>`);
      for (const z of floor.zones) {
        const a = m(z.from), c = m(z.to);
        // Registration mark at every zone boundary (§7.4d), and the same
        // point is a high-risk corner where two tube sections meet the floor.
        g.push(crosshair(a, 'reg', 7));
        g.push(crosshair(a, 'risk', 14));
        const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        g.push(`<text class="lab" x="${n2(mid[0])}" y="${n2(mid[1])}" text-anchor="middle">`
          + `${esc(z.id)}←${esc(z.segmentId)} ${n2(z.lengthFlat)}`
          + (z.ease > 0.05 ? ` +${n2(z.ease)} ease` : '') + '</text>');
      }
      g.push(`<text class="id" x="${n2(cx)}" y="${n2(cy)}" text-anchor="middle">FLOOR</text>`);
      g.push(`<text class="sub" x="${n2(cx)}" y="${n2(cy + 12)}" text-anchor="middle">`
        + `cut 1 · ${n2(q.w)} × ${n2(q.h)} mm incl. ${n2(floor.tabWidth)} mm developed tab</text>`);
      g.push(`<text class="risklab" x="${n2(cx)}" y="${n2(cy + 22)}" text-anchor="middle">`
        + 'red marks: tube-section corners, the most likely leak — Aquaseal inside after testing</text>');
      g.push(foreArrow(cx - q.w * 0.14, cy + 44, q.w * 0.28));
      return g.join('\n');
    }

    const panel = rec.panel;
    g.push(`<path class="cut" d="${pathOf(panel.outline.map(m))}"/>`);
    for (const r of panel.rulings) {
      const a = m(r[0]), c = m(r[1]);
      g.push(`<path class="ruling" d="M ${n2(a[0])} ${n2(a[1])} L ${n2(c[0])} ${n2(c[1])}"/>`);
    }
    g.push(`<path class="seam" fill="none" d="M ${panel.seamCurve.map(m).map((p) => `${n2(p[0])} ${n2(p[1])}`).join(' L ')}"/>`);

    // A mirrored panel is drawn ONCE and cut twice, by folding. The pair's ID
    // is on the same shape so a cut piece can be labelled either way round.
    const title = rec.mirrored ? `${panel.id} / ${rec.pairId}` : panel.id;
    g.push(`<text class="id" x="${n2(cx)}" y="${n2(cy - 14)}" text-anchor="middle">${esc(title)}</text>`);
    g.push(`<text class="sub" x="${n2(cx)}" y="${n2(cy - 2)}" text-anchor="middle">`
      + `${esc(positionLabel(panel.id))} · ${n2(q.w)} × ${n2(q.h)} mm</text>`);
    if (rec.mirrored) {
      g.push(`<text class="pair" x="${n2(cx)}" y="${n2(cy + 12)}" text-anchor="middle">`
        + `CUT 2 — mirrored pair. Fold the fabric coated face to coated face and `
        + `cut both layers at once.</text>`);
    } else {
      g.push(`<text class="sub" x="${n2(cx)}" y="${n2(cy + 12)}" text-anchor="middle">`
        + 'cut 1 — spans the centreline, self-mirroring</text>');
    }
    if (panel.foreEdgeLabel) {
      g.push(`<text class="lab" x="${n2(q.x + 10)}" y="${n2(cy + 46)}">${esc(panel.foreEdgeLabel)}</text>`);
    }
    if (panel.aftEdgeLabel) {
      g.push(`<text class="lab" x="${n2(q.x + q.w - 34)}" y="${n2(cy + 46)}">${esc(panel.aftEdgeLabel)}</text>`);
    }
    g.push(foreArrow(cx - q.w * 0.16, cy + 30, q.w * 0.32));
    return g.join('\n');
  }

  /** "Front Left" alongside the L1/R1 scheme (§8.6). */
  function positionLabel(id) {
    if (id === 'BOW') return 'Bow, spans centreline';
    if (id === 'STERN') return 'Stern, spans centreline';
    const side = id[0] === 'L' ? 'Left' : 'Right';
    return `${side} ${id.slice(1)}, fore to aft`;
  }

  /**
   * Checks the builder can run before cutting (§8.6): per-panel dimensions,
   * mated-pair lengths that must match by construction, the closure check,
   * and the notes that are wrong to omit.
   */
  function verificationBlock(design, x0, y0) {
    const { params, panels: built, nest: nested } = design;
    const lines = [];
    let y = y0;
    const L = (cls, text, indent) => {
      lines.push(`<text class="${cls}" x="${n2(x0 + (indent || 0))}" y="${n2(y)}">${esc(text)}</text>`);
      y += cls === 'h1' ? 22 : cls === 'h2' ? 12 : 7;
    };

    L('h1', 'Before you cut');
    y += 8;
    L('h2', 'Fabric');
    L('body', `Tube: ${nested.tube.linearMetres.toFixed(2)} linear m of ${params.materials.tube.usableWidth} mm `
      + `(${nested.tube.wastePercent.toFixed(0)}% waste, bound by ${nested.tube.boundBy})`);
    L('body', `Floor: ${nested.floor.linearMetres.toFixed(2)} linear m of ${params.materials.floor.usableWidth} mm `
      + `(${nested.floor.wastePercent.toFixed(0)}% waste, bound by ${nested.floor.boundBy})`);
    L('body', `Fabric mass ${nested.fabricMass.toFixed(0)} g · total seam length ${(nested.totalSeamLength / 1000).toFixed(2)} m`
      + (nested.cost == null ? '' : ` · material ${nested.cost.toFixed(0)} ${nested.currency} ex-VAT`));
    y += 10;

    L('h2', 'Cutting');
    L('body', built.floorInstruction);
    L('body', 'ONLY UNIQUE SHAPES ARE DRAWN. The hull is symmetric, so R1..Rn are mirrors of L1..Ln');
    L('body', 'and each is drawn once marked "cut 2". Fold the fabric coated face to coated face and');
    L('body', 'cut both layers at once: the lower piece comes off coating-up, the upper flips to');
    L('body', 'coating-up too, and it is the mirror. One cut, a guaranteed matched pair.');
    L('body', 'Do NOT flip a single cut panel — trace the mirrored outline instead, or the coating');
    L('body', 'ends up on the wrong face. Single-sided fabric cannot be flipped after cutting.');
    L('body', 'The fabric quantities above are for the WHOLE boat and are not halved by this.');
    L('body', 'Butt seams carry zero allowance: the outline IS the net line. Cut to the line.');
    y += 10;

    L('h2', 'Mated edge pairs — these match by construction, so any difference is a tracing error');
    for (const seam of built.seams) {
      const a = built.tube.find((t) => t.id === seam.a);
      L('mono', `${seam.id.padEnd(4)} ${seam.a.padEnd(6)} aft  ↔  ${seam.b.padEnd(6)} fore   `
        + `${a.endEdgeLengthDev != null && isFinite(a.endEdgeLengthDev) ? a.endEdgeLengthDev.toFixed(1) + ' mm' : ''}`, 8);
    }
    y += 10;

    L('h2', 'Floor closure check');
    L('mono', `flat perimeter ${built.floor.perimeterFlat.toFixed(1)} mm`, 8);
    L('mono', `+ ease          ${built.floor.totalEase.toFixed(1)} mm`, 8);
    L('mono', `= tube landing  ${built.floor.perimeter3D.toFixed(1)} mm`, 8);
    y += 6;
    L('body', 'Ease is surplus tube edge to be distributed WITHIN its own zone, not around the whole');
    L('body', 'perimeter. It appears only where the hull rises; the midbody zones need none.');
    y += 10;

    L('h2', 'Landing zones');
    for (const z of built.floor.zones) {
      L('mono', `${z.id.padEnd(4)} ${z.segmentId.padEnd(6)} floor ${z.lengthFlat.toFixed(1).padStart(7)} mm   `
        + `tube ${z.length3D.toFixed(1).padStart(7)} mm   ease ${z.ease.toFixed(1).padStart(5)} mm`
        + (z.triangular ? '   (triangular, tip)' : ''), 8);
    }

    return {
      svg: `<g id="verification">\n${lines.join('\n')}\n</g>`,
      width: 340,
      height: y - y0 + 40,
    };
  }

  const api = { render, buildBody, printSet, verificationBlock, positionLabel, n2, esc };

  P.exportSvg = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
