(function () {
  function getOrCreateSessionId() {
    const key = 'fuseSessionId';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      sessionStorage.setItem(key, id);
    }
    return id;
  }

  const state = {
    session_id: getOrCreateSessionId(),
    companyName: '',
    province: '',
    smallCount: 0,
    largeCount: 0,
    fleet_size: 0,
    centralDepot: null,
    depotEvening: null,
    landOwnership: null,
    leaseRemainingYears: null,
    // strataApproval: null,
    daily_km: 150,
    morning_start: 7,
    morning_end: 9,
    afternoon_start: 14,
    afternoon_end: 16.5,
    electrification_interest: 5,
    pct_ev: 0,
    annual_fuel_spend: 0
  };

  const TOTAL_STEPS = 8;
  let currentStep = 0;

  FuseScene.init(document.getElementById('scene-canvas'));

  const stepEls = Array.from(document.querySelectorAll('.step'));
  const progressEl = document.getElementById('progress');

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

  function goToStep(n) {
    stepEls.forEach(s => s.classList.toggle('active', Number(s.dataset.step) === n));
    currentStep = n;
    updateProgress();
    onEnterStep(n);
  }

  function onEnterStep(n) {
    FuseScene.setExhaustEnabled(n >= 6);
    switch (n) {
      case 0: FuseScene.enterSplash(); break;
      case 1: FuseScene.enterSplash(); break;
      case 2:
        FuseScene.enterCity();
        FuseScene.hideCity();
        FuseScene.showFleetGrid(fleetCounts());
        break;
      case 3: FuseScene.enterCity(); syncHoursTrucks(); break;
      case 4: FuseScene.enterCity(); break;
      case 5:
        FuseScene.enterDepot(true);
        applyDepotState();
        FuseScene.hidePowerlines();
        break;
      case 6:
        FuseScene.SetEvFraction(state.pct_ev / 100);
        FuseScene.showPowerlines();
        break;
      case 7: renderSummary(); break;
    }
  }

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
    state.province = locationEl.value;
    validateStep1();
  });
  validateStep1();

  const BUS_TYPES = ['small', 'large'];

  const typeSmallEl = document.getElementById('typeSmallCount');
  const typeSmallFillEl = document.getElementById('typeSmallFill');
  const typeSmallValueEl = document.getElementById('typeSmallValue');

  const typeLargeEl = document.getElementById('typeLargeCount');
  const typeLargeFillEl = document.getElementById('typeLargeFill');
  const typeLargeValueEl = document.getElementById('typeLargeValue');

  function fleetCounts() {
    return {
      small: state.smallCount,
      large: state.largeCount,
    };
  }

  function updateFleetSizeUI() {
    let total = 0;

    const smallCount = Number(typeSmallEl.value);
    state.smallCount = smallCount;
    total += smallCount;
    typeSmallFillEl.style.left = '0';
    typeSmallFillEl.style.width = (smallCount / Number(typeSmallEl.max)) * 100 + '%';
    typeSmallValueEl.textContent = `${smallCount} vehicle${smallCount === 1 ? '' : 's'}`;

    const largeCount = Number(typeLargeEl.value);
    state.largeCount = largeCount;
    total += largeCount;
    typeLargeFillEl.style.left = '0';
    typeLargeFillEl.style.width = (largeCount / Number(typeLargeEl.max)) * 100 + '%';
    typeLargeValueEl.textContent = `${largeCount} vehicle${largeCount === 1 ? '' : 's'}`;

    state.fleet_size = total;

    nextButtonFor(2).disabled = total === 0;
    updateFuelSavingsCallout();
  }

  function redrawFleetGrid() {
    FuseScene.showFleetGrid(fleetCounts());
    FuseScene.setDepotFleetSize(state.fleet_size);
  }

  typeSmallEl.addEventListener('input', updateFleetSizeUI);
  typeSmallEl.addEventListener('mouseup', redrawFleetGrid);
  typeLargeEl.addEventListener('input', updateFleetSizeUI);
  typeLargeEl.addEventListener('mouseup', redrawFleetGrid);
  updateFleetSizeUI();
  redrawFleetGrid();

  const depotCheckboxes = document.querySelectorAll('input[name="centralDepot"]');
  const depotEveningCheckboxes = document.querySelectorAll('input[name="depotEvening"]');
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

  depotEveningCheckboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        depotEveningCheckboxes.forEach(other => { if (other !== cb) other.checked = false; });
        state.depotEvening = cb.value === 'yes';
      } else {
        const anyChecked = Array.from(depotEveningCheckboxes).some(c => c.checked);
        if (!anyChecked) state.depotEvening = null;
      }
      applyDepotState();
    });
  });

  function applyDepotState() {
    const hasSelection = state.centralDepot !== null && state.depotEvening !== null;
    nextButtonFor(5).disabled = !hasSelection;
    depotSubQuestions.classList.toggle('open', state.centralDepot !== null);
  }

  document.querySelectorAll('input[name="landOwnership"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.landOwnership = radio.value;
      leaseYearsQuestion.hidden = radio.value === 'own';
    });
  });

  document.getElementById('leaseYears').addEventListener('input', e => {
    state.leaseRemainingYears = e.target.value === '' ? null : Number(e.target.value);
  });

  // document.querySelectorAll('input[name="strataApproval"]').forEach(radio => {
  //   radio.addEventListener('change', () => { state.strataApproval = radio.value === 'yes'; });
  // });

  const opsStartAMEl = document.getElementById('opsStartAM');
  const opsEndAMEl = document.getElementById('opsEndAM');
  const hoursFillAMEl = document.getElementById('hoursFillAM');
  const hoursValueAMEl = document.getElementById('hoursValueAM');

  const opsStartPMEl = document.getElementById('opsStartPM');
  const opsEndPMEl = document.getElementById('opsEndPM');
  const hoursFillPMEl = document.getElementById('hoursFillPM');
  const hoursValuePMEl = document.getElementById('hoursValuePM');

  function formatHour(h) {
    h = ((h % 24) + 24) % 24;
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    const period = hh < 12 ? 'am' : 'pm';
    let displayH = hh % 12;
    if (displayH === 0) displayH = 12;
    return `${displayH}:${String(mm).padStart(2, '0')}${period}`;
  }

  function updateRouteRangeUI(startEl, endEl, fillEl, valueEl) {
    let s = parseFloat(startEl.value);
    let e = parseFloat(endEl.value);
    if (s > e - 0.5) {
      if (document.activeElement === startEl) { s = e - 0.5; startEl.value = s; }
      else { e = s + 0.5; endEl.value = e; }
    }
    fillEl.style.left = (s / 24) * 100 + '%';
    fillEl.style.width = ((e - s) / 24) * 100 + '%';
    valueEl.textContent = `${formatHour(s)} – ${formatHour(e)}`;
    return e - s;
  }

  function updateHoursUI() {
    updateRouteRangeUI(opsStartAMEl, opsEndAMEl, hoursFillAMEl, hoursValueAMEl);
    updateRouteRangeUI(opsStartPMEl, opsEndPMEl, hoursFillPMEl, hoursValuePMEl);
    state.morning_start = parseFloat(opsStartAMEl.value);
    state.morning_end = parseFloat(opsEndAMEl.value);
    state.afternoon_start = parseFloat(opsStartPMEl.value);
    state.afternoon_end = parseFloat(opsEndPMEl.value);
    syncHoursTrucks();
  }

  function totalOperatingHours() {
    return (state.morning_end - state.morning_start) + (state.afternoon_end - state.afternoon_start);
  }

  function syncHoursTrucks() {
    if (currentStep !== 3) return;
    const fraction = Math.max(0, totalOperatingHours()) / 24;
  }

  opsStartAMEl.addEventListener('input', updateHoursUI);
  opsEndAMEl.addEventListener('input', updateHoursUI);
  opsStartPMEl.addEventListener('input', updateHoursUI);
  opsEndPMEl.addEventListener('input', updateHoursUI);
  updateHoursUI();

  const avgDistanceEl = document.getElementById('avgDistance');
  const distanceFillEl = document.getElementById('distanceFill');
  const distanceValueEl = document.getElementById('distanceValue');

  function updateDistanceUI() {
    const km = Number(avgDistanceEl.value);
    state.daily_km = km;
    distanceFillEl.style.left = '0';
    distanceFillEl.style.width = (km / Number(avgDistanceEl.max)) * 100 + '%';
    distanceValueEl.textContent = `${km} km/day`;
  }

  function updateCity() {
    const km = Number(avgDistanceEl.value);
    FuseScene.setDistanceZoom(km);
    FuseScene.setCityExtent(km);
  }

  avgDistanceEl.addEventListener('input', updateDistanceUI);
  avgDistanceEl.addEventListener("mouseup", updateCity);
  updateDistanceUI();
  updateCity();

  function updateFuelSavingsCallout() {
    const totalSpend = state.annual_fuel_spend * state.fleet_size;

    const fuelAmountEl = document.getElementById('fuelSavingsAmount');
    if (fuelAmountEl) {
      fuelAmountEl.textContent = formatCurrency(totalSpend);
      fuelAmountEl.classList.toggle('negative', totalSpend < 0);
    }

    const interestSavings = totalSpend * (state.pct_ev / 100);
    const interestAmountEl = document.getElementById('interestStepFuelSavingsAmount');
    if (interestAmountEl) {
      interestAmountEl.textContent = formatCurrency(interestSavings);
      interestAmountEl.classList.toggle('negative', interestSavings < 0);
    }

    const interestHintEl = document.getElementById('interestHint');
    if (interestHintEl) {
      const electrifiedCount = Math.round(state.fleet_size * (state.pct_ev / 100));
      interestHintEl.textContent = electrifiedCount > 0
        ? `Electrifying ${electrifiedCount} busses cuts fuel spend directly.`
        : `Swapping buses to electric cuts fuel spend directly.`;
    }
  }

  updateFuelSavingsCallout();

  const VALUE_ASSUMPTIONS = {
    smallKwhPerKm: 0.75,
    largeKwhPerKm: 1.6,
    chargerKw: 40,
  };

  let calcRequestId = 0;

  async function fetchValueCalculation() {
    const requestId = ++calcRequestId;
    try {
      const res = await fetch("http://localhost:8000/calculate", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: state.session_id,
          small_count: state.smallCount,
          standard_count: state.largeCount,
          daily_km: state.daily_km,
          morning_start: state.morning_start,
          morning_end: state.morning_end,
          afternoon_start: state.afternoon_start,
          afternoon_end: state.afternoon_end,
          available_5_9pm: !!state.depotEvening,
          central_depot: !!state.centralDepot,
          province: state.province,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return requestId === calcRequestId ? data : null;
    } catch (err) {
      return null;
    }
  }

  function formatCurrency(amount) {
    return amount.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
  }

  function formatCurrencyRange(low, high) {
    return `${formatCurrency(low)} – ${formatCurrency(high)}`;
  }

  function v2gUptimeHoursFor(kwhPerKm) {
    const operatingHours = Math.max(0, totalOperatingHours());
    const powerConsumed = state.daily_km * kwhPerKm;
    const rechargeTime = powerConsumed / VALUE_ASSUMPTIONS.chargerKw;
    return Math.max(0, 24 - operatingHours - rechargeTime);
  }

  function pluralize(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
  function formatHours(h) { return `${(Math.round(h * 10) / 10)} hour${Math.round(h * 10) === 10 ? '' : 's'}`; }

  const interestEl = document.getElementById('electrificationInterest');
  const interestFillEl = document.getElementById('interestFill');
  const interestValueEl = document.getElementById('interestValue');

  function updateInterestUI() {
    const val = Number(interestEl.value);
    state.electrification_interest = val;
    const min = Number(interestEl.min);
    const max = Number(interestEl.max);
    interestFillEl.style.left = '0';
    interestFillEl.style.width = ((val - min) / (max - min)) * 100 + '%';
    interestValueEl.textContent = `${val} / 10`;

    state.pct_ev = val * 10;
    updateFuelSavingsCallout();
    syncEvTrucks();
  }

  function syncEvTrucks() {
    if (currentStep !== 6) return;
    FuseScene.SetEvFraction(state.pct_ev / 100);
  }

  interestEl.addEventListener('input', updateInterestUI);
  updateInterestUI();

  async function renderSummary() {
    const amountEl = document.getElementById('valueAmount');
    const calloutEl = document.getElementById('reviewValueCallout');
    if (calloutEl) calloutEl.hidden = true;
    const result = await fetchValueCalculation();
    if (result && amountEl) {
      amountEl.textContent = formatCurrencyRange(result.total_benefit_low, result.total_benefit_high);
      amountEl.classList.toggle('negative', result.total_benefit_low < 0);
      if (calloutEl) calloutEl.hidden = false;
    }

    const totalVehicles = state.fleet_size;
    const evCounts = {};
    let totalEVs = 0;
    BUS_TYPES.forEach(type => {
      const evCount = Math.round(state[`${type}Count`] * (state.pct_ev / 100));
      evCounts[type] = evCount;
      totalEVs += evCount;
    });

    const operatingHours = Math.max(0, totalOperatingHours());
    const hoursAtDepot = Math.max(0, 24 - operatingHours);

    const uptimeByType = {};
    BUS_TYPES.forEach(type => {
      uptimeByType[type] = v2gUptimeHoursFor(VALUE_ASSUMPTIONS[`${type}KwhPerKm`]);
    });
    const blendedUptime = totalEVs > 0
      ? BUS_TYPES.reduce((sum, type) => sum + evCounts[type] * uptimeByType[type], 0) / totalEVs
      : 0;

    const paragraphs = [];

    // paragraphs.push(
    //   `Across your <strong>${pluralize(totalVehicles, 'vehicle')}</strong> — ` +
    //   `${BUS_TYPES.map(type => pluralize(state[`type${type}Count`], `Type ${type} vehicle`)).join(', ')} — ` +
    //   `moving <strong>${state.pct_ev}%</strong> to electric ` +
    //   (totalEVs > 0
    //     ? `puts <strong>${pluralize(totalEVs, 'EV')}</strong> on the road: ` +
    //       `${BUS_TYPES.map(type => pluralize(evCounts[type], `Type ${type}`)).join(', ')}.`
    //     : `hasn't put any EVs on the road yet — bump up the electrification slider to see the impact.`)
    // );

    paragraphs.push(
      totalEVs > 0
        ? (result
            ? `At <strong>${state.daily_km} km</strong> of driving a day, each EV still has about ` +
              `<strong>${formatHours(blendedUptime)}</strong> a day free to return power to the grid after its own ` +
              `recharge — worth an estimated <strong>${formatCurrencyRange(result.v2g_revenue_low, result.v2g_revenue_high)}</strong> ` +
              `a year across your fleet` +
              (result.diesel_savings > 0
                ? `, including <strong>${formatCurrency(result.diesel_savings)}</strong> in fuel spend avoided by going electric.`
                : `.`)
            : `Crunching the numbers on your V2G value…`)
        : `Once some of your fleet goes electric, this is where you'll see how much daily driving distance leaves ` +
          `for selling power back to the grid — and what that's worth over a year.`
    );

    document.getElementById('summary').innerHTML = paragraphs.map(p => `<p>${p}</p>`).join('');
  }

  const toastEl = document.getElementById('toast');
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  const contactModalEl = document.getElementById('contactModal');
  let lastSubmissionId = null;

  document.getElementById('contactModalClose').addEventListener('click', () => {
    contactModalEl.classList.remove('show');
  });
  contactModalEl.addEventListener('click', e => {
    if (e.target === contactModalEl) contactModalEl.classList.remove('show');
  });

  const contactNameEl = document.getElementById('contactName');
  const contactEmailEl = document.getElementById('contactEmail');
  const contactPhoneEl = document.getElementById('contactPhone');
  const contactSaveBtn = document.getElementById('contactSaveBtn');
  const contactSaveStatusEl = document.getElementById('contactSaveStatus');

  contactSaveBtn.addEventListener('click', async () => {
    const contact_name = contactNameEl.value.trim();
    const email = contactEmailEl.value.trim();
    const phone = contactPhoneEl.value.trim();
    if (!contact_name || !email) {
      contactSaveStatusEl.className = 'contact-save-status err';
      contactSaveStatusEl.textContent = 'Name and email are required.';
      return;
    }
    contactSaveBtn.disabled = true;
    contactSaveStatusEl.className = 'contact-save-status';
    contactSaveStatusEl.textContent = 'Saving…';
    try {
      const res = await fetch("http://localhost:8000/contact", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: lastSubmissionId || 0,
          contact_name: contact_name,
          company_name: state.companyName,
          email: email,
          phone: phone,
          fleet_size: state.fleet_size,
          ev_count: Math.round(state.fleet_size * state.pct_ev / 100),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'Could not save your info');
      contactSaveStatusEl.className = 'contact-save-status ok';
      contactSaveStatusEl.textContent = "Thanks — we'll be in touch!";
    } catch (err) {
      contactSaveStatusEl.className = 'contact-save-status err';
      contactSaveStatusEl.textContent = err.message;
      contactSaveBtn.disabled = false;
    }
  });

  document.getElementById('submitBtn').addEventListener('click', async () => {
    const btn = document.getElementById('submitBtn');
    const statusEl = document.getElementById('submitStatus');
    btn.disabled = true;
    statusEl.className = 'submit-status';
    statusEl.textContent = 'Submitting…';
    let saved = false;
    try {
      const res = await fetch("http://localhost:8000/submit", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: state.session_id,
          small_count: state.smallCount,
          standard_count: state.largeCount,
          daily_km: state.daily_km,
          morning_start: state.morning_start,
          morning_end: state.morning_end,
          afternoon_start: state.afternoon_start,
          afternoon_end: state.afternoon_end,
          available_5_9pm: !!state.depotEvening,
          central_depot: !!state.centralDepot,
          province: state.province,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'Submission failed');
      statusEl.className = 'submit-status ok';
      statusEl.textContent = `Submitted — reference #${data.submission_id}`;
      lastSubmissionId = data.submission_id;
      saved = true;
    } catch (err) {
      statusEl.className = 'submit-status err';
      statusEl.textContent = err.message;
      btn.disabled = false;
    }
    showToast(saved ? 'Saved to database' : "Couldn't save, but here's how to reach us");
    contactModalEl.classList.add('show');
  });

  buildProgress();
  goToStep(0);
})();