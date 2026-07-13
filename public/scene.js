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
  let raycaster = new THREE.Raycaster();
  let groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let mouseNDC = new THREE.Vector2(1e6, 1e6);
  let hitPt = new THREE.Vector3();
  let truckScale = 0.75;

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
  function makeFullSizeBus(scale = 1, isEV = false) {
    const g = new THREE.Group();
    const m = mats();
    const bus = toonMat(isEV ? 0x2a7de1 : 0xffcc00);
    const length = 6.6;

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, length), bus);
    body.position.y = 1.05;
    body.castShadow = true;
    g.add(body);

    const roofCap = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.22, 0.5), m.dark);
    roofCap.position.set(0, 1.87, length / 2 - 0.16);
    g.add(roofCap);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 0.06), m.glass);
    windshield.position.set(0, 1.2, length / 2 + 0.02);
    g.add(windshield);

    const sideWindows = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.45, length - 1.6), m.glass);
    sideWindows.position.set(0, 1.3, -0.3);
    g.add(sideWindows);

    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.15), m.dark);
    grille.position.set(0, 0.55, length / 2 + 0.1);
    g.add(grille);

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

    // front axle: single wheels
    const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 14);
    [-0.95, 0.95].forEach(x => {
      const w = new THREE.Mesh(wheelGeo, m.wheel);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.4, length / 2 - 0.9);
      w.castShadow = true;
      g.add(w);
    });

    // rear tandem axles: wider cylinders to read as dual wheels
    const dualWheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.52, 14);
    [-1, 1].forEach(sign => {
      [-length / 2 + 0.9, -length / 2 + 2.0].forEach(z => {
        const w = new THREE.Mesh(dualWheelGeo, m.wheel);
        w.rotation.z = Math.PI / 2;
        w.position.set(sign * 0.95, 0.4, z);
        w.castShadow = true;
        g.add(w);
      });
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
  function makeCutawayBus(scale = 1, isEV = false) {
    const g = new THREE.Group();
    const m = mats();
    const bus = toonMat(isEV ? 0x2a7de1 : 0xffcc00);

    const hoodLength = 1.3;
    const bodyLength = 3.2;
    const totalLength = hoodLength + bodyLength;
    const front = totalLength / 2;

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, bodyLength), bus);
    body.position.set(0, 1.05, front - hoodLength - bodyLength / 2);
    body.castShadow = true;
    g.add(body);

    const sideWindows = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.45, bodyLength - 0.8), m.glass);
    sideWindows.position.set(0, 1.3, front - hoodLength - bodyLength / 2);
    g.add(sideWindows);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.95, hoodLength), m.dark);
    hood.position.set(0, 0.75, front - hoodLength / 2);
    hood.castShadow = true;
    g.add(hood);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.06), m.glass);
    windshield.position.set(0, 1.15, front - hoodLength + 0.05);
    windshield.rotation.x = -0.3;
    g.add(windshield);

    const bumperFront = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.24, 0.15), m.dark);
    bumperFront.position.set(0, 0.28, front + 0.05);
    g.add(bumperFront);
    const bumperRear = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.24, 0.15), m.dark);
    bumperRear.position.set(0, 0.28, -front - 0.05);
    g.add(bumperRear);

    if (isEV) {
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.05), toonMat(0x33dd66));
      port.position.set(0.86, 0.85, front - hoodLength - bodyLength / 2);
      g.add(port);
    } else {
      const tailpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.2, 8), m.dark);
      tailpipe.rotation.x = Math.PI / 2;
      tailpipe.position.set(-0.8, 0.28, -front - 0.15);
      g.add(tailpipe);
      g.userData.exhaustPoint = new THREE.Vector3(-0.8, 0.28, -front - 0.28);
    }

    // tow mirrors on stalks off the cab
    [-1, 1].forEach(sign => {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 6), m.dark);
      stalk.rotation.z = Math.PI / 2;
      stalk.position.set(sign * 1.05, 1.15, front - 0.15);
      g.add(stalk);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.2), m.dark);
      mirror.position.set(sign * 1.24, 1.15, front - 0.15);
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
  function buildCityGroup() {
    const g = new THREE.Group();

    const roadMat = toonMat(0xcfd0d1);
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(8, 90), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.02;
    roadNS.receiveShadow = true;
    g.add(roadNS);
    cityStaticObjects.push(roadNS);
    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(90, 8), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.02;
    roadEW.receiveShadow = true;
    g.add(roadEW);
    cityStaticObjects.push(roadEW);

    const colors = [0xff6b6b, 0xffd166, 0x5fd4ff, 0x9b6bff, 0x4ee6a0];
    const blockPositions = [
      [-16, -14], [-16, 14], [16, -14], [16, 14],
      [-24, 0], [24, 0], [0, -24], [0, 24],
    ];
    blockPositions.forEach(([x, z], i) => {
      const h = 3 + (i % 4) * 1.6;
      const b = makeBuildingBlock(6, h, 6, colors[i % colors.length]);
      b.position.set(x, 0, z);
      g.add(b);
      cityStaticObjects.push(b);
      const t = makeTree();
      t.position.set(x + 3.6, 0, z + 3.6);
      g.add(t);
      cityStaticObjects.push(t);
    });

    // waypoints along the roads where city trucks can appear
    for (let i = -30; i <= 30; i += 10) {
      if (i === 0) continue;
      CITY_SPOTS.push(new THREE.Vector3(2.4, 0, i));
      CITY_SPOTS.push(new THREE.Vector3(i, 0, -2.4));
    }

    return g;
  }


  function cityPopIn(){
    groupPopIn(cityStaticObjects);
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
      setTimeout(() => popInTo(obj, 0, 320), i * stagger);
    });
  }
  

   function cityHide(stagger = 20) {
    cityStaticObjects.forEach(obj => obj.visible = false);
  }

  const DEPOT_CHARGERS = [];
  const depotStaticObjects = []; // roads, buildings, trees — popped in via cityPopIn()

  function buildDepotGroup() {
    const g = new THREE.Group();

    const lot = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 26),
      toonMat(0x3d4148)
    );
    lot.rotation.x = -Math.PI / 2;
    lot.position.set(-4, 0.015, 6);
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

    // parking rows (two rows of 4 bays) with painted lines + chargers at the row head
    const rows = [-2, 8];
    rows.forEach((rowZ, rowIdx) => {
      for (let i = 0; i < 4; i++) {
        const x = -16 + i * 4.2;
        const line = makeLine(0.08, 5);
        line.position.set(x + 2.1, 0.02, rowZ);
        g.add(line);

        depotStaticObjects.push(line);
      }
      const lastLine = makeLine(0.08, 5);
      lastLine.position.set(-16 + 4 * 4.2 + 2.1 - 4.2, 0.02, rowZ);
      if (rowIdx === 0) {
        for (let i = 0; i < 2; i++) {
          const ch = makeCharger();
          ch.position.set(-18, 0, rowZ + (i === 0 ? -2 : 2));
          g.add(ch);
          depotStaticObjects.push(ch);
          DEPOT_CHARGERS.push(ch);
        }
      }
    });

    return g;
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
    for (let i = scaleTweens.length - 1; i >= 0; i--) {
      if (scaleTweens[i].obj === obj) scaleTweens.splice(i, 1);
    }
    obj.scale.setScalar(0.001);
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
    const spacingX = 4, spacingZ = 10;
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.4)));
    const rows = Math.ceil(count / cols);
    const startX = -((cols - 1) * spacingX) / 2;
    const startZ = -((rows - 1) * spacingZ) / 2;
    let placed = 0;
    for (let r = 0; r < rows && placed < count; r++) {
      for (let c = 0; c < cols && placed < count; c++) {
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
      }, objects.length * stagger + 320);
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
        popInGroup(k);
      }else{
        popOutGroup(k);
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
    cityHide();
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
  function onResize() {
    const aspect = innerWidth / innerHeight;
    camera.left = -FRUSTUM_SIZE * aspect / 2;
    camera.right = FRUSTUM_SIZE * aspect / 2;
    camera.top = FRUSTUM_SIZE / 2;
    camera.bottom = -FRUSTUM_SIZE / 2;
    camera.updateProjectionMatrix();
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
    cityPopIn,
    enterDepot,
    showFleetGrid,
    citySetVisibleCount,
    SetEvFraction,
    cityReset,
    get truckCount() { return trucks.children.length; },
  };
})();
