/**
 * Tiling for home printing (spec §8.1, §8.2).
 *
 * §8.1 is blunt about this: "the 1:1 failure mode is always the printer
 * driver, never the math". Everything here exists to catch a driver that
 * silently scaled the pattern, and to make sheets that tape together without
 * accumulating error.
 *
 * The defences, in the spec's own priority order, all implemented:
 *
 *   1. A 100.0 x 100.0 mm CALIBRATION SQUARE on every single page, with a
 *      10 mm ruler scale alongside. Measure it. If it reads 97 mm, stop.
 *   2. "Scale 100% / Actual Size — turn OFF Fit to Page" in every header.
 *   3. OVERLAP BANDS, not butt joints: 15 mm of duplicated content on shared
 *      edges with a trim line. Self-correcting and forgiving.
 *   4. A continuous 100 mm GRID across the whole pattern, drawn in content
 *      coordinates, so misalignment between sheets is visually obvious.
 *   5. REGISTRATION CROSSHAIRS at corners and edge midpoints, labelled by
 *      tile pair ("B3 - B4"), plus a thumbnail MAP page of the tile layout.
 *
 * FORMAT DEVIATION. The plan puts a hand-rolled mm-native PDF writer here
 * (§8.5, Phase 4). This emits a print-ready HTML document instead: one page
 * per tile, sized with `@page { size: <W>mm <H>mm; margin: 0 }`, each holding
 * an SVG windowed onto its own region of the drawing. A browser prints that at
 * true 1:1 with scaling off, which is the whole requirement, and it needs no
 * PDF writer and no dependency. The PDF path stays open for Phase 4 when the
 * cover sheet, QR permalink and PDF Info dictionary of §11 need somewhere to
 * live -- none of which an SVG can carry.
 *
 * Every page renders the SAME body SVG at a different viewBox, so content in
 * an overlap band is identical on both sheets by construction rather than by
 * a matching calculation that could drift.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./export-svg.js');
  }
  const P = root.Packraft || (root.Packraft = {});

  /** Page sizes in mm, portrait (§8.2). */
  const PAGE_SIZES = {
    A5: [148, 210],
    A4: [210, 297],
    Letter: [215.9, 279.4],
    Legal: [215.9, 355.6],
    A3: [297, 420],
    Tabloid: [279.4, 431.8],
    A1: [594, 841],
    A0: [841, 1189],
  };

  const DEFAULTS = {
    // A3 by default: A4 needs ~2.5x the sheets and most of the taping work
    // is proportional to sheet count (§8.2).
    pageSize: 'A3',
    landscape: false,
    margin: 8,        // mm, printer-safe non-printing edge
    overlap: 15,      // mm, §8.1
    gridStep: 100,    // mm, §8.1
    calibration: 100, // mm, §8.1 -- exactly 100.0
  };

  const n2 = (v) => (Math.abs(v) < 5e-3 ? '0' : v.toFixed(2));
  // Page dimensions go into CSS, where "210mm" reads better than "210.00mm".
  // Still deterministic, so the document stays byte-stable.
  const mm = (v) => (v.toFixed(2).replace(/\.?0+$/, '') || '0');
  const colLabel = (i) => {
    let s = '', n = i;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };

  /**
   * Split a drawing into pages.
   *
   * Each page prints `inner` mm of content; consecutive pages advance by
   * `inner - overlap`, so the last `overlap` mm of one page repeats as the
   * first `overlap` mm of the next.
   */
  function paginate(drawing, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const size = PAGE_SIZES[o.pageSize];
    if (!size) throw new Error(`tile: unknown page size "${o.pageSize}"`);
    const pageW = o.landscape ? size[1] : size[0];
    const pageH = o.landscape ? size[0] : size[1];

    const innerW = pageW - 2 * o.margin;
    const innerH = pageH - 2 * o.margin;
    if (innerW <= o.overlap || innerH <= o.overlap) {
      throw new Error('tile: page too small for the margin and overlap');
    }
    const stepX = innerW - o.overlap;
    const stepY = innerH - o.overlap;

    const cols = Math.max(1, Math.ceil((drawing.width - o.overlap) / stepX));
    const rows = Math.max(1, Math.ceil((drawing.height - o.overlap) / stepY));

    // A tile is worth printing only if content lands on it. On a roll layout
    // most tiles are empty fabric, and printing them is pure waste of paper
    // and taping. Tiles are still LABELLED by grid position, so the labels
    // encode where a sheet belongs even when its neighbours were dropped.
    const boxes = drawing.occupancy || null;
    const intersects = (x, y, w, h) => {
      if (!boxes) return true;
      for (const b of boxes) {
        if (x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h) return true;
      }
      return false;
    };

    const pages = [];
    let skipped = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = drawing.x + c * stepX;
        const py = drawing.y + r * stepY;
        if (!intersects(px, py, innerW, innerH)) { skipped++; continue; }
        pages.push({
          col: c, row: r,
          label: colLabel(c) + (r + 1),
          right: c < cols - 1 && intersects(drawing.x + (c + 1) * stepX, py, innerW, innerH)
            ? colLabel(c + 1) + (r + 1) : null,
          below: r < rows - 1 && intersects(px, drawing.y + (r + 1) * stepY, innerW, innerH)
            ? colLabel(c) + (r + 2) : null,
          x: px, y: py,
          w: innerW, h: innerH,
        });
      }
    }
    return {
      pages, cols, rows, skipped, pageW, pageH, innerW, innerH, stepX, stepY,
      overlap: o.overlap, margin: o.margin, gridStep: o.gridStep,
      calibration: o.calibration, pageSize: o.pageSize, landscape: !!o.landscape,
    };
  }

  const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #eee; }
  .page {
    position: relative; overflow: hidden; background: #fff;
    page-break-after: always; break-after: page;
    margin: 0 auto 8mm; box-shadow: 0 1px 4px rgba(0,0,0,.25);
  }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .page > svg { position: absolute; left: 0; top: 0; }
  .hdr {
    position: absolute; left: 3mm; top: 2mm; right: 3mm;
    font: 3mm/1.3 Helvetica, Arial, sans-serif; color: #000;
    display: flex; justify-content: space-between; z-index: 2;
  }
  .hdr b { font-size: 4mm; }
  .warn { color: #c0392b; font-weight: 600; }
  @media print {
    html, body { background: #fff; }
    .page { margin: 0; box-shadow: none; }
  }
`;

  /** Overlay drawn on every page, in PAGE millimetres. */
  function pageOverlay(t, page) {
    const g = [];
    const m = t.margin;
    const trimX = m + t.stepX;
    const trimY = m + t.stepY;

    // Sheet identity, large enough to read on a floor covered in sheets.
    g.push(`<text class="tilelab" x="${n2(t.pageW - m)}" y="${n2(t.pageH - m)}" `
      + `text-anchor="end">${page.label}</text>`);

    // Overlap band + trim line (§8.1 defence 3).
    if (page.right) {
      g.push(`<line class="trim" x1="${n2(trimX)}" y1="0" x2="${n2(trimX)}" y2="${n2(t.pageH)}"/>`);
      g.push(`<rect class="band" x="${n2(trimX)}" y="0" width="${n2(t.overlap)}" height="${n2(t.pageH)}"/>`);
    }
    if (page.below) {
      g.push(`<line class="trim" x1="0" y1="${n2(trimY)}" x2="${n2(t.pageW)}" y2="${n2(trimY)}"/>`);
      g.push(`<rect class="band" x="0" y="${n2(trimY)}" width="${n2(t.pageW)}" height="${n2(t.overlap)}"/>`);
    }

    // Registration crosshairs at the trim line's ends and midpoint, labelled
    // by the tile pair they join (§8.1 defence 5).
    const cross = (x, y, text) => {
      g.push(`<g class="reg"><circle cx="${n2(x)}" cy="${n2(y)}" r="2"/>`
        + `<path d="M ${n2(x - 5)} ${n2(y)} L ${n2(x + 5)} ${n2(y)} M ${n2(x)} ${n2(y - 5)} L ${n2(x)} ${n2(y + 5)}"/></g>`);
      if (text) g.push(`<text class="reglab" x="${n2(x + 2)}" y="${n2(y - 2)}">${text}</text>`);
    };
    if (page.right) {
      cross(trimX, m, `${page.label}-${page.right}`);
      cross(trimX, m + t.innerH / 2, '');
      cross(trimX, m + t.innerH, '');
    }
    if (page.below) {
      cross(m, trimY, `${page.label}-${page.below}`);
      cross(m + t.innerW / 2, trimY, '');
      cross(m + t.innerW, trimY, '');
    }

    // THE CALIBRATION SQUARE (§8.1 defence 1) -- exactly 100.0 mm, bottom
    // left, with a 10 mm ruler along its lower edge.
    const c = t.calibration;
    const cx = m + 4, cy = t.pageH - m - c - 4;
    g.push(`<rect class="cal" x="${n2(cx)}" y="${n2(cy)}" width="${n2(c)}" height="${n2(c)}"/>`);
    for (let i = 0; i <= c; i += 10) {
      const h = i % 50 === 0 ? 5 : 2.5;
      g.push(`<line class="calTick" x1="${n2(cx + i)}" y1="${n2(cy + c)}" x2="${n2(cx + i)}" y2="${n2(cy + c - h)}"/>`);
    }
    g.push(`<text class="callab" x="${n2(cx + 2)}" y="${n2(cy + c - 3)}">`
      + `${c.toFixed(1)} mm — measure me. If this is not ${c.toFixed(0)} mm, the print is scaled: do not cut.</text>`);

    return g.join('\n');
  }

  const OVERLAY_STYLE = `
    .trim { stroke: #c0392b; stroke-width: 0.3; stroke-dasharray: 3 2; }
    .band { fill: rgba(192,57,43,0.05); }
    .reg { stroke: #c0392b; stroke-width: 0.3; fill: none; }
    .reglab { font: 2.6px Helvetica, Arial, sans-serif; fill: #c0392b; }
    .cal { fill: none; stroke: #c0392b; stroke-width: 0.5; }
    .calTick { stroke: #c0392b; stroke-width: 0.3; }
    .callab { font: 3px Helvetica, Arial, sans-serif; fill: #c0392b; }
    .grid { stroke: #cfd6e0; stroke-width: 0.25; fill: none; }
    .maplab { font: 3px Helvetica, Arial, sans-serif; fill: #555; }
    .tilelab { font: 700 10px Helvetica, Arial, sans-serif; fill: #c0392b; opacity: 0.55; }
  `;

  /** The continuous 100 mm grid, in CONTENT coordinates (§8.1 defence 4). */
  function contentGrid(drawing, step) {
    const g = [];
    const x0 = Math.floor(drawing.x / step) * step;
    const y0 = Math.floor(drawing.y / step) * step;
    const x1 = drawing.x + drawing.width;
    const y1 = drawing.y + drawing.height;
    for (let x = x0; x <= x1; x += step) {
      g.push(`<line class="grid" x1="${n2(x)}" y1="${n2(y0)}" x2="${n2(x)}" y2="${n2(y1)}"/>`);
    }
    for (let y = y0; y <= y1; y += step) {
      g.push(`<line class="grid" x1="${n2(x0)}" y1="${n2(y)}" x2="${n2(x1)}" y2="${n2(y)}"/>`);
    }
    return g.join('\n');
  }

  /**
   * The thumbnail map page (§8.1 defence 5).
   *
   * Tiles are labelled on the grid AXES, not individually: at 288 tiles a
   * label per rectangle is an unreadable smear, and the axes carry the same
   * information at any density. Sheets that were dropped as blank simply do
   * not appear, which is itself useful -- the map is the taping plan.
   */
  function mapPage(t, drawing) {
    const availW = t.pageW - 2 * t.margin - 14;
    const availH = t.pageH - 2 * t.margin - 34;
    const scale = Math.min(availW / drawing.width, availH / drawing.height);
    const ox = t.margin + 12, oy = t.margin + 32;
    const px = (x) => ox + (x - drawing.x) * scale;
    const py = (y) => oy + (y - drawing.y) * scale;
    const g = [];

    g.push(`<rect x="${n2(px(drawing.x))}" y="${n2(py(drawing.y))}" `
      + `width="${n2(drawing.width * scale)}" height="${n2(drawing.height * scale)}" `
      + 'fill="none" stroke="#bbb" stroke-width="0.3"/>');

    for (const p of t.pages) {
      g.push(`<rect x="${n2(px(p.x))}" y="${n2(py(p.y))}" `
        + `width="${n2(p.w * scale)}" height="${n2(p.h * scale)}" `
        + 'fill="rgba(192,57,43,0.08)" stroke="#c0392b" stroke-width="0.2"/>');
    }

    // Column letters along the top, row numbers down the left -- THINNED so
    // they cannot collide. At 47 columns the tiles are ~9 mm apart on the map
    // while a two-letter label is ~4 mm wide, and past column Z they overlap
    // into an unreadable smear. Label every Nth instead, N chosen from the
    // actual spacing, always including the first and last that exist.
    const LABEL_MM = 4.2;   // rough width of a two-character label at 3 mm
    const usedCols = [];
    for (let c = 0; c < t.cols; c++) if (t.pages.some((p) => p.col === c)) usedCols.push(c);
    const usedRows = [];
    for (let r = 0; r < t.rows; r++) if (t.pages.some((p) => p.row === r)) usedRows.push(r);

    const everyCol = Math.max(1, Math.ceil(LABEL_MM / Math.max(t.stepX * scale, 0.01)));
    const everyRow = Math.max(1, Math.ceil(LABEL_MM / Math.max(t.stepY * scale, 0.01)));

    /** Every Nth entry, plus the last one when it will not crowd its neighbour. */
    const keep = (list, every) => {
      const out = [];
      for (let i = 0; i < list.length; i += every) out.push(i);
      const last = list.length - 1;
      if (out[out.length - 1] !== last && last - out[out.length - 1] >= every / 2) out.push(last);
      return out.map((i) => list[i]);
    };

    for (const c of keep(usedCols, everyCol)) {
      g.push(`<text class="maplab" x="${n2(px(drawing.x + c * t.stepX) + (t.innerW * scale) / 2)}" `
        + `y="${n2(oy - 2)}" text-anchor="middle">${colLabel(c)}</text>`);
    }
    for (const r of keep(usedRows, everyRow)) {
      g.push(`<text class="maplab" x="${n2(ox - 3)}" `
        + `y="${n2(py(drawing.y + r * t.stepY) + (t.innerH * scale) / 2)}" text-anchor="end">${r + 1}</text>`);
    }
    return g.join('\n');
  }

  /**
   * A complete print-ready document.
   * @param {object} design {params, skeleton, panels, nest}
   */
  function renderPrintHtml(design, opts) {
    const drawing = P.exportSvg.buildBody(design);
    const t = paginate(drawing, opts);
    const grid = contentGrid(drawing, t.gridStep);

    const pageStyle = `.page { width: ${mm(t.pageW)}mm; height: ${mm(t.pageH)}mm; }`
      + `\n@page { size: ${mm(t.pageW)}mm ${mm(t.pageH)}mm; margin: 0; }`;

    const head = (extra) => `<div class="hdr"><span><b>Packraft cutting pattern</b> — `
      + `<span class="warn">print at 100% / Actual Size — turn OFF "Fit to Page"</span></span>`
      + `<span>${extra}</span></div>`;

    const pages = [];

    // Map page first, so it is the first thing out of the printer.
    pages.push(`<div class="page">${head(`${t.pages.length} tiles · ${t.pageSize}`)}`
      + `<svg width="${mm(t.pageW)}mm" height="${mm(t.pageH)}mm" viewBox="0 0 ${mm(t.pageW)} ${mm(t.pageH)}" `
      + `xmlns="http://www.w3.org/2000/svg"><style>${OVERLAY_STYLE}</style>`
      // Two short lines rather than one long one: at 5 mm text a 210 mm page
      // holds about 60 characters, and the first draft ran off the edge.
      + `<text x="${n2(t.margin)}" y="${n2(t.margin + 14)}" font-size="5" fill="#111">`
      + `Tile map — print ${t.pages.length} sheets (${t.skipped} blank tiles omitted).</text>`
      + `<text x="${n2(t.margin)}" y="${n2(t.margin + 21)}" font-size="4" fill="#444">`
      + `Tape by column letter and row number, aligning the red crosshairs.</text>`
      + mapPage(t, drawing) + '</svg></div>');

    for (const p of t.pages) {
      pages.push(`<div class="page">${head(`tile ${p.label}`)}`
        + `<svg width="${mm(t.pageW)}mm" height="${mm(t.pageH)}mm" `
        + `viewBox="0 0 ${mm(t.pageW)} ${mm(t.pageH)}" xmlns="http://www.w3.org/2000/svg">`
        + `<style>${drawing.style}${OVERLAY_STYLE}</style>`
        // Content, windowed to this tile and shifted into the page margin.
        + `<g transform="translate(${n2(t.margin)} ${n2(t.margin)})">`
        + `<svg width="${n2(t.innerW)}" height="${n2(t.innerH)}" `
        + `viewBox="${n2(p.x)} ${n2(p.y)} ${n2(p.w)} ${n2(p.h)}">${grid}\n${drawing.body}</svg></g>`
        + pageOverlay(t, p)
        + '</svg></div>');
    }

    return `<!doctype html>\n<html><head><meta charset="utf-8">`
      + `<title>Packraft cutting pattern — ${t.pageSize} × ${t.pages.length} tiles</title>`
      + `<style>${CSS}\n${pageStyle}</style></head>\n<body>\n${pages.join('\n')}\n</body></html>\n`;
  }

  const api = { paginate, renderPrintHtml, PAGE_SIZES, DEFAULTS, colLabel };

  P.tile = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
