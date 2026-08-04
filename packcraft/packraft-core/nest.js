/**
 * Panel layout on fabric, and what it costs (spec §5.8, §7.5).
 *
 * Shelf nesting: panels sorted tall-first, packed into rows across the roll
 * width. Deliberately simple -- the expensive panel here is the floor, whose
 * cost is set by its LENGTH not its area, so a cleverer packer would buy
 * almost nothing.
 *
 * THE RULE THAT MATTERS (§5.8): linear metres are bounded by the longest
 * single panel, not by total area. The floor is one ~2.3 m panel against a
 * 1.47 m roll, so it needs >= 2.3 linear metres however little area it uses,
 * and ~60% of that fabric is unavoidable waste. An earlier draft of the spec
 * quoted "~1.2 linear m" for the floor for exactly this reason and was wrong.
 * So every fabric reports max(areaBasedMetres, longestPanelLength).
 *
 * Three figures come back, because they say different things:
 *   areaBasedMetres  net area / roll width. A theoretical floor assuming
 *                    perfect packing -- never achievable, useful as a bound.
 *   longestMetres    the §5.8 rule: you cannot buy less than your longest
 *                    panel. Binds on the floor.
 *   packedMetres     what THIS layout actually needs.
 * `linearMetres` is the max, and `boundBy` says which won.
 *
 * Calibration note, and the ceiling on doing better. The reference design's
 * ten tube panels are 915-960 mm tall against a 1500 mm roll, so TWO NEVER
 * STACK: the panel count sets the shelf count whatever the packer does, and
 * the sum of panel widths alone is 7.13 m. First-fit across all open shelves
 * (implemented) buys back the strips' own shelf; beyond that, getting near
 * §16's 6.0 m estimate would need true no-fit-polygon nesting to interlock
 * the hook-shaped tip panels, whose bounding boxes are ~40% air. That is a
 * real piece of work and is not attempted here. The figure reported is what
 * this layout actually needs, never the area bound -- which assumes perfect
 * packing and is not achievable on any roll this narrow.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./constants.js');
    require('./panels.js');
  }
  const P = root.Packraft || (root.Packraft = {});

  /** Axis-aligned bounds of a polygon. */
  function bounds(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Lay parts out in shelves across `rollWidth`.
   *
   * Parts are placed with their long axis along the roll, which is what keeps
   * a 2.3 m floor from needing a 2.3 m-wide roll. Each part records the
   * translation that puts it in roll coordinates.
   */
  function shelfNest(parts, rollWidth, gap) {
    const g = gap == null ? 10 : gap;
    const placed = [];
    // Tall-first, then FIRST-FIT across every open shelf rather than only the
    // current one. On this hull that is the whole available win: two tube
    // panels never stack (2 x ~940 mm against a 1500 mm roll), so the panel
    // count sets the shelf count no matter what -- but each shelf leaves
    // ~535 mm spare, and first-fit drops the strips into those gaps instead
    // of giving them a shelf of their own.
    const order = parts.map((p) => ({ p, b: bounds(p.outline) }))
      .sort((a, b) => b.b.h - a.b.h);

    const shelves = []; // {x, width, used}
    let cursorX = 0;

    for (const item of order) {
      const { w, h } = item.b;
      if (h > rollWidth) {
        // Wider than the fabric. Report it rather than silently overlapping.
        placed.push({ id: item.p.id, role: item.p.role, w, h, x: 0, y: 0, dx: -item.b.x0, dy: -item.b.y0, overWidth: true });
        continue;
      }

      let shelf = null;
      for (const sh of shelves) {
        if (sh.used + h + g <= rollWidth && w <= sh.width) { shelf = sh; break; }
      }
      if (!shelf) {
        shelf = { x: cursorX, width: w, used: 0 };
        shelves.push(shelf);
        cursorX += w + g;
      }

      placed.push({
        id: item.p.id, role: item.p.role, w, h,
        x: shelf.x, y: shelf.used,
        dx: shelf.x - item.b.x0, dy: shelf.used - item.b.y0,
        overWidth: false,
      });
      shelf.used += h + g;
      if (w > shelf.width) shelf.width = w;
    }
    return placed;
  }

  /**
   * Fabric consumption for one fabric type.
   * @param {Array} parts panels sharing this fabric
   * @param {number} rollWidth usable roll width, mm
   */
  function consumption(parts, rollWidth, gap) {
    const placed = shelfNest(parts, rollWidth, gap);
    const netArea = parts.reduce((t, p) => t + Math.abs(P.panels.signedArea(p.outline)), 0);
    const longest = parts.reduce((m, p) => Math.max(m, bounds(p.outline).w), 0);
    const usedLength = placed.reduce((m, q) => Math.max(m, q.x + q.w), 0);

    // §5.8: whichever binds -- area packed across the roll, or the single
    // longest panel.
    const areaBasedMetres = netArea / rollWidth / 1000;
    const longestMetres = longest / 1000;
    const packedMetres = usedLength / 1000;
    const linearMetres = Math.max(areaBasedMetres, longestMetres, packedMetres);

    return {
      placed,
      netArea,
      netAreaM2: netArea / 1e6,
      longestPanel: longest,
      areaBasedMetres,
      longestMetres,
      packedMetres,
      linearMetres,
      boughtArea: (linearMetres * 1000 * rollWidth) / 1e6,
      wastePercent: 100 * (1 - netArea / (linearMetres * 1000 * rollWidth)),
      boundBy: linearMetres === longestMetres ? 'longest panel'
        : linearMetres === packedMetres ? 'this layout' : 'area',
      anyOverWidth: placed.some((q) => q.overWidth),
    };
  }

  /**
   * Nest a whole design. Tube panels and strips share the tube fabric; the
   * floor has its own (§7.1).
   */
  function nest(builtPanels, materials, opts) {
    const o = opts || {};
    const gap = o.gap == null ? 10 : o.gap;

    const tubeParts = builtPanels.tube.concat(builtPanels.strips);
    const floorParts = [floorPart(builtPanels.floor)];

    const tube = consumption(tubeParts, materials.tube.usableWidth, gap);
    const floor = consumption(floorParts, materials.floor.usableWidth, gap);

    const price = (fabric, c) => (fabric.pricePerMetre == null
      ? null : fabric.pricePerMetre * c.linearMetres);
    const mass = (fabric, c) => (fabric.gsm * c.netAreaM2);

    const tubeCost = price(materials.tube, tube);
    const floorCost = price(materials.floor, floor);

    return {
      tube, floor,
      tubeMass: mass(materials.tube, tube),
      floorMass: mass(materials.floor, floor),
      fabricMass: mass(materials.tube, tube) + mass(materials.floor, floor),
      // §5.8: a null price means the cost readout is hidden, never fabricated.
      cost: (tubeCost == null || floorCost == null) ? null : tubeCost + floorCost,
      currency: materials.currency,
      totalSeamLength: builtPanels.strips.reduce((t, s) => t + s.length, 0),
    };
  }

  /** The floor as a nestable part: its outline plus the tab band all round. */
  function floorPart(floor) {
    // The tab hangs outboard of the landing line, so the part's extent is the
    // floor polygon grown by the tab's developed reach. Using the band's own
    // developed width keeps this honest rather than offsetting the polygon.
    const reach = floor.bands.reduce((m, b) => {
      let w = 0;
      for (let i = 0; i < b.inner.length; i++) {
        w = Math.max(w, Math.hypot(b.outer[i][0] - b.inner[i][0], b.outer[i][1] - b.inner[i][1]));
      }
      return Math.max(m, w);
    }, 0);
    const grown = floor.outline.map((p) => {
      const n = Math.hypot(p[0], p[1]) || 1;
      return [p[0] + (reach * p[0]) / n, p[1] + (reach * p[1]) / n];
    });
    return { id: floor.id, role: 'floor', outline: grown, tabReach: reach };
  }

  const api = { nest, consumption, shelfNest, bounds, floorPart };

  P.nest = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
