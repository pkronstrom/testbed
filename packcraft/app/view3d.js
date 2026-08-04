/**
 * 3D preview (spec §13: preview3d hangs off the skeleton).
 *
 * The mesh is built from `develop`'s own 3D edge points -- the same numbers
 * the flat patterns come from. That is the point of §2's architecture: the
 * viewport cannot disagree with the pattern, because there is only one
 * geometry. A CAD pipeline computes them separately and they drift.
 *
 * Each frustum contributes a ruled strip between its two cut curves. Those
 * rulings are the cone generators, so the strip IS the developable surface,
 * not a subdivision approximation of it.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  const COLOR = {
    port: 0x4a7fb5,
    starboard: 0x3f6d9c,
    span: 0xc2823c,
  };

  function create(container) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14161a);

    const camera = new THREE.PerspectiveCamera(42, 1, 10, 40000);
    camera.up.set(0, 0, 1);              // the engine is z-up (§2b)
    camera.position.set(2600, -2900, 1900);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 120);

    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x2a2f38, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1500, -2200, 3000);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2000, 1800, 800);
    scene.add(fill);

    // Datum plane: z = 0 is the midship keel baseline (§3.2), not the
    // waterline -- the immersion solve is Phase 3.
    const grid = new THREE.GridHelper(6000, 24, 0x39414d, 0x262c35);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const boat = new THREE.Group();
    scene.add(boat);

    const materials = {};
    for (const role of Object.keys(COLOR)) {
      materials[role] = new THREE.MeshStandardMaterial({
        color: COLOR[role], roughness: 0.55, metalness: 0.05,
        side: THREE.DoubleSide, flatShading: false,
      });
    }
    const seamMaterial = new THREE.LineBasicMaterial({ color: 0x11151a });
    const floorLineMaterial = new THREE.LineBasicMaterial({ color: 0xe8b56b });

    function clear() {
      for (let i = boat.children.length - 1; i >= 0; i--) {
        const c = boat.children[i];
        boat.remove(c);
        if (c.geometry) c.geometry.dispose();
      }
    }

    /** Ruled strip between a panel's two developed cut curves. */
    function stripGeometry(panel) {
      const a = panel.startEdge3D, b = panel.endEdge3D;
      const n = a.length;
      const pos = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 6] = a[i][0]; pos[i * 6 + 1] = a[i][1]; pos[i * 6 + 2] = a[i][2];
        pos[i * 6 + 3] = b[i][0]; pos[i * 6 + 4] = b[i][1]; pos[i * 6 + 5] = b[i][2];
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) {
        const s0 = i * 2, e0 = i * 2 + 1, s1 = (i + 1) * 2, e1 = (i + 1) * 2 + 1;
        idx.push(s0, e0, e1, s0, e1, s1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    function lineGeometry(points) {
      const pos = new Float32Array(points.length * 3);
      points.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      return g;
    }

    function setDesign(design) {
      if (!design || !design.panels) return;
      clear();

      const floorLine = [];
      for (const panel of design.panels) {
        const mesh = new THREE.Mesh(stripGeometry(panel), materials[panel.role] || materials.port);
        mesh.userData.id = panel.id;
        mesh.userData.role = panel.role;
        boat.add(mesh);

        // Girth seams: the shared mitre curve between adjacent panels.
        boat.add(new THREE.Line(lineGeometry(panel.startEdge3D), seamMaterial));

        // The longitudinal seam sits at the floor line by construction
        // (§3.7), so index 0 of each edge -- the seam angle -- traces where
        // the floor lands. The floor panel itself is Phase 2.
        floorLine.push(panel.startEdge3D[0], panel.endEdge3D[0]);
      }
      if (floorLine.length) {
        floorLine.push(floorLine[0]);
        boat.add(new THREE.Line(lineGeometry(floorLine), floorLineMaterial));
      }
    }

    // Two-way hover link (§15). Picking uses a raycaster against the panel
    // meshes; highlighting swaps in an emissive material so it reads at any
    // camera angle.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered = null;
    let hoverHandler = null;

    const hotMaterial = new THREE.MeshStandardMaterial({
      color: 0xffc65c, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide,
    });

    function setHighlight(id) {
      if (hovered === id) return;
      hovered = id;
      for (const child of boat.children) {
        if (!child.isMesh) continue;
        child.material = child.userData.id === id
          ? hotMaterial
          : (materials[child.userData.role] || materials.port);
      }
    }

    renderer.domElement.addEventListener('pointermove', (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(boat.children.filter((c) => c.isMesh), false);
      const id = hits.length ? hits[0].object.userData.id : null;
      if (id !== hovered) {
        setHighlight(id);
        if (hoverHandler) hoverHandler(id);
      }
    });
    renderer.domElement.addEventListener('pointerleave', () => {
      setHighlight(null);
      if (hoverHandler) hoverHandler(null);
    });

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    let running = true;
    function tick() {
      if (!running) return;
      requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    }

    window.addEventListener('resize', resize);
    resize();
    tick();

    /**
     * Camera presets (§15): the three views a boat designer actually checks.
     * 'side' is the profile a photograph shows, 'top' the plan; distances are
     * sized so a ~3 m hull fills the frame at the 42 deg fov.
     */
    function setView(name) {
      const d = 4300;
      if (name === 'side') {
        camera.position.set(0, -d, 140);
        controls.target.set(0, 0, 140);
      } else if (name === 'top') {
        // A hair of y keeps the orbit out of the pole singularity.
        camera.position.set(0, -1, d);
        controls.target.set(0, 0, 0);
      } else {
        camera.position.set(2600, -2900, 1900);
        controls.target.set(0, 0, 120);
      }
      controls.update();
    }

    return {
      setDesign, resize, setView,
      highlight: setHighlight,
      onHover(fn) { hoverHandler = fn; },
      dispose() { running = false; window.removeEventListener('resize', resize); },
    };
  }

  P.view3d = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
