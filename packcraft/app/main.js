/**
 * Wiring: store -> 3D view, rail, issues, metrics.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft;

  function main() {
    const store = P.state;
    const view = P.view3d.create(document.getElementById('view3d'));
    const flat = P.view2d.create(document.getElementById('view2d'));
    // Scripting/debug handle -- lets tests and tooling drive the camera.
    P.app = { store, view, flat };

    // Camera preset buttons, overlaid on the 3D pane.
    const camBar = document.createElement('div');
    camBar.id = 'cambar';
    for (const [name, label] of [['three-quarter', '¾'], ['side', 'Side'], ['top', 'Top']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = 'Camera: ' + name;
      b.addEventListener('click', () => view.setView(name));
      camBar.appendChild(b);
    }
    document.getElementById('view3d').appendChild(camBar);

    // Viewport mode. 'split' shows the 3D boat beside the flat patterns,
    // which is where the hover link earns its keep.
    const MODES = ['3d', 'hull', 'panels', 'split'];
    let viewMode = '3d';
    function setViewMode(m) {
      if (MODES.indexOf(m) < 0) m = 'split';
      viewMode = m;
      document.body.setAttribute('data-view', m);
      // Carried in the hash alongside the design, so a shared link can open
      // straight onto the pattern rather than the 3D boat.
      try {
        const keep = location.hash.replace(/(^#|&)view=[a-z0-9]+/i, '').replace(/^#?&?/, '');
        history.replaceState(null, '', '#view=' + m + (keep ? '&' + keep : ''));
      } catch (e) { /* hash is a convenience, never a dependency */ }
      for (const b of document.querySelectorAll('.mode')) b.classList.toggle('on', b.dataset.mode === m);
      flat.setMode(m === 'hull' ? 'hull' : 'panels');
      // The panes resize when their siblings hide, so both views must re-fit.
      requestAnimationFrame(() => { view.resize(); flat.resize(); });
    }
    for (const b of document.querySelectorAll('.mode')) {
      b.addEventListener('click', () => setViewMode(b.dataset.mode));
    }

    // Hover link, both ways (§15).
    flat.onHover((id) => view.highlight(id));
    view.onHover((id) => flat.highlight(id));
    const rail = P.ui.build(store, document.getElementById('rail'));
    const issuesEl = document.getElementById('issues');

    // Right-hand metrics rail (§15). Clicking a metric jumps to the parameter
    // that moves it -- the same link a red issue offers, available before
    // anything has gone wrong.
    const metricsEl = document.getElementById('metrics');
    const metrics = P.rail.build(metricsEl, (field) => rail.focus(field));

    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');

    store.subscribe((design, raw) => {
      view.setDesign(design);
      flat.setDesign(design);
      rail.refresh(design, raw);
      P.ui.renderIssues(design, issuesEl, (field) => rail.focus(field));
      P.ui.renderMetrics(design);
      metrics.update(design && design.analysis, P.constants);
      // Dimmed while the analysis catches up with the geometry, so a number
      // that has not been recomputed yet never reads as current.
      metricsEl.classList.toggle('stale', !!(design && design.analysisStale));
      undoBtn.disabled = !store.canUndo();
      redoBtn.disabled = !store.canRedo();
    });

    undoBtn.addEventListener('click', () => store.undo());
    redoBtn.addEventListener('click', () => store.redo());
    document.getElementById('btn-reset').addEventListener('click', () => {
      store.load(P.params.defaults());
    });

    // §12's "enter measured hull values and back-fit", as one click. Keeps the
    // current LOA and interior length and replaces everything the photograph
    // could actually measure.
    const diyBtn = document.getElementById('btn-diy');
    diyBtn.addEventListener('click', () => {
      const raw = store.raw();
      if (!raw) return;
      store.load(P.params.applyDiy(raw));
      diyBtn.textContent = 'Applied';
      setTimeout(() => { diyBtn.textContent = 'DIY Packraft'; }, 1600);
    });

    const measuredBtn = document.getElementById('btn-measured');
    measuredBtn.addEventListener('click', () => {
      const raw = store.raw();
      if (!raw) return;
      store.load(P.params.applyMeasured(raw));
      measuredBtn.textContent = 'Applied';
      setTimeout(() => { measuredBtn.textContent = 'Measured hull'; }, 1600);
    });

    const linkBtn = document.getElementById('btn-link');
    linkBtn.addEventListener('click', async () => {
      const url = await store.permalink();
      try {
        await navigator.clipboard.writeText(url);
        linkBtn.textContent = 'Copied';
      } catch (e) {
        // Clipboard access is refused from file:// in most browsers; the
        // address bar already carries the same payload.
        linkBtn.textContent = 'In address bar';
      }
      setTimeout(() => { linkBtn.textContent = 'Copy link'; }, 1600);
    });

    const exportBtn = document.getElementById('btn-export');
    exportBtn.addEventListener('click', () => {
      const design = store.design();
      if (!design || !design.built) {
        exportBtn.textContent = 'Not ready';
        setTimeout(() => { exportBtn.textContent = 'Export blueprint'; }, 1600);
        return;
      }
      const svg = P.exportSvg.render({
        params: design.params, skeleton: design.skeleton,
        panels: design.built, nest: design.nest,
      });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'packraft-blueprint.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      exportBtn.textContent = 'Downloaded';
      setTimeout(() => { exportBtn.textContent = 'Export blueprint'; }, 1600);
    });

    // Tiled print. Opened in a new tab rather than downloaded, because the
    // whole point is to reach the browser's print dialogue -- where the user
    // must turn scaling off before the calibration square means anything.
    const printBtn = document.getElementById('btn-print');
    printBtn.addEventListener('click', () => {
      const design = store.design();
      if (!design || !design.built) {
        printBtn.textContent = 'Not ready';
        setTimeout(() => { printBtn.textContent = 'Print tiled'; }, 1600);
        return;
      }
      const pageSize = document.getElementById('page-size').value;
      const html = P.tile.renderPrintHtml({
        params: design.params, skeleton: design.skeleton,
        panels: design.built, nest: design.nest,
      }, { pageSize });
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      if (!w) {
        // Popup blocked, or file:// restrictions. Fall back to a download.
        const a = document.createElement('a');
        a.href = url;
        a.download = `packraft-pattern-${pageSize}.html`;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
      else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); store.redo(); }
    });

    const wanted = /(?:^#|&)view=([a-z0-9]+)/i.exec(location.hash);
    setViewMode(wanted ? wanted[1].toLowerCase() : 'split');
    store.boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
