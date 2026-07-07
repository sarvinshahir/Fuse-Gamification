// FuseScene: shared Three.js world reused across every wizard step.
// One renderer/camera/ground; steps toggle which group is visible and
// drive small animations (day/night, trucks parking, battery charging).
window.FuseScene = (function () {
  let renderer, camera, scene;
  let ambLight, sunLight, sunMesh;
  let groups = {};
  let dayPhase = 0, dayPhaseTarget = 0;
  let raycaster = new THREE.Raycaster();
  let groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let mouseNDC = new THREE.Vector2(1e6, 1e6);
  let hitPt = new THREE.Vector3();
  let clickHandler = null;

  const movers = [];       // { obj, target: Vector3, speed, onArrive }
  const scaleTweens = [];  // { obj, elapsed, duration, from, to }
  const depotTrucks = [];
  const cityTrucks = [];
  let splashCar = null;

  // ---------- material / mesh factories ----------
  function mats() {
    return {
      white: new THREE.MeshPhongMaterial({ color: 0xf5f5f5, shininess: 40 }),
      dark: new THREE.MeshPhongMaterial({ color: 0x2a2a2a, shininess: 20 }),
      glass: new THREE.MeshPhongMaterial({ color: 0x88aacc, transparent: true, opacity: 0.5 }),
      wheel: new THREE.MeshPhongMaterial({ color: 0x111111 }),
    };
  }

  function makeTruck(scale = 1) {
    const g = new THREE.Group();
    const m = mats();

    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 1.2), m.white);
    cab.position.set(0, 0.95, 1.35);
    cab.castShadow = true;
    g.add(cab);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.5, 0.06), m.glass);
    windshield.position.set(0, 1.15, 1.95);
    g.add(windshield);

    const trailer = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.7, 3.4), m.white);
    trailer.position.set(0, 1.25, -0.7);
    trailer.castShadow = true;
    g.add(trailer);

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.3, 4.6), m.dark);
    chassis.position.set(0, 0.35, 0.1);
    g.add(chassis);

    const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 14);
    [1.35, -0.4, -1.7].forEach(z => [-0.75, 0.75].forEach(x => {
      const w = new THREE.Mesh(wheelGeo, m.wheel);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.38, z);
      w.castShadow = true;
      g.add(w);
    }));

    g.scale.setScalar(scale);
    return g;
  }

  function makeCharger() {
    const g = new THREE.Group();
    const body = new THREE.MeshPhongMaterial({ color: 0x1c3fae });
    const screen = new THREE.MeshPhongMaterial({ color: 0x111111 });
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
      new THREE.MeshPhongMaterial({ color: 0x6b4a2f })
    );
    trunk.position.y = 0.5;
    g.add(trunk);
    const leaves = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 10, 10),
      new THREE.MeshPhongMaterial({ color: 0x4a8a4a })
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
      new THREE.MeshPhongMaterial({ color })
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
    splashCar = makeTruck(0.9);
    g.add(splashCar);
    return g;
  }

  const CITY_SPOTS = [];
  function buildCityGroup() {
    const g = new THREE.Group();

    const roadMat = new THREE.MeshLambertMaterial({ color: 0x4a4f57 });
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(8, 90), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.02;
    roadNS.receiveShadow = true;
    g.add(roadNS);
    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(90, 8), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.02;
    roadEW.receiveShadow = true;
    g.add(roadEW);

    const colors = [0x8a8f98, 0x6b7280, 0xb3bac2, 0x9aa3ad, 0x7d8590];
    const blockPositions = [
      [-16, -14], [-16, 14], [16, -14], [16, 14],
      [-24, 0], [24, 0], [0, -24], [0, 24],
    ];
    blockPositions.forEach(([x, z], i) => {
      const h = 3 + (i % 4) * 1.6;
      const b = makeBuildingBlock(6, h, 6, colors[i % colors.length]);
      b.position.set(x, 0, z);
      g.add(b);
      const t = makeTree();
      t.position.set(x + 3.6, 0, z + 3.6);
      g.add(t);
    });

    // waypoints along the roads where city trucks can appear
    for (let i = -30; i <= 30; i += 10) {
      if (i === 0) continue;
      CITY_SPOTS.push(new THREE.Vector3(2.4, 0, i));
      CITY_SPOTS.push(new THREE.Vector3(i, 0, -2.4));
    }

    return g;
  }

  const DEPOT_SPOTS = [];
  const DEPOT_CHARGERS = [];
  function buildDepotGroup() {
    const g = new THREE.Group();

    const lot = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 26),
      new THREE.MeshLambertMaterial({ color: 0x3d4148 })
    );
    lot.rotation.x = -Math.PI / 2;
    lot.position.set(-4, 0.015, 6);
    lot.receiveShadow = true;
    g.add(lot);

    // shop building, back-right
    const shop = makeBuildingBlock(9, 4.2, 6, 0xf0d9c0);
    shop.position.set(11, 0, -6);
    g.add(shop);
    const shopGlass = new THREE.Mesh(
      new THREE.BoxGeometry(3, 2.2, 0.15),
      new THREE.MeshPhongMaterial({ color: 0x4fb8c4, transparent: true, opacity: 0.75 })
    );
    shopGlass.position.set(9, 1.5, -2.93);
    g.add(shopGlass);

    [[-18, -2], [-18, 14], [18, -13]].forEach(([x, z]) => {
      const t = makeTree();
      t.position.set(x, 0, z);
      g.add(t);
    });

    // parking rows (two rows of 4 bays) with painted lines + chargers at the row head
    const rows = [-2, 8];
    rows.forEach((rowZ, rowIdx) => {
      for (let i = 0; i < 4; i++) {
        const x = -16 + i * 4.2;
        const line = makeLine(0.08, 5);
        line.position.set(x + 2.1, 0.02, rowZ);
        g.add(line);
        DEPOT_SPOTS.push(new THREE.Vector3(x, 0, rowZ));
      }
      const lastLine = makeLine(0.08, 5);
      lastLine.position.set(-16 + 4 * 4.2 + 2.1 - 4.2, 0.02, rowZ);
      if (rowIdx === 0) {
        for (let i = 0; i < 2; i++) {
          const ch = makeCharger();
          ch.position.set(-18, 0, rowZ + (i === 0 ? -2 : 2));
          g.add(ch);
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
    sunMesh.position.copy(sunLight.position);
    sunMesh.visible = elevAngle > -0.05;

    const dayColor = new THREE.Color(0x87ceeb);
    const duskColor = new THREE.Color(0xff9d5c);
    const nightColor = new THREE.Color(0x0b1230);
    let skyColor = t < 0.5
      ? dayColor.clone().lerp(duskColor, t * 2)
      : duskColor.clone().lerp(nightColor, (t - 0.5) * 2);
    scene.background = skyColor;
    scene.fog.color = skyColor;

    ambLight.intensity = THREE.MathUtils.lerp(0.65, 0.2, t);
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

  function popIn(obj, duration = 350) {
    obj.scale.setScalar(0.001);
    scaleTweens.push({ obj, elapsed: 0, duration, from: 0.001, to: 1 });
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
  let cityCap = 0;

  function citySetCap(cap) { cityCap = cap; }

  function cityAddTruckAt(worldPos) {
    if (cityTrucks.length >= cityCap) return false;
    const truck = makeTruck(0.75);
    truck.position.set(worldPos.x, 0, worldPos.z);
    truck.rotation.y = Math.random() * Math.PI * 2;
    groups.city.add(truck);
    popIn(truck);
    cityTrucks.push(truck);
    return true;
  }

  function citySetVisibleCount(n) {
    n = Math.max(0, Math.min(n, CITY_SPOTS.length));
    while (cityTrucks.length < n) {
      const spot = CITY_SPOTS[cityTrucks.length % CITY_SPOTS.length];
      const truck = makeTruck(0.7);
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
      const truck = makeTruck(0.85);
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

  function enterCity(cap) {
    showOnly('city');
    setDayPhase(0);
    citySetCap(cap);
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
  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  function onMouseMove(e) {
    mouseNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  }

  function onPointerDown(e) {
    if (!clickHandler) return;
    raycaster.setFromCamera(mouseNDC, camera);
    if (raycaster.ray.intersectPlane(groundPlane, hitPt)) {
      clickHandler(hitPt.clone());
    }
  }

  function setClickHandler(fn) { clickHandler = fn; }

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
    }

    renderer.render(scene, camera);
  }

  function init(canvas) {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 300);
    camera.position.set(0, 16, 24);
    camera.lookAt(0, 2, 0);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    ambLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambLight);

    sunLight = new THREE.DirectionalLight(0xfff3d6, 1.5);
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
      new THREE.MeshLambertMaterial({ color: 0x5a8c6a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    scene.fog = new THREE.FogExp2(0x87ceeb, 0.012);

    groups.splash = buildSplashGroup();
    groups.city = buildCityGroup();
    groups.depot = buildDepotGroup();
    Object.values(groups).forEach(g => { g.visible = false; scene.add(g); });

    addEventListener('resize', onResize);
    addEventListener('mousemove', onMouseMove);
    addEventListener('pointerdown', onPointerDown);

    updateSun();
    renderer.setAnimationLoop(tick);
  }

  return {
    init,
    enterSplash,
    enterCity,
    enterDepot,
    enterRecharge,
    citySetCap,
    cityAddTruckAt,
    citySetVisibleCount,
    cityReset,
    depotParkTrucks,
    depotReset,
    setClickHandler,
    get cityTruckCount() { return cityTrucks.length; },
  };
})();
