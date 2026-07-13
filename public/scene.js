// FuseScene: shared Three.js world reused across every wizard step.
// One renderer/camera/ground; steps toggle which group is visible and
// drive small animations (day/night, trucks parking, battery charging).
window.FuseScene = (function () {
  let renderer, camera, scene;
  let ambLight, sunLight, sunMesh;
  let toonGradient;
  let groups = {};
  let dayPhase = 0, dayPhaseTarget = 0;
  let raycaster = new THREE.Raycaster();
  let groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let mouseNDC = new THREE.Vector2(1e6, 1e6);
  let hitPt = new THREE.Vector3();
  let truckScale = 0.75;

  const movers = [];       // { obj, target: Vector3, speed, onArrive }
  const scaleTweens = [];  // { obj, elapsed, duration, from, to }
  const depotTrucks = [];
  const cityTrucks = [];
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
    g.scale.setScalar(scale);
    return g;
  }

  // Cutaway/mid-size bus: van-style cab (dark hood + sloped windshield) with a
  // shorter, taller passenger box behind it and a single rear axle (matches the
  // ~26 capacity "Mid Bus" photo).
  function makeCutawayBus(scale = 1) {
    const g = new THREE.Group();
    const m = mats();
    const bus = toonMat(0xffcc00);

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

    const tailpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.2, 8), m.dark);
    tailpipe.rotation.x = Math.PI / 2;
    tailpipe.position.set(-0.8, 0.28, -front - 0.15);
    g.add(tailpipe);
    g.userData.exhaustPoint = new THREE.Vector3(-0.8, 0.28, -front - 0.28);

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

  function makeBatteryBar() {
    const g = new THREE.Group();
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.14),
      new THREE.MeshBasicMaterial({ color: 0x1a1a1a })
    );
    g.add(bg);
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.84, 0.09),
      new THREE.MeshBasicMaterial({ color: 0x33dd66 })
    );
    fill.position.z = 0.01;
    fill.scale.x = 0.001;
    fill.position.x = -0.42;
    fill.geometry.translate(0.42, 0, 0); // scale from left edge
    g.add(fill);
    g.userData.fill = fill;
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
    splashCar = makeFullSizeBus(0.9);
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
    
    g.rotation.y = Math.PI / 4;
    g.scale.setScalar(0.5);

    return g;
  }

  
  function cityPopIn(){
    groupPopIn(cityStaticObjects);
  }

  function depotPopIn(){
    groupPopIn(depotStaticObjects);
  }

  // pops every road/building/tree in the city group in with a staggered scale tween
  function groupPopIn(objects, stagger = 20) {
    objects.forEach((obj, i) => {
      setTimeout(() => popInTo(obj, 1, 320), i * stagger);
    });
  }

   function cityHide(stagger = 20) {
    cityStaticObjects.forEach(obj => obj.scale.setScalar(0.001));
  }

  const DEPOT_SPOTS = [];
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
        DEPOT_SPOTS.push(new THREE.Vector3(x, 0, rowZ));
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

    g.rotation.y = Math.PI / 4;
    g.scale.setScalar(0.5);

    return g;
  }

  // ---------- day/night ----------
  function updateSun() {
    const t = dayPhase;
    const elevAngle = THREE.MathUtils.lerp(Math.PI * 0.42, -Math.PI * 0.18, t);
    const dist = 45;
    sunLight.position.set(Math.cos(elevAngle) * dist * 0.6, Math.max(Math.sin(elevAngle) * dist, 1.5), Math.sin(elevAngle) * dist * 0.3 + 10);
    sunLight.target.position.set(0, 0, 0);
    sunMesh.position.copy(sunLight.position);
    sunMesh.visible = elevAngle > -0.05;

    ambLight.intensity = THREE.MathUtils.lerp(1, 0.2, t);
    sunLight.intensity = THREE.MathUtils.lerp(1.5, 0.15, t);

    DEPOT_CHARGERS.forEach(ch => {
      ch.userData.led.material.color.setHex(t > 0.35 ? 0x33ff77 : 0x225533);
    });
  }

  function setDayPhase(target) { dayPhaseTarget = target; }

  // ---------- movers / tweens ----------
  function moveTo(obj, target, speed, onArrive) {
    movers.push({ obj, target: target.clone(), speed, onArrive });
  }

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

  function updateMovers(dt) {
    for (let i = movers.length - 1; i >= 0; i--) {
      const mv = movers[i];
      const diff = new THREE.Vector3().subVectors(mv.target, mv.obj.position);
      diff.y = 0;
      const dist = diff.length();
      if (dist < 0.15) {
        mv.obj.position.copy(mv.target);
        movers.splice(i, 1);
        if (mv.onArrive) mv.onArrive();
        continue;
      }
      const dir = diff.normalize();
      mv.obj.position.addScaledVector(dir, Math.min(mv.speed, dist));
      const targetAngle = Math.atan2(dir.x, dir.z);
      let da = targetAngle - mv.obj.rotation.y;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      mv.obj.rotation.y += da * 0.15;
    }
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
  function showFleetGrid(count) {
    cityTrucks.splice(0).forEach(t => groups.city.remove(t));
    const spacingX = 3.5, spacingZ = 8;
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.4)));
    const rows = Math.ceil(count / cols);
    const startX = -((cols - 1) * spacingX) / 2;
    const startZ = -((rows - 1) * spacingZ) / 2;
    let placed = 0;
    for (let r = 0; r < rows && placed < count; r++) {
      for (let c = 0; c < cols && placed < count; c++) {
        const truck = makeFullSizeBus(truckScale);
        truck.position.set(startX + c * spacingX * truckScale, 0, startZ + r * spacingZ * truckScale);
        truck.scale.setScalar(0.001);
        groups.city.add(truck);
        cityTrucks.push(truck);
        setTimeout(() => truck.scale.setScalar(truckScale), placed * 30);
        placed++;
      }
    }
  }

  function citySetVisibleCount(n) {
    n = Math.max(0, Math.min(n, CITY_SPOTS.length));
    while (cityTrucks.length < n) {
      const spot = CITY_SPOTS[cityTrucks.length % CITY_SPOTS.length];
      const truck = makeFullSizeBus(0.7);
      truck.position.copy(spot);
      truck.rotation.y = spot.x !== 2.4 && spot.x !== -2.4 ? 0 : Math.PI / 2;
      groups.city.add(truck);
      popIn(truck);
      cityTrucks.push(truck);
    }
    while (cityTrucks.length > n) {
      const truck = cityTrucks.pop();
      popOutAndRemove(truck, groups.city);
    }
  }

  function cityReset() {
    cityTrucks.splice(0).forEach(t => groups.city.remove(t));
  }

  // Swaps the first `fraction` share of the current city fleet to the EV bus
  // model (blue livery, charge port, no tailpipe/exhaust) and the rest back
  // to diesel, replacing each truck's mesh in place.
  function citySetEvFraction(fraction) {
    fraction = Math.max(0, Math.min(1, fraction));
    const targetEv = Math.round(cityTrucks.length * fraction);
    cityTrucks.forEach((truck, i) => {
      const shouldBeEv = i < targetEv;
      if (!!truck.userData.isEV === shouldBeEv) return;
      //this mucks up with the scaling in the transition
      const scale = truck.scale.x;
      const replacement = makeFullSizeBus(scale, shouldBeEv);
      replacement.position.copy(truck.position);
      replacement.rotation.copy(truck.rotation);
      groups.city.add(replacement);
      groups.city.remove(truck);
      popInTo(replacement, truckScale, 250);
      cityTrucks[i] = replacement;
    });
  }

  // ---------- public: depot ----------
  function depotParkTrucks(count) {
    count = Math.max(0, Math.min(count, DEPOT_SPOTS.length));
    // remove extras
    while (depotTrucks.length > count) {
      const t = depotTrucks.pop();
      if (t.userData.bar) t.remove(t.userData.bar);
      groups.depot.remove(t);
    }
    while (depotTrucks.length < count) {
      const idx = depotTrucks.length;
      const spot = DEPOT_SPOTS[idx];
      const truck = makeFullSizeBus(0.85);
      truck.position.set(spot.x, 0, -30);
      truck.rotation.y = 0;
      groups.depot.add(truck);
      depotTrucks.push(truck);
      moveTo(truck, spot, 0.28, null);
    }
  }

  function depotStartCharging() {
    depotTrucks.forEach((truck, i) => {
      if (truck.userData.bar) return;
      const bar = makeBatteryBar();
      bar.position.set(0, 2.6, 0);
      truck.add(bar);
      truck.userData.bar = bar;
      const delay = i * 150;
      setTimeout(() => tweenFill(bar.userData.fill, 2600), delay);
    });
  }

  function tweenFill(fillMesh, duration) {
    const start = performance.now();
    function step(now) {
      const p = Math.min((now - start) / duration, 1);
      fillMesh.scale.x = Math.max(p, 0.001);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function depotSendTrucksOut() {
    depotTrucks.splice(0).forEach((truck, i) => {
      if (truck.userData.bar) truck.remove(truck.userData.bar);
      const exit = new THREE.Vector3(truck.position.x, 0, -34);
      moveTo(truck, exit, 0.32, () => groups.depot.remove(truck));
    });
  }

  function depotReset() {
    depotTrucks.splice(0).forEach(t => groups.depot.remove(t));
    groupPopIn(depotStaticObjects);
  }

  // ---------- step control ----------
  function showOnly(name) {
    Object.keys(groups).forEach(k => { groups[k].visible = (k === name); });
  }

  function enterSplash() {
    showOnly('splash');
    setDayPhase(0);
    splashCar.position.set(0, 0, 0);
  }

  function enterCity() {
    showOnly('city');
    setDayPhase(0);
    cityHide();
  }

  function enterDepot(hasDepot) {
    showOnly('depot');
    if (hasDepot) {
      setDayPhase(1);
    } else {
      setDayPhase(0.15);
    }
  }

  function enterRecharge() {
    showOnly('depot');
    setDayPhase(1);
    // give trucks time to finish driving into their spots before charging starts
    setTimeout(() => {
      depotStartCharging();
      const chargeDelay = depotTrucks.length * 150 + 2600 + 600;
      setTimeout(() => {
        setDayPhase(0);
        depotSendTrucksOut();
      }, chargeDelay);
    }, 1500);
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
    mouseNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  }

  let lastTime = performance.now();
  function tick(now) {
    const dtMs = now - lastTime;
    lastTime = now;

    dayPhase += (dayPhaseTarget - dayPhase) * 0.03;
    updateSun();
    updateMovers(dtMs / 16.6);
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
    if (groups.city.visible) cityTrucks.forEach(t => updateTruckExhaust(t, dtMs));
    if (groups.depot.visible) depotTrucks.forEach(t => updateTruckExhaust(t, dtMs));
    updateExhaustPuffs(dtMs);

    renderer.render(scene, camera);
  }

  function init(canvas) {
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

    sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff6cc })
    );
    scene.add(sunMesh);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140),
      toonMat(0xffffff)
    );
    ground.rotation.x = -Math.PI / 2;
    // ground.receiveShadow = true;
    scene.add(ground);

    groups.splash = buildSplashGroup();
    groups.city = buildCityGroup();
    groups.depot = buildDepotGroup();
    Object.values(groups).forEach(g => { g.visible = false; scene.add(g); });

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
    depotPopIn,
    enterDepot,
    enterRecharge,
    showFleetGrid,
    citySetVisibleCount,
    citySetEvFraction,
    cityReset,
    depotParkTrucks,
    depotReset,
    get cityTruckCount() { return cityTrucks.length; },
  };
})();
