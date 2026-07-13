(function () {
  const state = {
    companyName: '',
    location: '',
    mediumCount: 0,
    heavyCount: 0,
    centralDepot: null,
    landOwnership: null,
    leaseRemainingYears: null,
    strataApproval: null,
    chargerRoom: null,
    opsStartHour: 7,
    opsEndHour: 18,
    avgDistanceKm: 150,
    evPercent: 0,
  };

  const TOTAL_STEPS = 8; // steps 0..7
  let currentStep = 0;

  FuseScene.init(document.getElementById('scene-canvas'));

  const stepEls = Array.from(document.querySelectorAll('.step'));
  const progressEl = document.getElementById('progress');

  // ---------- progress dots ----------
  function buildProgress() {
    progressEl.innerHTML = '';
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const d = document.createElement('div');
      d.className = 'dot';
      progressEl.appendChild(d);
    }
  }
  function updateProgress() {
    Array.from(progressEl.children).forEach((d, i) => {
      d.classList.toggle('active', i === currentStep);
      d.classList.toggle('done', i < currentStep);
    });
  }

  // ---------- step transitions ----------
  function goToStep(n) {
    stepEls.forEach(s => s.classList.toggle('active', Number(s.dataset.step) === n));
    currentStep = n;
    updateProgress();
    onEnterStep(n);
  }

  function onEnterStep(n) {
    switch (n) {
      case 0:
        FuseScene.enterSplash();
        break;
      case 1:
        FuseScene.enterSplash();
        break;
      case 2:
        FuseScene.enterCity();
        FuseScene.showFleetGrid(state.heavyCount, state.mediumCount);
        break;
      case 3:
        FuseScene.enterCity();
        FuseScene.cityPopIn();
        syncHoursTrucks();
        break;
      case 4:
        // FuseScene.enterCity();
        break;
      case 5:
        FuseScene.enterDepot(true);
        applyDepotState();
        break;
      case 6:
        FuseScene.SetEvFraction(state.evPercent / 100);
        break;
      case 7:
        renderSummary();
        break;
    }
  }

  // ---------- nav buttons ----------
  document.querySelectorAll('[data-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentStep < TOTAL_STEPS - 1) goToStep(currentStep + 1);
    });
  });
  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentStep > 0) goToStep(currentStep - 1);
    });
  });

  function nextButtonFor(step) {
    return document.querySelector(`.step[data-step="${step}"] [data-next]`);
  }

  // ---------- step 1: company ----------
  const companyNameEl = document.getElementById('companyName'); 
  const locationEl = document.getElementById('location');


  function validateStep1() {
    const ok = companyNameEl.value.trim().length > 0 && locationEl.value !== '';
    nextButtonFor(1).disabled = !ok;
    return ok;
  }
  companyNameEl.addEventListener('input', () => {
    state.companyName = companyNameEl.value.trim();
    validateStep1();
  });
  locationEl.addEventListener('change', () => {
    state.location = locationEl.value;
    validateStep1();
  });
 
  validateStep1();

  // ---------- step 2: fleet size ----------
  const mediumCountEl = document.getElementById('mediumCount');
  const mediumFillEl = document.getElementById('mediumFill');
  const mediumValueEl = document.getElementById('mediumValue');
  const heavyCountEl = document.getElementById('heavyCount');
  const heavyFillEl = document.getElementById('heavyFill');
  const heavyValueEl = document.getElementById('heavyValue');

  function updateFleetSizeUI() {
    const medium = Number(mediumCountEl.value);
    const heavy = Number(heavyCountEl.value);
    state.mediumCount = medium;
    state.heavyCount = heavy;

    mediumFillEl.style.left = '0';
    mediumFillEl.style.width = (medium / Number(mediumCountEl.max)) * 100 + '%';
    mediumValueEl.textContent = `${medium} vehicle${medium === 1 ? '' : 's'}`;

    heavyFillEl.style.left = '0';
    heavyFillEl.style.width = (heavy / Number(heavyCountEl.max)) * 100 + '%';
    heavyValueEl.textContent = `${heavy} vehicle${heavy === 1 ? '' : 's'}`;

    nextButtonFor(2).disabled = (medium + heavy) === 0;
  }

  // rebuilding the fleet grid is the expensive part, so only do it once the
  // user releases the slider (native 'change') rather than on every 'input'
  function redrawFleetGrid() {
    FuseScene.showFleetGrid(state.heavyCount, state.mediumCount);
  }

  mediumCountEl.addEventListener('input', updateFleetSizeUI);
  heavyCountEl.addEventListener('input', updateFleetSizeUI);
  mediumCountEl.addEventListener("mouseup", redrawFleetGrid);
  heavyCountEl.addEventListener("mouseup", redrawFleetGrid);
  updateFleetSizeUI();
  redrawFleetGrid();

  // ---------- step 3: depot ----------
  const depotCheckboxes = document.querySelectorAll('input[name="centralDepot"]');
  const depotSubQuestions = document.getElementById('depotSubQuestions');
  const leaseYearsQuestion = document.getElementById('leaseYearsQuestion');

  depotCheckboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        depotCheckboxes.forEach(other => { if (other !== cb) other.checked = false; });
        state.centralDepot = cb.value === 'yes';
      } else {
        const anyChecked = Array.from(depotCheckboxes).some(c => c.checked);
        if (!anyChecked) state.centralDepot = null;
      }
      applyDepotState();
    });
  });

  function applyDepotState() {
    const hasSelection = state.centralDepot !== null;
    nextButtonFor(5).disabled = !hasSelection;
    depotSubQuestions.classList.toggle('open', hasSelection);
    // FuseScene.enterDepot(true); //state.centralDepot === true
  }

  document.querySelectorAll('input[name="landOwnership"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.landOwnership = radio.value;
      leaseYearsQuestion.hidden = radio.value !== 'lease';
    });
  });
  document.getElementById('leaseYears').addEventListener('input', e => {
    state.leaseRemainingYears = e.target.value === '' ? null : Number(e.target.value);
  });
  document.querySelectorAll('input[name="strataApproval"]').forEach(radio => {
    radio.addEventListener('change', () => { state.strataApproval = radio.value === 'yes'; });
  });
  document.querySelectorAll('input[name="chargerRoom"]').forEach(radio => {
    radio.addEventListener('change', () => { state.chargerRoom = radio.value === 'yes'; });
  });

  // ---------- step 4: operating hours ----------
  const opsStartEl = document.getElementById('opsStart');
  const opsEndEl = document.getElementById('opsEnd');
  const hoursFillEl = document.getElementById('hoursFill');
  const hoursValueEl = document.getElementById('hoursValue');

  function formatHour(h) {
    h = ((h % 24) + 24) % 24;
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    const period = hh < 12 ? 'am' : 'pm';
    let displayH = hh % 12;
    if (displayH === 0) displayH = 12;
    return `${displayH}:${String(mm).padStart(2, '0')}${period}`;
  }

  function updateHoursUI() {
    let s = parseFloat(opsStartEl.value);
    let e = parseFloat(opsEndEl.value);
    if (s > e - 0.5) {
      if (document.activeElement === opsStartEl) { s = e - 0.5; opsStartEl.value = s; }
      else { e = s + 0.5; opsEndEl.value = e; }
    }
    state.opsStartHour = s;
    state.opsEndHour = e;
    hoursFillEl.style.left = (s / 24) * 100 + '%';
    hoursFillEl.style.width = ((e - s) / 24) * 100 + '%';
    hoursValueEl.textContent = `${formatHour(s)} – ${formatHour(e)}`;
    syncHoursTrucks();
  }

  function syncHoursTrucks() {
    if (currentStep !== 3) return;
    const fraction = Math.max(0, (state.opsEndHour - state.opsStartHour)) / 24;
    //FuseScene.citySetVisibleCount(Math.round(fraction * 12));
  }

  opsStartEl.addEventListener('input', updateHoursUI);
  opsEndEl.addEventListener('input', updateHoursUI);
  updateHoursUI();

  // ---------- step 4: average daily distance ----------
  const avgDistanceEl = document.getElementById('avgDistance');
  const distanceFillEl = document.getElementById('distanceFill');
  const distanceValueEl = document.getElementById('distanceValue');

  function updateDistanceUI() {
    const km = Number(avgDistanceEl.value);
    state.avgDistanceKm = km;
    distanceFillEl.style.left = '0';
    distanceFillEl.style.width = (km / Number(avgDistanceEl.max)) * 100 + '%';
    distanceValueEl.textContent = `${km} km/day`;
  }

  avgDistanceEl.addEventListener('input', updateDistanceUI);
  updateDistanceUI();

  // ---------- step 6: EV percentage ----------
  const evPercentEl = document.getElementById('evPercent');
  const evFillEl = document.getElementById('evFill');
  const evValueEl = document.getElementById('evValue');

  function updateEvUI() {
    const pct = Number(evPercentEl.value);
    state.evPercent = pct;
    evFillEl.style.left = '0';
    evFillEl.style.width = pct + '%';
    evValueEl.textContent = `${pct}% electric`;
    syncEvTrucks();
  }

  function syncEvTrucks() {
    if (currentStep !== 6) return;
    FuseScene.SetEvFraction(state.evPercent / 100);
  }

  evPercentEl.addEventListener('input', updateEvUI);
  updateEvUI();

  // ---------- step 7: review + submit ----------
  const YES_NO = v => (v === null ? '—' : v ? 'Yes' : 'No');

  // Placeholder market/vehicle assumptions — tune to real figures.
  const VALUE_ASSUMPTIONS = {
    heavyKwhPerKm: 1.8,        // full-size (heavy duty) bus energy use
    mediumKwhPerKm: 0.9,       // cutaway (medium duty) bus energy use
    chargerKw: 40,             // depot charger power rating
    pricePerKwh: 1.5,         // $ paid per kWh of V2G energy sold back to the grid
    heavyVehicleCost: 500000,  // incremental EV cost vs. diesel, heavy duty
    mediumVehicleCost: 150000,  // incremental EV cost vs. diesel, medium duty
    daysPerYear: 365,
  };

  // #EVs = fleetSize * %EVs
  // powerConsumed = distance * vehicle energy consumption
  // rechargeTime = powerConsumed / chargerKw
  // V2G uptime = 24 - operatingHours - rechargeTime
  // kWhReturned = V2G uptime / 2 * chargerKw
  // value = days * #EVs * kWhReturned * $/kWh - vehicleCost * #EVs
  function valueForFleet(count, kwhPerKm, vehicleCost) {
    const evCount = Math.round(count * (state.evPercent / 100));
    if (evCount <= 0) return 0;
    const operatingHours = Math.max(0, state.opsEndHour - state.opsStartHour);
    const powerConsumed = state.avgDistanceKm * kwhPerKm;
    const rechargeTime = powerConsumed / VALUE_ASSUMPTIONS.chargerKw;
    const v2gUptime = Math.max(0, 24 - operatingHours - rechargeTime);
    const kWhReturned = (v2gUptime) * VALUE_ASSUMPTIONS.chargerKw;
    return VALUE_ASSUMPTIONS.daysPerYear * evCount * kWhReturned * VALUE_ASSUMPTIONS.pricePerKwh
      - vehicleCost * evCount;
  }

  function computeExpectedValue() {
    return valueForFleet(state.heavyCount, VALUE_ASSUMPTIONS.heavyKwhPerKm, VALUE_ASSUMPTIONS.heavyVehicleCost)
      + valueForFleet(state.mediumCount, VALUE_ASSUMPTIONS.mediumKwhPerKm, VALUE_ASSUMPTIONS.mediumVehicleCost);
  }

  function renderValueCallout() {
    const expectedValue = computeExpectedValue();
    const amountEl = document.getElementById('valueAmount');
    const formatted = expectedValue.toLocaleString('en-CA', {
      style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
    });
    amountEl.textContent = formatted;
    amountEl.classList.toggle('negative', expectedValue < 0);
  }

  function renderSummary() {
    renderValueCallout();
    const totalEVs = Math.round((state.heavyCount + state.mediumCount) * (state.evPercent / 100));
    const rows = [
      ['Company', state.companyName || '—'],
      ['Location', state.location || '—'],
      ['Medium duty vehicles', state.mediumCount],
      ['Heavy duty vehicles', state.heavyCount],
      ['Central depot', YES_NO(state.centralDepot)],
      ['Land ownership', state.landOwnership || '—'],
      ['Lease remaining (yrs)', state.leaseRemainingYears ?? '—'],
      ['Strata approval required', YES_NO(state.strataApproval)],
      ['Room for chargers', YES_NO(state.chargerRoom)],
      ['Operating hours', `${formatHour(state.opsStartHour)} – ${formatHour(state.opsEndHour)}`],
      ['Average distance/day', `${state.avgDistanceKm} km`],
      ['EV percentage', `${state.evPercent}%`],
      ['Electric vehicles', totalEVs],
    ];
    const summaryEl = document.getElementById('summary');
    summaryEl.innerHTML = rows.map(([k, v]) =>
      `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`
    ).join('');
  }

  const toastEl = document.getElementById('toast');
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  document.getElementById('submitBtn').addEventListener('click', async () => {
    const btn = document.getElementById('submitBtn');
    const statusEl = document.getElementById('submitStatus');
    btn.disabled = true;
    statusEl.className = 'submit-status';
    statusEl.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'Submission failed');
      statusEl.className = 'submit-status ok';
      statusEl.textContent = `Submitted — reference #${data.id}`;
      showToast('Saved to database');
    } catch (err) {
      statusEl.className = 'submit-status err';
      statusEl.textContent = err.message;
      btn.disabled = false;
    }
  });

  // ---------- init ----------
  buildProgress();
  goToStep(0);
})();
