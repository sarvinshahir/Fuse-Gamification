// FuseScene: shared Three.js world reused across every wizard step.
// One renderer/camera/ground; steps toggle which group is visible and
// drive small animations (day/night, scenery pop-in).
window.FuseScene = (function () {
  let renderer, camera, scene, canvasEl;
  let ambLight, sunLight;
  let toonGradient;
  let groups = {};
  let stage; // shared rotated/scaled parent for the city and depot groups
  let dayPhase = 0, dayPhaseTarget = 0;
  let cameraZoom = 1, cameraZoomTarget = 1; // pulls the camera back as avg. distance/day grows
  const cameraTarget = new THREE.Vector3(0, 2, 0); // point the camera orbits around
  let cameraRadius = 24, cameraHeight = 16; // derived from the initial camera.position in init()
  let cameraAngle = 0, cameraAngleTarget = 0; // orbit azimuth around cameraTarget, in radians
  let isDraggingCamera = false;
  let lastDragX = 0;
  let raycaster = new THREE.Raycaster();
  let groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let mouseNDC = new THREE.Vector2(1e6, 1e6);
  let hitPt = new THREE.Vector3();
  let truckScale = 0.75;

  const spacingX = 4;
  const spacingZ = 10;
  
  let truckRows = 1;
  let truckColumns = 1;

  const scaleTweens = [];  // { obj, elapsed, duration, from, to }
  let trucks; // THREE.Group of the currently spawned buses, child of stage (not groups.city/depot, so it isn't hidden when either toggles)
  let splashCar = null;
  const exhaustPuffs = []; // { mesh, age, maxAge, vel }

  // ---------- material / mesh factories ----------
  function makeToonGradient(steps) {
    const data = new Uint8Array(steps);
    for (let i = 0; i < steps; i++) data[i] = Math.round((i / (steps - 1)) * 255);
    const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  function toonMat(color, opts) {
    return new THREE.MeshToonMaterial(Object.assign({ color, gradientMap: toonGradient }, opts));
  }

  function mats() {
    return {
      white: toonMat(0xffffff),
      dark: toonMat(0x2b2f3a),
      glass: toonMat(0x5fd4ff, { transparent: true, opacity: 0.55 }),
      wheel: toonMat(0x161616),
    };
  }

  // ---------- exhaust puffs ----------
  const EXHAUST_GEO = new THREE.SphereGeometry(0.14, 6, 6);
  function spawnExhaustPuff(worldPos, scaleMul = 3) {
    const mesh = new THREE.Mesh(
      EXHAUST_GEO,
      new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.45, depthWrite: false })
    );
    mesh.position.copy(worldPos);
    mesh.scale.setScalar(15 * scaleMul);
    scene.add(mesh);
    scaleMul *= 3;
    exhaustPuffs.push({
      mesh,
      age: 0,
      maxAge: 300 + Math.random() * 400,
      scaleMul,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 0.0025,
        0.001 + Math.random() * 0.0025,
        (Math.random() - 0.5) * 0.0025
      ),
    });
  }

  function updateExhaustPuffs(dtMs) {
    for (let i = exhaustPuffs.length - 1; i >= 0; i--) {
      const p = exhaustPuffs[i];
      p.age += dtMs;
      const t = Math.min(p.age / p.maxAge, 1);
      p.mesh.position.addScaledVector(p.vel, dtMs);
      p.mesh.scale.setScalar((0.4 + t * 0.9) * p.scaleMul);
      p.mesh.material.opacity = 0.5 * (1 - t);
      if (t >= 1) {
        scene.remove(p.mesh);
        p.mesh.material.dispose();
        exhaustPuffs.splice(i, 1);
      }
    }
  }

  // spawns a puff at a truck's tailpipe on a randomized interval; skips
  // trucks that are actively charging (a diesel puff would contradict the
  // battery-fill visual) or not yet part of a visible group.
  function updateTruckExhaust(truck, dtMs) {
    if (!truck.userData.exhaustPoint || truck.userData.bar) return;
    truck.userData.exhaustTimer = (truck.userData.exhaustTimer || 0) - dtMs;
    if (truck.userData.exhaustTimer <= 0) {
      const worldPos = truck.localToWorld(truck.userData.exhaustPoint.clone());
      spawnExhaustPuff(worldPos, truck.getWorldScale(new THREE.Vector3()).x);
      truck.userData.exhaustTimer = 10 + Math.random() * 100;
    }
  }

  // Full-size conventional school bus: flat front nose, black roof cap over
  // the windshield, tandem dual-wheel rear axles (matches the ~72-77 capacity photo).
  // isEV swaps the diesel livery/tailpipe for an electric-blue body + charge port.
  // Full-size conventional school bus: long flat-nose hood (one continuous
  // yellow body/hood box, per the reference photo), black grille/bumper face,
  // large West Coast-style mirrors, a paneled entry door, a row of individual
  // window bays with two black beltline stripes, and a single rear dual-wheel
  // axle (matches the ~77 capacity photo). isEV swaps the tailpipe for a
  // charge port.
  function makeFullSizeBus(scale = 1, isEV = false) {
    const g = new THREE.Group();
    const m = mats();
    const bus = toonMat(isEV ? 0x2a7de1 : 0xffcc00);
    const lamp = toonMat(0xfff6cc);
    const amber = toonMat(0xffb300);
    const length = 6.6;
    const bodyW = 1.9;

    const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, 1.55, length), bus);
    body.position.y = 1.08;
    body.castShadow = true;
    g.add(body);

    // small amber roof-corner lights (no signage board — just the marker lights)
    [-0.5, 0.5].forEach(x => {
      const roofLight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.08), amber);
      roofLight.position.set(x, 1.87, length / 2 - 0.1);
      g.add(roofLight);
    });

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.58, 0.06), m.glass);
    windshield.position.set(0, 1.25, length / 2 + 0.02);
    g.add(windshield);

    // entry door, right behind the windshield/cowl
    const doorZoneLength = 1.1;
    const doorZoneFrontZ = length / 2 - 0.05;
    const doorCenterZ = doorZoneFrontZ - doorZoneLength / 2;
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.15, doorZoneLength * 0.75), m.dark);
    doorFrame.position.set(bodyW / 2 + 0.01, 1.0, doorCenterZ);
    g.add(doorFrame);
    const doorGlass = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, doorZoneLength * 0.5), m.glass);
    doorGlass.position.set(bodyW / 2 + 0.02, 1.4, doorCenterZ);
    g.add(doorGlass);

    // row of individual window bays behind the door, back toward the rear cap
    const rearMargin = 0.5;
    const windowZoneFrontZ = doorZoneFrontZ - doorZoneLength;
    const windowZoneLength = windowZoneFrontZ - (-length / 2 + rearMargin);
    const windowCount = 9;
    const windowSpacing = windowZoneLength / windowCount;
    for (let i = 0; i < windowCount; i++) {
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW + 0.02, 0.48, windowSpacing * 0.78),
        m.glass
      );
      win.position.set(0, 1.35, windowZoneFrontZ - windowSpacing * (i + 0.5));
      g.add(win);
    }

    // two black beltline stripes running the length of the bus
    [1.0, 0.62].forEach(y => {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(bodyW + 0.02, 0.055, length - 0.9), m.dark);
      stripe.position.set(0, y, -0.15);
      g.add(stripe);
    });

    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.15), m.dark);
    grille.position.set(0, 0.55, length / 2 + 0.1);
    g.add(grille);

    [-0.68, 0.68].forEach(x => {
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.05), lamp);
      headlight.position.set(x, 0.65, length / 2 + 0.12);
      g.add(headlight);
      const signal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.05), amber);
      signal.position.set(x, 0.45, length / 2 + 0.12);
      g.add(signal);
      const marker = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.05), amber);
      marker.position.set(x, 1.0, length / 2 + 0.12);
      g.add(marker);
    });

    const bumperFront = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.28, 0.2), m.dark);
    bumperFront.position.set(0, 0.3, length / 2 + 0.18);
    g.add(bumperFront);
    const bumperRear = bumperFront.clone();
    bumperRear.position.z = -length / 2 - 0.08;
    g.add(bumperRear);

    if (isEV) {
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.05), toonMat(0x33dd66));
      port.position.set(0.96, 0.9, -length / 2 + 1.1);
      g.add(port);
    } else {
      const tailpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8), m.dark);
      tailpipe.rotation.x = Math.PI / 2;
      tailpipe.position.set(-0.85, 0.32, -length / 2 - 0.18);
      g.add(tailpipe);
      g.userData.exhaustPoint = new THREE.Vector3(-0.85, 0.32, -length / 2 - 0.32);
    }

    // large West Coast-style mirrors on long arms off the cowl
    [-1, 1].forEach(sign => {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), m.dark);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(sign * 1.15, 1.55, length / 2 - 0.05);
      g.add(arm);
      const mirrorHead = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.4, 0.26), m.dark);
      mirrorHead.position.set(sign * 1.42, 1.5, length / 2 - 0.05);
      g.add(mirrorHead);
    });

    // front axle: single wheels
    const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 14);
    [-0.95, 0.95].forEach(x => {
      const w = new THREE.Mesh(wheelGeo, m.wheel);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.4, length / 2 - 0.9);
      w.castShadow = true;
      g.add(w);
    });

    // rear axle: wider cylinders to read as dual wheels
    const dualWheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.52, 14);
    [-1, 1].forEach(sign => {
      const w = new THREE.Mesh(dualWheelGeo, m.wheel);
      w.rotation.z = Math.PI / 2;
      w.position.set(sign * 0.95, 0.4, -length / 2 + 1.3);
      w.castShadow = true;
      g.add(w);
    });

    g.userData.isEV = isEV;
    g.userData.busType = 'full';
    g.scale.setScalar(scale);
    return g;
  }

  // Cutaway/mid-size bus: van-style cab (dark hood + sloped windshield) with a
  // shorter, taller passenger box behind it and a single rear axle (matches the
  // ~26 capacity "Mid Bus" photo). isEV swaps the diesel livery/tailpipe for an
  // electric-blue body + charge port, same as the full-size bus.
  // Cutaway/mid-size bus: Chevy-van cutaway front (black hood/fascia, chrome
  // grille strip, headlight/signal pods), tall yellow passenger box with a
  // paneled door + 4 window bays, black roof "SCHOOL BUS" sign band with
  // amber beacons, a black rub rail, and a single rear axle (matches the
  // ~26 capacity "Mid Bus" photo). isEV swaps the tailpipe for a charge port.
  function makeCutawayBus(scale = 1, isEV = false) {
    const g = new THREE.Group();
    const m = mats();
    const bus = toonMat(isEV ? 0x2a7de1 : 0xffcc00);
    const chrome = toonMat(0xd8dde2);
    const lamp = toonMat(0xfff6cc);
    const amber = toonMat(0xffb300);

    const hoodLength = 1.2;
    const bodyLength = 3.3;
    const totalLength = hoodLength + bodyLength;
    const front = totalLength / 2;
    const bodyW = 1.92;
    const bodyFrontZ = front - hoodLength;
    const bodyCenterZ = bodyFrontZ - bodyLength / 2;

    // ---- passenger box ----
    const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, 1.6, bodyLength), bus);
    body.position.set(0, 1.1, bodyCenterZ);
    body.castShadow = true;
    g.add(body);

    // black "SCHOOL BUS" sign band across the front of the roof
    const signBandZ = bodyFrontZ - 0.15;
    const roofCap = new THREE.Mesh(new THREE.BoxGeometry(bodyW + 0.02, 0.22, 0.4), m.dark);
    roofCap.position.set(0, 1.95, signBandZ);
    g.add(roofCap);

    // roof electronics box (crossing-arm controller / camera dome)
    const roofBox = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.18), m.dark);
    roofBox.position.set(-0.55, 2.02, signBandZ);
    g.add(roofBox);

    // amber roof beacons flanking the sign band
    [-0.15, 0.15].forEach(x => {
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.08), amber);
      beacon.position.set(x, 2.02, signBandZ);
      g.add(beacon);
    });

    // black rub rail running the length of the bus (stops short of the nose)
    const rubRail = new THREE.Mesh(new THREE.BoxGeometry(bodyW + 0.04, 0.12, totalLength - 0.3), m.dark);
    rubRail.position.set(0, 0.55, -0.15);
    g.add(rubRail);

    // door, then a strip of window bays, front to back along the cabin
    const doorZoneLength = 0.85;
    const doorCenterZ = bodyFrontZ - doorZoneLength / 2;
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.15, doorZoneLength * 0.8), m.dark);
    doorFrame.position.set(bodyW / 2 + 0.01, 1.0, doorCenterZ);
    g.add(doorFrame);
    const doorGlass = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, doorZoneLength * 0.55), m.glass);
    doorGlass.position.set(bodyW / 2 + 0.02, 1.4, doorCenterZ);
    g.add(doorGlass);

    const windowZoneLength = bodyLength - doorZoneLength - 0.15;
    const windowCount = 4;
    const windowSpacing = windowZoneLength / windowCount;
    const windowZoneFrontZ = bodyFrontZ - doorZoneLength;
    for (let i = 0; i < windowCount; i++) {
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW + 0.02, 0.42, windowSpacing * 0.78),
        m.glass
      );
      win.position.set(0, 1.4, windowZoneFrontZ - windowSpacing * (i + 0.5));
      g.add(win);
    }

    // ---- Chevy cutaway hood: two stacked volumes hint at the sloped nose ----
    const hoodCowl = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.85, hoodLength * 0.6), m.dark);
    hoodCowl.position.set(0, 0.75, bodyFrontZ + hoodLength * 0.3);
    hoodCowl.castShadow = true;
    g.add(hoodCowl);
    const hoodNose = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, hoodLength * 0.55), m.dark);
    hoodNose.position.set(0, 0.5, front - hoodLength * 0.275);
    g.add(hoodNose);

    const chromeStrip = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.05), chrome);
    chromeStrip.position.set(0, 0.82, front + 0.02);
    g.add(chromeStrip);

    [-0.68, 0.68].forEach(x => {
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.04), lamp);
      headlight.position.set(x, 0.62, front + 0.03);
      g.add(headlight);
      const signal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.04), amber);
      signal.position.set(x, 0.42, front + 0.03);
      g.add(signal);
    });

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.06), m.glass);
    windshield.position.set(0, 1.25, bodyFrontZ + 0.05);
    windshield.rotation.x = -0.3;
    g.add(windshield);

    const bumperFront = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.24, 0.15), m.dark);
    bumperFront.position.set(0, 0.28, front + 0.09);
    g.add(bumperFront);
    const bumperRear = new THREE.Mesh(new THREE.BoxGeometry(bodyW - 0.05, 0.24, 0.15), m.dark);
    bumperRear.position.set(0, 0.28, -front - 0.05);
    g.add(bumperRear);

    if (isEV) {
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.05), toonMat(0x33dd66));
      port.position.set(bodyW / 2 + 0.03, 0.85, bodyCenterZ);
      g.add(port);
    } else {
      const tailpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.2, 8), m.dark);
      tailpipe.rotation.x = Math.PI / 2;
      tailpipe.position.set(-0.8, 0.28, -front - 0.15);
      g.add(tailpipe);
      g.userData.exhaustPoint = new THREE.Vector3(-0.8, 0.28, -front - 0.28);
    }

    // tow mirrors on stalks off the cab, near the windshield base
    [-1, 1].forEach(sign => {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 6), m.dark);
      stalk.rotation.z = Math.PI / 2;
      stalk.position.set(sign * 1.05, 1.15, bodyFrontZ + 0.15);
      g.add(stalk);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.2), m.dark);
      mirror.position.set(sign * 1.24, 1.15, bodyFrontZ + 0.15);
      g.add(mirror);
    });

    const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14);
    [front - hoodLength * 0.7, -front + 0.85].forEach(z => {
      [-0.9, 0.9].forEach(x => {
        const w = new THREE.Mesh(wheelGeo, m.wheel);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, 0.36, z);
        w.castShadow = true;
        g.add(w);
      });
    });

    g.userData.isEV = isEV;
    g.userData.busType = 'cutaway';
    g.scale.setScalar(scale);
    return g;
  }

  function makeCharger() {
    const g = new THREE.Group();
    const body = toonMat(0x2f6bff);
    const screen = toonMat(0x111111);
    const led = new THREE.MeshBasicMaterial({ color: 0x33ff77 });

    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.6, 0.32), body);
    pole.position.y = 0.8;
    pole.castShadow = true;
    g.add(pole);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.28), body);
    head.position.y = 1.55;
    g.add(head);

    const scr = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.03), screen);
    scr.position.set(0, 1.55, 0.16);
    g.add(scr);

    const ledMesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), led);
    ledMesh.position.set(0, 1.85, 0.16);
    g.add(ledMesh);
    g.userData.led = ledMesh;

    return g;
  }

  function makeTree() {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.18, 1, 8),
      toonMat(0x9a5a2e)
    );
    trunk.position.y = 0.5;
    g.add(trunk);
    const leaves = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 10, 10),
      toonMat(0x3fc463)
    );
    leaves.position.y = 1.35;
    leaves.castShadow = true;
    g.add(leaves);
    return g;
  }

  function makeBuildingBlock(w, h, d, color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      toonMat(color)
    );
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    return g;
  }

  function makeLine(w, d) {
    return new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.02, d),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
  }

  // ---------- groups ----------
  function buildSplashGroup() {
    const g = new THREE.Group();
    splashCar = makeFullSizeBus(0.5);
    g.add(splashCar);
    return g;
  }

  const CITY_SPOTS = [];
  const cityStaticObjects = []; // roads, buildings, trees — popped in via cityPopIn()

  // Concentric rings of building "slots" the city can grow into. Slots are
  // generated once; setCityExtent() below builds/removes rings on demand as
  // the average-distance-per-day value grows or shrinks.
  const CITY_RING_DEFS = [
    { radius: 20, count: 12 },
    { radius: 30, count: 16 },
    { radius: 40, count: 20 },
    { radius: 50, count: 24 },
  ];
  const CITY_COLORS = [0xff6b6b, 0xffd166, 0x5fd4ff, 0x9b6bff, 0x4ee6a0];
  const CITY_ROAD_WIDTH = 6;
  const CITY_CARDINAL_MARGIN = 0.2; // radians to keep building slots clear of the cross-road axes
  const cityBuildingSlots = []; // { x, z, ring, built, building, tree }
  const cityRingRoads = []; // { built, road } — aligned with CITY_RING_DEFS, ring 0 uses the base cross instead

  // true if angle falls on/near a cardinal direction (0, PI/2, PI, 3PI/2) —
  // i.e. right along the N/S or E/W road axis, where a building would sit on the road
  function isNearCardinal(angle) {
    const mod = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    return mod < CITY_CARDINAL_MARGIN || mod > (Math.PI / 2 - CITY_CARDINAL_MARGIN);
  }

  // a square loop of straight road segments at the given radius, matching
  // the grid look of the base cross rather than a circular ring
  function makeRingRoad(radius) {
    const outer = radius + CITY_ROAD_WIDTH / 2;
    const mat = toonMat(0xdddddd);
    const g = new THREE.Group();

    const northSouth = new THREE.PlaneGeometry(outer * 2, CITY_ROAD_WIDTH);
    const north = new THREE.Mesh(northSouth, mat);
    north.rotation.x = -Math.PI / 2;
    north.position.set(0, 0.015, -radius);
    north.receiveShadow = true;
    g.add(north);
    const south = north.clone();
    south.position.z = radius;
    g.add(south);

    const eastWest = new THREE.PlaneGeometry(CITY_ROAD_WIDTH, outer * 2);
    const east = new THREE.Mesh(eastWest, mat);
    east.rotation.x = -Math.PI / 2;
    east.position.set(radius, 0.015, 0);
    east.receiveShadow = true;
    g.add(east);
    const west = east.clone();
    west.position.x = -radius;
    g.add(west);

    return g;
  }

  // Builds the base road cross (always present) and generates the building
  // slots + ring-road bookkeeping for every ring; setCityExtent() builds or
  // tears down the rings' actual meshes on demand as distanceKm changes.
  function generateCityBuildingSlots(g) {
    const roadMat = toonMat(0xdddddd);
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(5, 90), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.02;
    roadNS.receiveShadow = true;
    g.add(roadNS);
    cityStaticObjects.push(roadNS);
    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(90, 5), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.02;
    roadEW.receiveShadow = true;
    g.add(roadEW);
    cityStaticObjects.push(roadEW);

    CITY_RING_DEFS.forEach((ringDef, ring) => {
      cityRingRoads.push({ built: false, road: null });
      for (let i = 0; i < ringDef.count; i++) {
        const angle = (i / ringDef.count) * Math.PI * 2 + ring * 0.35;
        if (isNearCardinal(angle)) continue; // skip slots that would sit on the N/S/E/W roads
        cityBuildingSlots.push({
          x: Math.cos(angle) * ringDef.radius,
          z: Math.sin(angle) * ringDef.radius,
          ring, built: false, building: null, tree: null,
        });
      }
    });
  }

  function buildCityGroup() {
    const g = new THREE.Group();

    generateCityBuildingSlots(g);

    // waypoints along the roads where city trucks can appear
    for (let i = -30; i <= 30; i += 10) {
      if (i === 0) continue;
      CITY_SPOTS.push(new THREE.Vector3(2.4, 0, i));
      CITY_SPOTS.push(new THREE.Vector3(i, 0, -2.4));
    }

    return g;
  }

  // Builds/removes rings of buildings+trees (and a ring road for every ring
  // beyond the innermost, which the base cross already covers) so the city
  // grows outward as distanceKm increases and contracts back down (never
  // below the innermost ring) as it shrinks.
  function setCityExtent(distanceKm) {
    const activeRings = Math.min(CITY_RING_DEFS.length, 1 + Math.floor(Math.max(0, distanceKm) / 100));

    CITY_RING_DEFS.forEach((ringDef, ring) => {
      if (ring === 0) return; // the base road cross already serves ring 0
      const ringRoad = cityRingRoads[ring];
      const shouldBeBuilt = ring < activeRings;
      if (shouldBeBuilt === ringRoad.built) return;
      // if (shouldBeBuilt) {
      //   const road = makeRingRoad(ringDef.radius);
      //   groups.city.add(road);
      //   cityStaticObjects.push(road);
      //   popIn(road);
      //   ringRoad.road = road;
      //   ringRoad.built = true;
      // } else {
      //   popOutAndRemove(ringRoad.road, groups.city);
      //   const idx = cityStaticObjects.indexOf(ringRoad.road);
      //   if (idx !== -1) cityStaticObjects.splice(idx, 1);
      //   ringRoad.road = null;
      //   ringRoad.built = false;
      // }
    });

    cityBuildingSlots.forEach((slot, i) => {
      const shouldBeBuilt = slot.ring < activeRings;
      if (shouldBeBuilt === slot.built) return;
      if (shouldBeBuilt) {
        const h = 3 + (i % 4) * 1.6;
        const b = makeBuildingBlock(6, h, 6, 0xfdfdfd);
        b.position.set(slot.x, 0, slot.z);
        b.scale.setScalar(0.001); // hide immediately; popIn's tween takes over once its timeout fires
        groups.city.add(b);
        cityStaticObjects.push(b);
        setTimeout(() => popIn(b), i % 8 * 15);

        const t = makeTree();
        t.position.set(slot.x + 3.6, 0, slot.z + 3.6);
        t.scale.setScalar(0.001);
        groups.city.add(t);
        cityStaticObjects.push(t);
        setTimeout(() => popIn(t), i % 8 * 15 + 8);

        slot.building = b;
        slot.tree = t;
        slot.built = true;
      } else {
        popOutAndRemove(slot.building, groups.city);
        popOutAndRemove(slot.tree, groups.city);
        [slot.building, slot.tree].forEach(obj => {
          const idx = cityStaticObjects.indexOf(obj);
          if (idx !== -1) cityStaticObjects.splice(idx, 1);
        });
        slot.building = null;
        slot.tree = null;
        slot.built = false;
      }
    });
  }



  // pops every road/building/tree in the city group in with a staggered scale tween
  function groupPopIn(objects, stagger = 20) {
    
    objects.forEach(obj => obj.scale.setScalar(0.001));
    objects.forEach(obj => obj.visible = true);

    objects.forEach((obj, i) => {
      setTimeout(() => popInTo(obj, 1, 320), i * stagger);
    });
  }

  function groupPopOut(objects, stagger = 20) {
    objects.forEach((obj, i) => {
      popInTo(obj, 0, 200);
    });
  }
  

   function hideCity(stagger = 20) {
    cityStaticObjects.forEach(obj => obj.visible = false);
  }

  const DEPOT_CHARGERS = [];
  const depotStaticObjects = []; // roads, buildings, trees — popped in via cityPopIn()

  let depotParkingObjects = []; // lines + chargers currently built by setDepotFleetSize()

  function buildDepotGroup() {
    const g = new THREE.Group();

    const lot = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 50),
      toonMat(0x3d4148)
    );
    lot.rotation.x = -Math.PI / 2;
    lot.position.set(-4, 0.015,-6);
    lot.receiveShadow = true;
    g.add(lot);
    depotStaticObjects.push(lot);

    // shop building, back-right
    const shop = makeBuildingBlock(9, 4.2, 6, 0xffd699);
    shop.position.set(11, 0, -6);
    g.add(shop);
    depotStaticObjects.push(shop);

    const shopGlass = new THREE.Mesh(
      new THREE.BoxGeometry(3, 2.2, 0.15),
      toonMat(0x37dbe0, { transparent: true, opacity: 0.75 })
    );
    shopGlass.position.set(9, 1.5, -2.93);
    g.add(shopGlass);

    depotStaticObjects.push(shopGlass);

    [[-18, -2], [-18, 14], [18, -13]].forEach(([x, z]) => {
      const t = makeTree();
      t.position.set(x, 0, z);
      g.add(t);

      depotStaticObjects.push(t);
    });

    return g;
  }

  // Rebuilds the parking-bay lines + chargers to fit `count` vehicles, using
  // the same truckRows/truckColumns grid shape showFleetGrid just laid the
  // fleet-size preview out in, so the depot mirrors that layout. One painted
  // stall per vehicle, plus two chargers at the head of every row.
  function setDepotFleetSize(count) {
    depotParkingObjects.forEach(obj => {
      groups.depot.remove(obj);
      const idx = depotStaticObjects.indexOf(obj);
      if (idx !== -1) depotStaticObjects.splice(idx, 1);
    });
    depotParkingObjects = [];
    DEPOT_CHARGERS.length = 0;

    count = Math.max(1, count);
    let placed = 0;
    const startX = -((truckColumns) * spacingX) / 2;
    const startZ = -((truckRows) * spacingZ) / 2;

    for (let r = 0; r <= truckRows && placed < count; r++) {
      const rowZ = startZ + r * spacingZ;
      
      for (let c = 0; c <= truckColumns && placed < count; c++) {
        
        const rowX = startX + c * spacingX;
        const line = makeLine(0.08, 5);
        line.position.set(rowX, 0.02, rowZ);
        groups.depot.add(line);
        depotStaticObjects.push(line);
        depotParkingObjects.push(line);
        placed++;
      }

      for (let i = 0; i < 2; i++) {
        const ch = makeCharger();
        ch.position.set(startX - 2, 0, rowZ + (i === 0 ? -2 : 2));
        groups.depot.add(ch);
        depotStaticObjects.push(ch);
        depotParkingObjects.push(ch);
        DEPOT_CHARGERS.push(ch);
      }
    }
  }

  // ---------- day/night ----------
  function updateSun() {
    const t = dayPhase;
    const elevAngle = THREE.MathUtils.lerp(Math.PI * 0.42, -Math.PI * 0.18, t);
    const dist = 45;
    sunLight.position.set(Math.cos(elevAngle) * dist * 0.6, Math.max(Math.sin(elevAngle) * dist, 1.5), Math.sin(elevAngle) * dist * 0.3 + 10);
    sunLight.target.position.set(0, 0, 0);

    ambLight.intensity = THREE.MathUtils.lerp(1, 0.2, t);
    sunLight.intensity = THREE.MathUtils.lerp(1.5, 0.15, t);

    DEPOT_CHARGERS.forEach(ch => {
      ch.userData.led.material.color.setHex(t > 0.35 ? 0x33ff77 : 0x225533);
    });
  }

  function setDayPhase(target) { dayPhaseTarget = target; }

  // ---------- tweens ----------
  function popInTo(obj, targetScale, duration = 350) {
    
    obj.scale.setScalar(0.001);

    for (let i = scaleTweens.length - 1; i >= 0; i--) {
      if (scaleTweens[i].obj === obj) scaleTweens.splice(i, 1);
    }
    scaleTweens.push({ obj, elapsed: 0, duration, from: 0.001, to: targetScale });
  }

  function popIn(obj, duration = 350) {
    popInTo(obj, 1, duration);
  }

  function appearTo(obj, targetScale, duration = 350) {
    obj.scale.setScalar(0.001);
    setTimeout(() => obj.scale.setScalar(targerScale), duration);
  }

  function appear(obj, duration = 350) {
    obj.scale.setScalar(0.001);
    setTimeout(() => obj.scale.setScalar(1), duration);
  }

  function popOutAndRemove(obj, parent, duration = 300) {
    scaleTweens.push({
      obj, elapsed: 0, duration, from: 1, to: 0.001,
      onDone: () => parent.remove(obj),
    });
  }

  function updateTweens(dtMs) {
    for (let i = scaleTweens.length - 1; i >= 0; i--) {
      const tw = scaleTweens[i];
      tw.elapsed += dtMs;
      const p = Math.min(tw.elapsed / tw.duration, 1);
      const s = tw.from + (tw.to - tw.from) * p;
      tw.obj.scale.setScalar(Math.max(s, 0.001));
      if (p >= 1) {
        scaleTweens.splice(i, 1);
        if (tw.onDone) tw.onDone();
      }
    }
  }

  // ---------- public: splash ----------
  const splashTarget = new THREE.Vector3(0, 0, 0);

  // ---------- public: city (fleet-size + hours) ----------
  // Builds the fleet grid from a mix of heavy duty (full-size bus) and medium
  // duty (cutaway bus) vehicles, heavy first then medium, in one combined grid.
  function showFleetGrid(heavyCount, mediumCount) {
    [...trucks.children].forEach(t => trucks.remove(t));
    const count = heavyCount + mediumCount;
    truckColumns = Math.max(1, Math.ceil(Math.sqrt(count * 1.4)));
    truckRows  = Math.ceil(count / truckColumns);
    const startX = -((truckColumns - 1) * spacingX) / 2;
    const startZ = -((truckRows - 1) * spacingZ) / 2;
    let placed = 0;
    for (let r = 0; r < truckRows && placed < count; r++) {
      for (let c = 0; c < truckColumns && placed < count; c++) {
        const truck = placed < heavyCount ? makeFullSizeBus(truckScale) : makeCutawayBus(truckScale);
        truck.position.set(startX + c * spacingX * truckScale, 0, startZ + r * spacingZ * truckScale);
        truck.scale.setScalar(0.001);
        trucks.add(truck);
        // setTimeout(() => truck.scale.setScalar(truckScale), placed * 30);
        setTimeout(() =>  popIn(truck, 200), placed * 20)
        placed++;
      }
    }
  }

  function citySetVisibleCount(n) {
    n = Math.max(0, Math.min(n, CITY_SPOTS.length));
    while (trucks.children.length < n) {
      const spot = CITY_SPOTS[trucks.children.length % CITY_SPOTS.length];
      const truck = makeFullSizeBus(0.7);
      truck.position.copy(spot);
      truck.rotation.y = spot.x !== 2.4 && spot.x !== -2.4 ? 0 : Math.PI / 2;
      trucks.add(truck);
      popIn(truck);
    }
    // popOutAndRemove() only detaches its truck once the shrink tween finishes,
    // so trucks.children.length won't drop yet — compute how many to remove
    // up front instead of re-checking the (still-unchanged) live count.
    const toRemove = trucks.children.length - n;
    for (let i = 0; i < toRemove; i++) {
      const truck = trucks.children[trucks.children.length - 1 - i];
      popOutAndRemove(truck, trucks);
    }
  }

  function cityReset() {
    [...trucks.children].forEach(t => trucks.remove(t));
  }

  // Swaps the first `fraction` share of the current city fleet to the EV bus
  // model (blue livery, charge port, no tailpipe/exhaust) and the rest back
  // to diesel, replacing each truck's mesh in place.
  function SetEvFraction(fraction) {
    fraction = Math.max(0, Math.min(1, fraction));
    const current = trucks.children.slice();
    const targetEv = Math.round(current.length * fraction);
    current.forEach((truck, i) => {
      const shouldBeEv = i < targetEv;
      if (!!truck.userData.isEV === shouldBeEv) return;
      const scale = truck.scale.x;
      const makeBus = truck.userData.busType === 'cutaway' ? makeCutawayBus : makeFullSizeBus;
      const replacement = makeBus(scale, shouldBeEv);
      replacement.position.copy(truck.position);
      replacement.rotation.copy(truck.rotation);
      // splice in at the same index instead of trucks.add() (which appends),
      // so repeated fraction changes keep selecting a stable "first N" order
      const idx = trucks.children.indexOf(truck);
      trucks.remove(truck);
      trucks.children.splice(idx, 0, replacement);
      replacement.parent = trucks;
      popInTo(replacement, truckScale, 250);
    });
  }

  // ---------- step control ----------
  function sceneryFor(name) {
    if (name === 'city') return cityStaticObjects;
    if (name === 'depot') return depotStaticObjects;
    return null;
  }

  // groups.city/depot's own .visible can stay true across steps while its
  // scenery is independently hidden (e.g. wizard.js's hideCity()), so the
  // group flag alone isn't enough to know whether the scenery is showing.
  function isSceneryShown(name) {
    const objects = sceneryFor(name);
    if (!objects || !objects.length) return groups[name].visible;
    return objects[0].visible !== false;
  }

  const sceneryGen = {}; // guards delayed hide-after-popOut against a quick re-entry

  function popInGroup(name) {
    sceneryGen[name] = (sceneryGen[name] || 0) + 1;
    groups[name].visible = true;
    const objects = sceneryFor(name);
    if (objects) groupPopIn(objects);
  }

  function popOutGroup(name, stagger = 20) {
    const objects = sceneryFor(name);
    if (objects && objects.length) {
      groupPopOut(objects, stagger);
      const gen = (sceneryGen[name] = (sceneryGen[name] || 0) + 1);
      setTimeout(() => {
        if (sceneryGen[name] === gen) groups[name].visible = false;
      }, objects.length * stagger);
    } else {
      groups[name].visible = false;
    }
  }

  function showOnly(name) {
    // trucks live directly on the stage (sibling of groups.city/groups.depot),
    // so they stay visible across the city/depot steps and only hide on splash
    stage.visible = name !== 'splash';
    Object.keys(groups).forEach(k => {
      if(k === name){
        if (!groups[k].visible || !isSceneryShown(k)) popInGroup(k);
      }else{
        if (groups[k].visible){
          popOutGroup(k);
        }else{
          k.visible = false;
        }
      }
    });
  }

  function enterSplash() {
    showOnly('splash');
    setDayPhase(0);
    splashCar.position.set(0, 0, 0);
  }

  function enterCity() {
    showOnly('city');
    setDayPhase(0);
  }

  function enterDepot(hasDepot) {
    showOnly('depot');
    // if (hasDepot) {
    //   setDayPhase(1);
    // } else {
    //   setDayPhase(0.15);
    // }
  }

  // ---------- lifecycle ----------
  const FRUSTUM_SIZE = 26;

  // pulls the camera back (wider orthographic frustum) as the average daily
  // distance grows, so a fleet that drives further reads as "covering more ground"
  function setDistanceZoom(distanceKm) {
    const t = Math.max(0, Math.min(400, distanceKm)) / 400;
    cameraZoomTarget = 1 + t * 0.9; // 1.0x (close) .. 1.9x (pulled back)
  }

  function updateCameraFrustum() {
    const aspect = innerWidth / innerHeight;
    const size = FRUSTUM_SIZE * cameraZoom;
    camera.left = -size * aspect / 2;
    camera.right = size * aspect / 2;
    camera.top = size / 2;
    camera.bottom = -size / 2;
    camera.updateProjectionMatrix();
  }

  function onResize() {
    updateCameraFrustum();
    renderer.setSize(innerWidth, innerHeight);
  }

  function onMouseMove(e) {
    // use the canvas's actual on-screen rect rather than raw viewport size,
    // since CSS may nudge/transform the canvas off its default (0,0) origin
    const rect = canvasEl.getBoundingClientRect();
    mouseNDC.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  let lastTime = performance.now();
  function tick(now) {
    const dtMs = now - lastTime;
    lastTime = now;

    dayPhase += (dayPhaseTarget - dayPhase) * 0.03;
    updateSun();
    cameraZoom += (cameraZoomTarget - cameraZoom) * 0.04;
    updateCameraFrustum();
    updateTweens(dtMs);

    if (groups.splash.visible) {
      raycaster.setFromCamera(mouseNDC, camera);
      if (raycaster.ray.intersectPlane(groundPlane, hitPt)) {
        splashTarget.copy(hitPt);
      }
      const diff = new THREE.Vector3().subVectors(splashTarget, splashCar.position);
      diff.y = 0;
      const dist = diff.length();
      if (dist > 0.08) {
        const dir = diff.clone().normalize();
        const speed = Math.min(dist * 0.06, 0.24);
        splashCar.position.addScaledVector(dir, speed);
        const targetAngle = Math.atan2(dir.x, dir.z);
        let da = targetAngle - splashCar.rotation.y;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        splashCar.rotation.y += da * 0.1;
      }
      updateTruckExhaust(splashCar, dtMs);
    }
    if (stage.visible) trucks.children.forEach(t => updateTruckExhaust(t, dtMs));
    updateExhaustPuffs(dtMs);

    renderer.render(scene, camera);
  }

  function init(canvas) {
    canvasEl = canvas;
    toonGradient = makeToonGradient(4);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    const aspect = innerWidth / innerHeight;
    camera = new THREE.OrthographicCamera(
      -FRUSTUM_SIZE * aspect / 2, FRUSTUM_SIZE * aspect / 2,
      FRUSTUM_SIZE / 2, -FRUSTUM_SIZE / 2,
      0.1, 300
    );
    camera.position.set(0, 16, 24);
    camera.lookAt(0, 2, 0);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;

    ambLight = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambLight);

    sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.setScalar(1024);
    sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -40;
    sunLight.shadow.camera.right = sunLight.shadow.camera.top = 40;
    sunLight.shadow.camera.far = 120;
    scene.add(sunLight);
    scene.add(sunLight.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140),
      toonMat(0xffffff)
    );

    ground.visible = false;
    scene.add(ground);

    groups.splash = buildSplashGroup();
    groups.city = buildCityGroup();
    groups.depot = buildDepotGroup();
    setCityExtent(0); // baseline: innermost ring only, until distance is set
    setDepotFleetSize(1); // baseline: one bay, until fleet size is set

    groups.splash.visible = false;
    scene.add(groups.splash);

    // city and depot share one rotated/scaled "stage" instead of each
    // repeating the same rotation.y/scale on themselves
    stage = new THREE.Group();
    stage.rotation.y = Math.PI / 4;
    stage.scale.setScalar(0.5);
    scene.add(stage);

    groups.city.visible = false;
    groups.depot.visible = false;
    stage.add(groups.city);
    stage.add(groups.depot);

    trucks = new THREE.Group();
    stage.add(trucks);

    addEventListener('resize', onResize);
    addEventListener('mousemove', onMouseMove);

    updateSun();
    renderer.setAnimationLoop(tick);
  }

  return {
    init,
    enterSplash,
    enterCity,
    hideCity,
    enterDepot,
    showFleetGrid,
    citySetVisibleCount,
    SetEvFraction,
    cityReset,
    setDistanceZoom,
    setCityExtent,
    setDepotFleetSize,
    get truckCount() { return trucks.children.length; },
  };
})();
