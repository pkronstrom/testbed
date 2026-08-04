/**
 * engine/tile.js -- the same 1:1 drawing, cut into sheets a home printer owns.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE MODE THIS FILE EXISTS FOR
 *
 * It is never the maths. It is the printer driver. "Fit to Page" is ON by
 * default in most of them, "Shrink oversized pages" in others, and both are
 * silent: the pattern comes out 96.3% of size, every panel is 3.7% short, the
 * seams still LOOK like they mate, and the boat is 100 mm shorter than the
 * document says. Nothing downstream can detect that. So:
 *
 *   1. A 100.0 mm CALIBRATION SQUARE on PAGE 1, with a 10 mm ruler, and page 1
 *      is the map sheet -- print ONE page, measure the square, and only then
 *      commit forty sheets of paper and a morning of taping. (The drawing body
 *      carries its own calibration square too, so whichever tile holds it
 *      re-states the check where the parts are.)
 *   2. "Scale 100% / Actual Size — turn OFF Fit to Page" in every page header.
 *   3. GLUE MARGINS, not butt joints: `overlap` mm of duplicated content on
 *      every shared edge, with a trim line through it. Self-correcting -- a
 *      sheet taped 1 mm out is absorbed by the band instead of accumulating
 *      down the row.
 *   4. CROP MARKS at the four corners of every tile's content box, so a sheet
 *      trimmed with a guillotine has something square to cut to.
 *   5. PAGE COORDINATES -- column letter + row number, A1, B3, ... -- large and
 *      in the corner, plus the neighbour's name printed against each trim line
 *      and a map sheet showing the whole grid. On a floor covered in identical
 *      white rectangles this is the difference between an hour and an evening.
 *
 * ---------------------------------------------------------------------------
 * WHY HTML AND NOT PDF
 *
 * One `@page { size: <W>mm <H>mm; margin: 0 }` and a browser prints true 1:1
 * with scaling off. That is the whole requirement, and it costs no PDF writer,
 * no font embedding and no dependency -- the file opens from file:// like
 * everything else in this engine. Every page renders the SAME body SVG at a
 * different viewBox, so content inside a glue margin is identical on both
 * sheets BY CONSTRUCTION rather than by a matching calculation that could
 * drift.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL IS THE SAME REFUSAL
 *
 * `renderPrintHtml` goes through `exportSvg.buildBody`, which goes through
 * `exportSvg.gate`. A boat that fails developability cannot be printed either,
 * for exactly the reason it cannot be exported: the sheets would not be an
 * isometry of anything.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./export-svg.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const X = E.exportSvg;

  /**
   * Page sizes, mm, PORTRAIT. Six, spanning what a builder can actually reach:
   * A4 and Letter at home, A3 and Tabloid on an office machine, A1 and A0 at a
   * copy shop -- where the whole pattern is a handful of sheets and the taping
   * stops being the job.
   */
  const PAGE_SIZES = {
    A4: [210, 297],
    A3: [297, 420],
    Letter: [215.9, 279.4],
    Tabloid: [279.4, 431.8],
    A1: [594, 841],
    A0: [841, 1189],
  };

  const DEFAULTS = {
    // A3 by default: A4 needs ~2.4x the sheets, and taping time is proportional
    // to sheet count, not to area.
    pageSize: 'A3',
    landscape: false,
    margin: 8,          // mm, printer-safe non-printing edge
    overlap: 15,        // mm of glue margin, duplicated on both sheets
    gridStep: 100,      // mm, the continuous content grid
    calibration: 100,   // mm, EXACTLY 100.0
    now: null,          // date STRING from the caller; no clock in here either
  };

  /**
   * Opacity of the ghosted pattern on the map sheet.
   *
   * Subordinate to the grid ON PURPOSE. The map's job is the taping plan; the
   * pieces are there so a builder can see which sheet the bow lands on, and the
   * moment they compete with the page rectangles and the coordinates the sheet
   * stops being a plan and becomes a second, wrong, not-to-scale pattern.
   */
  const GHOST_OPACITY = 0.22;

  const n2 = (v) => (Math.abs(v) < 5e-3 ? '0' : v.toFixed(2));
  // Page boxes go into CSS, where "210mm" reads better than "210.00mm" and
  // still compares byte-for-byte between runs.
  const mm = (v) => (v.toFixed(2).replace(/\.?0+$/, '') || '0');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  /** A, B, ... Z, AA, AB, ... -- spreadsheet columns, for the same reason. */
  function colLabel(i) {
    let s = '', n = i;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  /**
   * Split a drawing into pages.
   *
   * Each sheet prints `inner` mm of content and consecutive sheets advance by
   * `inner - overlap`, so the last `overlap` mm of one sheet repeats as the
   * first `overlap` mm of the next. That repeat IS the glue margin: tape inside
   * it and a millimetre of misalignment is absorbed rather than accumulated.
   *
   * Tiles with no ink are dropped. On a sheet layout most of the fabric is
   * blank, and printing it is paper and taping for nothing -- but the surviving
   * tiles keep their GRID labels, so a label still says where the sheet belongs
   * even when its neighbours were never printed.
   */
  function paginate(drawing, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const size = PAGE_SIZES[o.pageSize];
    if (!size) {
      throw new Error('tile: unknown page size "' + o.pageSize + '" (have '
        + Object.keys(PAGE_SIZES).join(', ') + ')');
    }
    const pageW = o.landscape ? size[1] : size[0];
    const pageH = o.landscape ? size[0] : size[1];
    const innerW = pageW - 2 * o.margin;
    const innerH = pageH - 2 * o.margin;
    if (innerW <= o.overlap || innerH <= o.overlap) {
      throw new Error('tile: page too small for a ' + o.margin + ' mm margin and a '
        + o.overlap + ' mm glue margin');
    }
    const stepX = innerW - o.overlap;
    const stepY = innerH - o.overlap;

    /**
     * Where the page grid is ANCHORED.
     *
     * By default at the drawing's own top-left, which is what a tiler normally
     * wants. The grid-aware nest needs it somewhere else: it placed its parts
     * on multiples of (stepX, stepY) from the fabric origin, and that only buys
     * anything if the pages fall on the same lattice. So the anchor is an
     * option, the column and row indices are allowed to go NEGATIVE (the title
     * block sits above the fabric), and the printed labels are renumbered from
     * the first sheet that exists.
     */
    const ox = o.origin ? o.origin[0] : drawing.x;
    const oy = o.origin ? o.origin[1] : drawing.y;
    const span = (lo, hi, origin, step, inner) => {
      const a = Math.floor((lo - origin) / step);
      const b = Math.max(a, Math.ceil((hi - inner - origin) / step));
      return [a, b];
    };
    const [cMin, cMax] = span(drawing.x, drawing.x + drawing.width, ox, stepX, innerW);
    const [rMin, rMax] = span(drawing.y, drawing.y + drawing.height, oy, stepY, innerH);
    const cols = cMax - cMin + 1;
    const rows = rMax - rMin + 1;

    const boxes = drawing.occupancy || null;
    const inked = (x, y, w, h) => {
      if (!boxes) return true;
      for (const b of boxes) {
        if (x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h) return true;
      }
      return false;
    };
    const pxOf = (c) => ox + c * stepX;
    const pyOf = (r) => oy + r * stepY;

    const pages = [];
    let skipped = 0;
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const px = pxOf(c), py = pyOf(r);
        if (!inked(px, py, innerW, innerH)) { skipped++; continue; }
        pages.push({
          col: c - cMin, row: r - rMin,
          label: colLabel(c - cMin) + (r - rMin + 1),
          right: c < cMax && inked(pxOf(c + 1), py, innerW, innerH)
            ? colLabel(c - cMin + 1) + (r - rMin + 1) : null,
          below: r < rMax && inked(px, pyOf(r + 1), innerW, innerH)
            ? colLabel(c - cMin) + (r - rMin + 2) : null,
          x: px, y: py, w: innerW, h: innerH,
        });
      }
    }
    return {
      pages, cols, rows, skipped, pageW, pageH, innerW, innerH, stepX, stepY,
      originX: ox, originY: oy,
      overlap: o.overlap, margin: o.margin, gridStep: o.gridStep,
      calibration: o.calibration, pageSize: o.pageSize, landscape: !!o.landscape,
      /** Sheets that come out of the printer: the map sheet plus the tiles. */
      sheets: pages.length + 1,
    };
  }

  const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e9ebee; }
  .page { position: relative; overflow: hidden; background: #fff;
          page-break-after: always; break-after: page;
          margin: 0 auto 8mm; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .page > svg { position: absolute; left: 0; top: 0; }
  .hdr { position: absolute; left: 3mm; top: 2mm; right: 3mm; z-index: 2;
         font: 3mm/1.3 Helvetica, Arial, sans-serif; color: #000;
         display: flex; justify-content: space-between; }
  .hdr b { font-size: 3.6mm; }
  .red { color: #c0392b; font-weight: 600; }
  @media print { html, body { background: #fff; } .page { margin: 0; box-shadow: none; } }
`;

  const OVERLAY_STYLE = `
    .trim { stroke: #c0392b; stroke-width: 0.3; stroke-dasharray: 3 2; }
    .band { fill: rgba(192,57,43,0.06); }
    .crop { stroke: #111; stroke-width: 0.3; fill: none; }
    .reg { stroke: #c0392b; stroke-width: 0.3; fill: none; }
    .reglab { font: 2.6px Helvetica, Arial, sans-serif; fill: #c0392b; }
    .cal { fill: none; stroke: #c0392b; stroke-width: 0.5; }
    .caltick { stroke: #c0392b; stroke-width: 0.3; }
    .callab { font: 3px Helvetica, Arial, sans-serif; fill: #c0392b; }
    .grid { stroke: #d3dae3; stroke-width: 0.25; fill: none; }
    .maplab { font: 3px Helvetica, Arial, sans-serif; fill: #555; }
    /* The ghosted pattern under the map grid. Grey, unfilled outlines: a filled
       silhouette at this opacity competes with the sheet rectangles, and the
       point of the layer is to be READ THROUGH. Sizes come from the element,
       not from here, because they are scale-compensated. */
    .ghost { fill: none; stroke: #1d2530; }
    .ghostflip { fill: none; stroke: #c0392b; }
    .ghostlab { font-family: Helvetica, Arial, sans-serif; fill: #1d2530;
                font-weight: 600; }
    /* The appendix: the title block's own words, set for a sheet somebody holds
       rather than for a 1:1 pattern the size of a garage floor. */
    .ap-h1 { font: 600 6px Helvetica, Arial, sans-serif; fill: #111; }
    .ap-h2 { font: 600 4.2px Helvetica, Arial, sans-serif; fill: #111; }
    .ap-warn { font: 600 3.4px Helvetica, Arial, sans-serif; fill: #c0392b; }
    .ap-body { font: 2.9px Helvetica, Arial, sans-serif; fill: #111; }
    .ap-mono { font: 2.6px "SFMono-Regular", Consolas, monospace; fill: #333; }
    .tilelab { font: 700 11px Helvetica, Arial, sans-serif; fill: #c0392b; opacity: .55; }
    .note { font: 3.4px Helvetica, Arial, sans-serif; fill: #111; }
    .small { font: 2.8px Helvetica, Arial, sans-serif; fill: #444; }
  `;

  /**
   * Crop marks: an L at each corner of the content box, standing off by 1 mm so
   * the mark itself is never on the cut. Drawn in PAGE millimetres.
   */
  function cropMarks(t) {
    const m = t.margin, a = 4, o = 1;
    const x0 = m, y0 = m, x1 = m + t.innerW, y1 = m + t.innerH;
    const L = (x, y, dx, dy) => '<path class="crop" d="M ' + n2(x + dx * o) + ' ' + n2(y)
      + ' L ' + n2(x + dx * (o + a)) + ' ' + n2(y) + ' M ' + n2(x) + ' ' + n2(y + dy * o)
      + ' L ' + n2(x) + ' ' + n2(y + dy * (o + a)) + '"/>';
    return [L(x0, y0, -1, -1), L(x1, y0, 1, -1), L(x0, y1, -1, 1), L(x1, y1, 1, 1)].join('\n');
  }

  /** Everything printed on a tile that is not the drawing. PAGE millimetres. */
  function pageOverlay(t, page) {
    const g = [];
    const m = t.margin;
    const trimX = m + t.stepX;
    const trimY = m + t.stepY;

    g.push(cropMarks(t));

    // The sheet's own name, big enough to read from standing height.
    g.push('<text class="tilelab" x="' + n2(t.pageW - m) + '" y="' + n2(t.pageH - m)
      + '" text-anchor="end">' + page.label + '</text>');

    // Glue margin + trim line, with the neighbour named against it.
    const cross = (x, y, text) => {
      g.push('<g class="reg"><circle cx="' + n2(x) + '" cy="' + n2(y) + '" r="2"/>'
        + '<path d="M ' + n2(x - 5) + ' ' + n2(y) + ' L ' + n2(x + 5) + ' ' + n2(y)
        + ' M ' + n2(x) + ' ' + n2(y - 5) + ' L ' + n2(x) + ' ' + n2(y + 5) + '"/></g>');
      if (text) {
        g.push('<text class="reglab" x="' + n2(x + 2) + '" y="' + n2(y - 2) + '">'
          + esc(text) + '</text>');
      }
    };
    if (page.right) {
      g.push('<line class="trim" x1="' + n2(trimX) + '" y1="0" x2="' + n2(trimX)
        + '" y2="' + n2(t.pageH) + '"/>');
      g.push('<rect class="band" x="' + n2(trimX) + '" y="0" width="' + n2(t.overlap)
        + '" height="' + n2(t.pageH) + '"/>');
      cross(trimX, m, page.label + ' → ' + page.right);
      cross(trimX, m + t.innerH / 2, '');
      cross(trimX, m + t.innerH, '');
    }
    if (page.below) {
      g.push('<line class="trim" x1="0" y1="' + n2(trimY) + '" x2="' + n2(t.pageW)
        + '" y2="' + n2(trimY) + '"/>');
      g.push('<rect class="band" x="0" y="' + n2(trimY) + '" width="' + n2(t.pageW)
        + '" height="' + n2(t.overlap) + '"/>');
      cross(m, trimY, page.label + ' ↓ ' + page.below);
      cross(m + t.innerW / 2, trimY, '');
      cross(m + t.innerW, trimY, '');
    }
    return g.join('\n');
  }

  /** The 100.0 mm calibration square for the map sheet, in PAGE millimetres. */
  function calibration(t, x, y) {
    const c = t.calibration;
    const g = ['<g id="calibration">'];
    g.push('<rect class="cal" x="' + n2(x) + '" y="' + n2(y) + '" width="' + n2(c)
      + '" height="' + n2(c) + '"/>');
    for (let i = 0; i <= c; i += 10) {
      const h = i % 50 === 0 ? 5 : 2.5;
      g.push('<line class="caltick" x1="' + n2(x + i) + '" y1="' + n2(y + c)
        + '" x2="' + n2(x + i) + '" y2="' + n2(y + c - h) + '"/>');
    }
    g.push('<text class="callab" x="' + n2(x + 2) + '" y="' + n2(y + c - 4) + '">'
      + c.toFixed(1) + ' mm — measure me BEFORE printing the rest</text>');
    g.push('<text class="callab" x="' + n2(x) + '" y="' + n2(y + c + 5) + '">'
      + 'Not ' + c.toFixed(0) + ' mm? The driver scaled it. Fix the setting, reprint this sheet.</text>');
    g.push('</g>');
    return g.join('\n');
  }

  /**
   * The continuous 100 mm grid, in CONTENT coordinates.
   *
   * Drawn per BOX, not once for the whole drawing, and every line lands on the
   * same absolute multiple of `step` -- so the grid is continuous across a taped
   * joint by construction while a sheet only carries the dozen lines it shows.
   * (Emitting the whole 9 m grid on all 267 A4 tiles was 2.7 MB of the file.)
   * It is the fourth print-scaling defence: a grid that steps at a taped joint
   * is misalignment you can see across the room.
   */
  function contentGrid(box, step) {
    const g = [];
    const x0 = Math.floor(box.x / step) * step;
    const y0 = Math.floor(box.y / step) * step;
    const x1 = box.x + box.width;
    const y1 = box.y + box.height;
    for (let x = x0; x <= x1; x += step) {
      g.push('<line class="grid" x1="' + n2(x) + '" y1="' + n2(y0) + '" x2="' + n2(x)
        + '" y2="' + n2(y1) + '"/>');
    }
    for (let y = y0; y <= y1; y += step) {
      g.push('<line class="grid" x1="' + n2(x0) + '" y1="' + n2(y) + '" x2="' + n2(x1)
        + '" y2="' + n2(y) + '"/>');
    }
    return g.join('\n');
  }

  /**
   * The map: the taping plan.
   *
   * Tiles are labelled on the grid AXES rather than one label per rectangle --
   * at four hundred tiles a label per rectangle is a smear, and the axes carry
   * the same information at any density. Dropped (blank) tiles simply do not
   * appear, which is itself the useful part.
   */
  /**
   * The nested pieces, ghosted, in the map's own transform.
   *
   * Drawn in CONTENT coordinates inside one transform group rather than mapped
   * point by point: the group is exactly the map's own px()/py(), so a piece
   * cannot drift out of its page cell however the map is scaled or anchored --
   * which is the entire value of putting it there.
   *
   * Stroke width and font size are divided by the scale so they come out at a
   * fixed size ON PAPER (0.4 mm and 3.2 mm) instead of shrinking to invisible
   * on a 9 m roll squeezed onto a sheet of A3.
   *
   * The half-floor's FLIP LINE is drawn too. The map is where the builder plans
   * which pieces get traced twice, and a half floor with no flip line on the
   * plan is a half floor somebody cuts once.
   */
  function ghostLayer(drawing, ox, oy, ux0, uy0, scale) {
    const parts = new Map((drawing.parts || []).map((p) => [p.id, p]));
    const placed = (drawing.layout && drawing.layout.placed) || [];
    const sw = 0.4 / scale;
    const fs = 3.2 / scale;
    const g = ['<g id="pattern-ghost" opacity="' + GHOST_OPACITY
      + '" transform="translate(' + n2(ox) + ' ' + n2(oy) + ') scale(' + scale.toFixed(6)
      + ') translate(' + n2(-ux0) + ' ' + n2(-uy0) + ')">'];
    for (const q of placed) {
      const part = parts.get(q.id);
      if (!part) continue;
      const c = q.cos == null ? 1 : q.cos, s = q.sin == null ? 0 : q.sin;
      const m = (p) => [p[0] * c - p[1] * s + q.dx, p[0] * s + p[1] * c + q.dy];
      g.push('<path class="ghost" stroke-width="' + n2(sw) + '" d="'
        + X.pathOf(part.outline.map(m)) + '"/>');
      if (part.flipLine) {
        const a = m(part.flipLine[0]), b = m(part.flipLine[1]);
        g.push('<path class="ghostflip" stroke-width="' + n2(sw * 2) + '" d="M '
          + n2(a[0]) + ' ' + n2(a[1]) + ' L ' + n2(b[0]) + ' ' + n2(b[1]) + '"/>');
      }
      g.push('<text class="ghostlab" font-size="' + n2(fs) + '" x="'
        + n2(q.x + q.w / 2) + '" y="' + n2(q.y + q.h / 2) + '" text-anchor="middle">'
        + esc(q.label) + '</text>');
    }
    g.push('</g>');
    return g.join('\n');
  }

  function mapPage(t, drawing, top) {
    const availW = t.pageW - 2 * t.margin - 14;
    // Room for the calibration square and its two lines of instruction below
    // the map -- page 1 exists to be measured before anything else is printed.
    const availH = t.pageH - t.margin - top - t.calibration - 40;
    // Scale to the union of the drawing and the SHEETS. A sheet hangs past the
    // drawing wherever the page does not divide it, and with a grid-anchored
    // layout it can hang past the top-left as well; scaling to the drawing
    // alone drew those sheets off the map.
    let ux0 = drawing.x, uy0 = drawing.y;
    let ux1 = drawing.x + drawing.width, uy1 = drawing.y + drawing.height;
    for (const p of t.pages) {
      if (p.x < ux0) ux0 = p.x;
      if (p.y < uy0) uy0 = p.y;
      if (p.x + p.w > ux1) ux1 = p.x + p.w;
      if (p.y + p.h > uy1) uy1 = p.y + p.h;
    }
    const scale = Math.min(availW / (ux1 - ux0), availH / (uy1 - uy0));
    const ox = t.margin + 12, oy = top;
    const px = (x) => ox + (x - ux0) * scale;
    const py = (y) => oy + (y - uy0) * scale;
    const g = [];

    // THE GHOST: the actual pattern, faded, UNDER the grid.
    //
    // The map is where the tape-up puzzle gets solved, and a grid of empty
    // rectangles does not tell you which sheet has the bow on it. Drawn first
    // so every grid line, sheet rectangle and page coordinate lands on top of
    // it, and at low opacity so it stays a hint rather than a second pattern
    // somebody might try to cut from -- it is not 1:1 and must never look it.
    g.push(ghostLayer(drawing, ox, oy, ux0, uy0, scale));

    g.push('<rect x="' + n2(px(drawing.x)) + '" y="' + n2(py(drawing.y)) + '" width="'
      + n2(drawing.width * scale) + '" height="' + n2(drawing.height * scale)
      + '" fill="none" stroke="#bbb" stroke-width="0.3"/>');
    for (const p of t.pages) {
      g.push('<rect x="' + n2(px(p.x)) + '" y="' + n2(py(p.y)) + '" width="'
        + n2(p.w * scale) + '" height="' + n2(p.h * scale)
        + '" fill="rgba(192,57,43,0.08)" stroke="#c0392b" stroke-width="0.2"/>');
    }

    // Axis labels, THINNED so they cannot collide: at fifty columns the tiles
    // are ~4 mm apart on the map while a two-character label is ~4.2 mm wide.
    const LABEL_MM = 4.2;
    const used = (key) => {
      const out = [];
      const n = key === 'col' ? t.cols : t.rows;
      for (let i = 0; i < n; i++) if (t.pages.some((p) => p[key] === i)) out.push(i);
      return out;
    };
    const keep = (list, every) => {
      const out = [];
      for (let i = 0; i < list.length; i += every) out.push(i);
      const last = list.length - 1;
      if (out[out.length - 1] !== last && last - out[out.length - 1] >= every / 2) out.push(last);
      return out.map((i) => list[i]);
    };
    const everyCol = Math.max(1, Math.ceil(LABEL_MM / Math.max(t.stepX * scale, 0.01)));
    const everyRow = Math.max(1, Math.ceil(LABEL_MM / Math.max(t.stepY * scale, 0.01)));

    // Positions come from the SHEETS, not from arithmetic on the drawing box:
    // the grid may be anchored anywhere, including left of the drawing.
    const anyCol = (c) => t.pages.find((p) => p.col === c);
    const anyRow = (r) => t.pages.find((p) => p.row === r);
    for (const c of keep(used('col'), everyCol)) {
      g.push('<text class="maplab" x="'
        + n2(px(anyCol(c).x) + (t.innerW * scale) / 2) + '" y="' + n2(oy - 2)
        + '" text-anchor="middle">' + colLabel(c) + '</text>');
    }
    for (const r of keep(used('row'), everyRow)) {
      g.push('<text class="maplab" x="' + n2(ox - 3) + '" y="'
        + n2(py(anyRow(r).y) + (t.innerH * scale) / 2)
        + '" text-anchor="end">' + (r + 1) + '</text>');
    }
    // The TRUE bottom of the ink, not the drawing's: the last row of sheets
    // hangs below the drawing wherever the page is taller than what is left of
    // it, and the calibration square has to clear that rather than sit on it.
    const bottom = t.pages.reduce((m, p) => Math.max(m, py(p.y) + p.h * scale),
      py(drawing.y + drawing.height));
    return { svg: g.join('\n'), bottom };
  }

  /**
   * The drawing, cropped to the CUTTING PATTERN.
   *
   * The tiled region must cover the nested pieces and nothing else. It used to
   * cover the whole drawing, which includes the banner the single-file SVG puts
   * its title block, instructions, cutting list and calibration square in --
   * and on A3 that prose was a whole row of fifteen sheets carrying a paragraph
   * of text and no cut line. All of it belongs on the appendix sheet, which is
   * page 1 and already exists.
   *
   * The crop is `drawing.nestBox`, which engine/export-svg.js PUBLISHES as the
   * union of its `part` pieces. Inferring it here from coordinates would mean
   * inferring where the prose stops, and the prose has moved before.
   *
   * The pad is one glue margin, so no cut line lands exactly on a trim line and
   * the seam ticks -- which stand 12 mm proud of the outline at a corner -- are
   * never clipped.
   */
  function cropToNest(drawing, pad) {
    const b = drawing.nestBox;
    if (!b || !(b.width > 0)) return drawing;
    const parts = drawing.pieces.filter((p) => p.kind === 'part');
    return Object.assign({}, drawing, {
      x: b.x - pad, y: b.y - pad,
      width: b.width + 2 * pad, height: b.height + 2 * pad,
      pieces: parts,
      occupancy: parts.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
      body: parts.map((p) => p.svg).join('\n'),
      full: drawing,
    });
  }

  /**
   * Pick the layout that costs fewer SHEETS -- which is not the layout that
   * costs less fabric.
   *
   * For a home printer the unit of cost is the page. A part overhanging its
   * page by 5 mm costs a whole sheet of paper, a whole taping seam and a whole
   * chance to misalign, and the fabric-optimal nest knows nothing about paper:
   * it will happily leave a 5 mm tail on the far side of a page boundary
   * fourteen times down a 9 m roll.
   *
   * So two layouts are built and PAGINATED, and the cheaper one wins:
   *
   *   fabric  the ordinary contour nest, paginated from its own top-left;
   *   grid    the same parts nested into a lattice of printable cells, with the
   *           page grid anchored on the same lattice so a part that fits a cell
   *           lands inside a page instead of across two.
   *
   * Measuring both is the honest way round: quantising costs fabric, and on a
   * page big enough to swallow several parts (A0) the fabric-optimal nest can
   * still win on sheets. Neither is assumed.
   */
  function layoutFor(built, o) {
    const size = PAGE_SIZES[o.pageSize];
    if (!size) {
      throw new Error('tile: unknown page size "' + o.pageSize + '" (have '
        + Object.keys(PAGE_SIZES).join(', ') + ')');
    }
    const pageW = o.landscape ? size[1] : size[0];
    const pageH = o.landscape ? size[0] : size[1];
    const stepX = pageW - 2 * o.margin - o.overlap;
    const stepY = pageH - 2 * o.margin - o.overlap;

    const fabric = cropToNest(X.buildBody(built, o), o.overlap);
    const candidates = [{ mode: 'fabric', drawing: fabric, t: paginate(fabric, o) }];

    // (b) the SAME layout with the page grid slid to a better PHASE. The
    // default anchor is the drawing's own corner, which is an arbitrary place
    // to start counting: a grid nudged so a page edge falls on the edge of a
    // part can drop a whole row or column of nearly-blank sheets. Candidate
    // phases are the ink boundaries themselves, so the search is a couple of
    // hundred paginations rather than a sweep.
    const phaseFrom = (vals, step) => {
      const s = new Set([0]);
      for (const v of vals) s.add(((v % step) + step) % step);
      return Array.from(s).sort((a, b) => a - b);
    };
    const boxes = fabric.occupancy || [];
    const t0 = candidates[0].t;
    // The default anchor is one of the candidates, so this branch can only ever
    // tie or win -- never cost a sheet.
    const phX = phaseFrom(boxes.flatMap((q) => [q.x, q.x + q.w - t0.innerW])
      .concat([fabric.x]), stepX);
    const phY = phaseFrom(boxes.flatMap((q) => [q.y, q.y + q.h - t0.innerH])
      .concat([fabric.y]), stepY);
    let phased = null;
    for (const a of phX) {
      for (const b of phY) {
        const t = paginate(fabric, Object.assign({}, o, { origin: [a, b] }));
        if (!phased || t.pages.length < phased.t.pages.length) {
          phased = { mode: 'phased', drawing: fabric, t };
        }
      }
    }
    if (phased) candidates.push(phased);

    // (c) the layout re-nested onto the page lattice, paginated on that same
    // lattice. See engine/export-svg.js gridNest.
    if (stepX > 0 && stepY > 0) {
      const grid = cropToNest(X.buildBody(built, Object.assign({}, o, {
        packer: 'grid', cellW: stepX, cellH: stepY,
      })), o.overlap);
      candidates.push({ mode: 'grid', drawing: grid,
        t: paginate(grid, Object.assign({}, o, { origin: [0, 0] })) });
    }

    // Fewest sheets wins; ties go to the earlier (less exotic) candidate, so
    // the plain fabric layout is the default answer and the others have to earn
    // their place. Deterministic either way.
    let best = candidates[0];
    for (const c of candidates) {
      if (c.t.pages.length < best.t.pages.length) best = c;
    }
    best.candidates = candidates.map((c) => ({ mode: c.mode, pages: c.t.pages.length,
      cols: c.t.cols, rows: c.t.rows, usedLength: c.drawing.layout.usedLength }));
    return best;
  }

  /**
   * Appendix typography: PAGE millimetres, not content millimetres.
   *
   * These are the same words engine/export-svg.js sets in its title block,
   * where `h1` is 22 mm tall because that block lives on a 1:1 cutting sheet
   * the size of a garage floor. Here they are on a sheet of A3 somebody holds,
   * so they are set at 6 mm and 2.9 mm. One source of words, two typographies:
   * `exportSvg.titleLines` returns the structure and each renderer sizes it.
   */
  const APPENDIX = {
    h1: { cls: 'ap-h1', step: 8 },
    h2: { cls: 'ap-h2', step: 6 },
    warn: { cls: 'ap-warn', step: 5 },
    body: { cls: 'ap-body', step: 4.2 },
    mono: { cls: 'ap-mono', step: 3.8 },
    gap: { cls: null, step: 3 },
  };

  /**
   * Lay out as many lines as fit between `y` and `limit`, and hand back the
   * rest.
   *
   * The appendix spills onto another sheet rather than being clipped or
   * shrunk: on A4 the map and the calibration square already use most of page
   * 1, and silently dropping the second half of the cutting list is exactly the
   * kind of helpfulness that loses somebody a panel.
   */
  function flowText(lines, x, y, limit) {
    const out = [];
    let cursor = y;
    let i = 0;
    for (; i < lines.length; i++) {
      const spec = APPENDIX[lines[i].cls] || APPENDIX.body;
      if (cursor + spec.step > limit) break;
      if (spec.cls) {
        out.push('<text class="' + spec.cls + '" x="' + n2(x) + '" y="' + n2(cursor) + '">'
          + esc(lines[i].text) + '</text>');
      }
      cursor += spec.step;
    }
    return { svg: out.join('\n'), rest: lines.slice(i), y: cursor };
  }

  /**
   * A complete print-ready document: page 1 the APPENDIX -- tile map, ghosted
   * pattern, 100 mm calibration square and every word of instruction -- then
   * however many more appendix sheets the words need, then one page per inked
   * tile.
   *
   * The tiles carry PATTERN INK ONLY. They used to carry the title block too,
   * because the tiled region was the whole drawing, and on A3 that was a row of
   * fifteen sheets holding a paragraph of prose and not one cut line.
   *
   * @param {object} built develop2.build output
   * @throws when the developability checks refuse (exportSvg.gate)
   */
  function renderPrintHtml(built, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const chosen = layoutFor(built, o);
    const drawing = chosen.drawing;
    const t = chosen.t;
    const name = built.doc.meta.name;

    const pageStyle = '.page { width: ' + mm(t.pageW) + 'mm; height: ' + mm(t.pageH) + 'mm; }'
      + '\n@page { size: ' + mm(t.pageW) + 'mm ' + mm(t.pageH) + 'mm; margin: 0; }';

    const head = (extra) => '<div class="hdr"><span><b>' + esc(name) + '</b> — '
      + '<span class="red">print at 100% / Actual Size — turn OFF "Fit to Page"</span>'
      + '</span><span>' + esc(extra) + '</span></div>';

    const svgOpen = '<svg width="' + mm(t.pageW) + 'mm" height="' + mm(t.pageH)
      + 'mm" viewBox="0 0 ' + mm(t.pageW) + ' ' + mm(t.pageH)
      + '" xmlns="http://www.w3.org/2000/svg">';

    const pages = [];

    // --- PAGE 1: the map, and the calibration square that gates the rest ---
    // The map's column letters sit just above its top edge, so the map has to
    // start below the last line of preamble -- and the cutting-rule line only
    // exists in mirrorOnce mode.
    const mapTop = t.margin + 34 + (o.mirrorOnce ? 9 : 0);
    const map = mapPage(t, drawing, mapTop);
    const calY = Math.min(t.pageH - t.margin - t.calibration - 14, map.bottom + 12);
    // Every word from the title block, on the sheet that is meant to be read.
    const appendix = flowText(drawing.titleLines || [], t.margin + 12,
      calY + t.calibration + 14, t.pageH - t.margin - 2);
    pages.push('<div class="page">' + head('appendix · ' + t.pageSize)
      + svgOpen + '<style>' + OVERLAY_STYLE + '</style>'
      + '<text class="note" x="' + n2(t.margin) + '" y="' + n2(t.margin + 14) + '">'
      + 'Tile map — ' + t.pages.length + ' sheets as ' + t.cols + ' × ' + t.rows
      + ' of ' + t.pageSize + (t.landscape ? ' landscape' : '')
      + ' (' + t.skipped + ' blank tiles omitted), ' + t.overlap + ' mm glue margins'
      + (chosen.mode === 'grid' ? ', page-grid nested' : '') + '.</text>'
      + '<text class="small" x="' + n2(t.margin) + '" y="' + n2(t.margin + 21) + '">'
      + 'Tape by column letter and row number. Overlap the printed band, align the red '
      + 'crosshairs, tape on the back.</text>'
      + '<text class="small" x="' + n2(t.margin) + '" y="' + n2(t.margin + 27) + '">'
      + 'MEASURE THE SQUARE BELOW FIRST. Print this one sheet, check it, then print the rest.'
      + '</text>'
      // The cutting rule that changes what these sheets MEAN travels with them:
      // a taped-up pattern that is missing every starboard panel is alarming
      // until you know it is missing them on purpose.
      + (o.mirrorOnce
        ? '<text class="small" x="' + n2(t.margin) + '" y="' + n2(t.margin + 33) + '">'
          + 'Mirrored pairs are drawn ONCE (' + drawing.parts.length + ' patterns for '
          + drawing.parts.reduce((s, p) => s + p.qty, 0) + ' pieces): trace, turn the '
          + 'pattern over, trace again. The full cutting list is below.'
          + '</text>'
        : '')
      + map.svg + calibration(t, t.margin + 12, calY) + appendix.svg
      + cropMarks(t) + '</svg></div>');

    // --- however many more appendix sheets the words need ---
    let rest = appendix.rest;
    while (rest.length) {
      const more = flowText(rest, t.margin + 12, t.margin + 18, t.pageH - t.margin - 2);
      if (!more.svg) break;                       // a line taller than a page: stop
      pages.push('<div class="page">' + head('appendix (continued) · ' + t.pageSize)
        + svgOpen + '<style>' + OVERLAY_STYLE + '</style>'
        + more.svg + cropMarks(t) + '</svg></div>');
      rest = more.rest;
    }

    // --- the tiles ---
    // Only the pieces this sheet shows. A sheet and its neighbour emit the SAME
    // STRING for a piece they share, so the glue margin still holds identical
    // content by construction -- see engine/export-svg.js `piecesIn`.
    for (const p of t.pages) {
      const body = X.piecesIn(drawing, p.x, p.y, p.w, p.h).map((q) => q.svg).join('\n');
      const grid = contentGrid({ x: p.x, y: p.y, width: p.w, height: p.h }, t.gridStep);
      pages.push('<div class="page">' + head('tile ' + p.label)
        + svgOpen + '<style>' + drawing.style + OVERLAY_STYLE + '</style>'
        // The body, windowed to this tile and shifted inside the page margin.
        + '<g transform="translate(' + n2(t.margin) + ' ' + n2(t.margin) + ')">'
        + '<svg width="' + n2(t.innerW) + '" height="' + n2(t.innerH) + '" viewBox="'
        + n2(p.x) + ' ' + n2(p.y) + ' ' + n2(p.w) + ' ' + n2(p.h) + '">'
        + grid + '\n' + body + '</svg></g>'
        + pageOverlay(t, p) + '</svg></div>');
    }

    return '<!doctype html>\n<html><head><meta charset="utf-8">'
      + '<title>' + esc(name) + ' — ' + t.pageSize + ' × ' + t.sheets + ' sheets</title>'
      + '<style>' + CSS + '\n' + pageStyle + '</style></head>\n<body>\n'
      + pages.join('\n') + '\n</body></html>\n';
  }

  const api = {
    PAGE_SIZES, DEFAULTS, GHOST_OPACITY, paginate, layoutFor, renderPrintHtml,
    colLabel, contentGrid, mapPage, ghostLayer, pageOverlay, cropMarks, calibration,
  };

  E.tile = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
