(function () {
  const state = {
    companyName: '',
    province: '',
    mediumCount: 0,
    heavyCount: 0,
    fleet_size: 0,
    centralDepot: null,
    landOwnership: null,
    leaseRemainingYears: null,
    strataApproval: null,
    daily_km: 150,
    operating_hours: 9,
    pct_ev: 0,
    annual_fuel_spend: 0
  };

  const TOTAL_STEPS = 9;
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
    switch (n) {
      case 0: FuseScene.enterSplash(); break;
      case 1: FuseScene.enterSplash(); break;
      case 2:
        FuseScene.enterCity();
        FuseScene.hideCity();
        FuseScene.showFleetGrid(state.heavyCount, state.mediumCount);
        break;
      case 3: FuseScene.enterCity(); syncHoursTrucks(); break;
      case 4: FuseScene.enterCity(); break;
      case 5: FuseScene.enterCity(); break;
      case 6:
        FuseScene.enterDepot(true);
        applyDepotState();
        FuseScene.hidePowerlines();
        break;
      case 7:
        FuseScene.SetEvFraction(state.pct_ev / 100);
        FuseScene.showPowerlines();
        break;
      case 8: renderSummary(); break;
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
    state.fleet_size = medium + heavy;

    mediumFillEl.style.left = '0';
    mediumFillEl.style.width = (medium / Number(mediumCountEl.max)) * 100 + '%';
    mediumValueEl.textContent = `${medium} vehicle${medium === 1 ? '' : 's'}`;

    heavyFillEl.style.left = '0';
    heavyFillEl.style.width = (heavy / Number(heavyCountEl.max)) * 100 + '%';
    heavyValueEl.textContent = `${heavy} vehicle${heavy === 1 ? '' : 's'}`;

    nextButtonFor(2).disabled = (medium + heavy) === 0;
  }

  function redrawFleetGrid() {
    FuseScene.showFleetGrid(state.heavyCount, state.mediumCount);
    FuseScene.setDepotFleetSize(state.heavyCount + state.mediumCount);
  }

  mediumCountEl.addEventListener('input', updateFleetSizeUI);
  heavyCountEl.addEventListener('input', updateFleetSizeUI);
  mediumCountEl.addEventListener("mouseup", redrawFleetGrid);
  heavyCountEl.addEventListener("mouseup", redrawFleetGrid);
  updateFleetSizeUI();
  redrawFleetGrid();

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
    nextButtonFor(6).disabled = !hasSelection;
    depotSubQuestions.classList.toggle('open', hasSelection);
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
    state.operating_hours = e - s;
    hoursFillEl.style.left = (s / 24) * 100 + '%';
    hoursFillEl.style.width = ((e - s) / 24) * 100 + '%';
    hoursValueEl.textContent = `${formatHour(s)} – ${formatHour(e)}`;
    syncHoursTrucks();
  }

  function syncHoursTrucks() {
    if (currentStep !== 3) return;
    const fraction = Math.max(0, (state.operating_hours)) / 24;
  }

  opsStartEl.addEventListener('input', updateHoursUI);
  opsEndEl.addEventListener('input', updateHoursUI);
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

  const fuelSpendEl = document.getElementById('fuelSpend');

  function updateFuelSpendUI() {
    const digitsOnly = fuelSpendEl.value.replace(/[^\d]/g, '');
    if (digitsOnly !== fuelSpendEl.value) fuelSpendEl.value = digitsOnly;
    state.annual_fuel_spend = digitsOnly === '' ? 0 : Number(digitsOnly);
  }

  fuelSpendEl.addEventListener('input', updateFuelSpendUI);
  updateFuelSpendUI();

  const VALUE_ASSUMPTIONS = {
    heavyKwhPerKm: 1.8,
    mediumKwhPerKm: 0.9,
    chargerKw: 40,
  };

  function dominantVehicleSize() {
    return state.heavyCount >= state.mediumCount ? 'large' : 'medium';
  }

  function dailyKmBucket(km) {
    if (km < 50) return 'under_50';
    if (km < 100) return '50_100';
    if (km < 150) return '100_150';
    return '150_plus';
  }

  let calcRequestId = 0;

  async function fetchValueCalculation() {
    const requestId = ++calcRequestId;
    try {
      const res = await fetch("http://localhost:8001/calculate", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fleet_size: state.fleet_size,
          pct_ev: state.pct_ev,
          vehicle_size: dominantVehicleSize(),
          daily_km: dailyKmBucket(state.daily_km),
          operating_hours: state.operating_hours,
          province: state.province,
          annual_fuel_spend: state.annual_fuel_spend,
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

  async function updateValueCallout(amountElId) {
    const amountEl = document.getElementById(amountElId);
    const result = await fetchValueCalculation();
    if (!result) return;
    if (!amountEl) return;
    amountEl.textContent = formatCurrencyRange(result.total_benefit_low, result.total_benefit_high);
    amountEl.classList.toggle('negative', result.total_benefit_low < 0);
  }

  function v2gUptimeHoursFor(kwhPerKm) {
    const operatingHours = Math.max(0, state.operating_hours);
    const powerConsumed = state.daily_km * kwhPerKm;
    const rechargeTime = powerConsumed / VALUE_ASSUMPTIONS.chargerKw;
    return Math.max(0, 24 - operatingHours - rechargeTime);
  }

  function pluralize(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
  function formatHours(h) { return `${(Math.round(h * 10) / 10)} hour${Math.round(h * 10) === 10 ? '' : 's'}`; }

  const pct_evEl = document.getElementById('evPercent');
  const evFillEl = document.getElementById('evFill');
  const evValueEl = document.getElementById('evValue');

  let evValueDebounceTimer = null;

  function updateEvUI() {
    const pct = Number(pct_evEl.value);
    state.pct_ev = pct;
    evFillEl.style.left = '0';
    evFillEl.style.width = pct + '%';
    evValueEl.textContent = `${pct}% electric`;
    clearTimeout(evValueDebounceTimer);
    evValueDebounceTimer = setTimeout(() => updateValueCallout('evStepValueAmount'), 250);
    syncEvTrucks();
  }

  function syncEvTrucks() {
    if (currentStep !== 7) return;
    FuseScene.SetEvFraction(state.pct_ev / 100);
  }

  pct_evEl.addEventListener('input', updateEvUI);
  updateEvUI();

  async function renderSummary() {
    const amountEl = document.getElementById('valueAmount');
    const result = await fetchValueCalculation();
    if (result && amountEl) {
      amountEl.textContent = formatCurrencyRange(result.total_benefit_low, result.total_benefit_high);
      amountEl.classList.toggle('negative', result.total_benefit_low < 0);
    }

    const totalVehicles = state.heavyCount + state.mediumCount;
    const evHeavy = Math.round(state.heavyCount * (state.pct_ev / 100));
    const evMedium = Math.round(state.mediumCount * (state.pct_ev / 100));
    const totalEVs = evHeavy + evMedium;

    const operatingHours = Math.max(0, state.operating_hours);
    const hoursAtDepot = Math.max(0, 24 - operatingHours);

    const heavyUptime = v2gUptimeHoursFor(VALUE_ASSUMPTIONS.heavyKwhPerKm);
    const mediumUptime = v2gUptimeHoursFor(VALUE_ASSUMPTIONS.mediumKwhPerKm);
    const blendedUptime = totalEVs > 0
      ? (evHeavy * heavyUptime + evMedium * mediumUptime) / totalEVs
      : 0;

    const paragraphs = [];

    paragraphs.push(
      `${state.companyName || 'Your fleet'} runs <strong>${formatHour(state.operating_hours)}</strong> ` +
      `hours a day. That leaves <strong>${formatHours(hoursAtDepot)}</strong> overnight when every vehicle is parked back ` +
      `at the depot — downtime today that V2G turns into paid time.`
    );

    paragraphs.push(
      `Across your <strong>${pluralize(totalVehicles, 'vehicle')}</strong> — ${pluralize(state.heavyCount, 'heavy duty vehicle')} ` +
      `and ${pluralize(state.mediumCount, 'medium duty vehicle')} — moving <strong>${state.pct_ev}%</strong> to electric ` +
      (totalEVs > 0
        ? `puts <strong>${pluralize(totalEVs, 'EV')}</strong> on the road: ${pluralize(evHeavy, 'heavy duty')} and ` +
          `${pluralize(evMedium, 'medium duty')}.`
        : `hasn't put any EVs on the road yet — bump up the electrification slider to see the impact.`)
    );

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
      const res = await fetch("http://localhost:8001/contact", {
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
      const res = await fetch("http://localhost:8001/submit", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fleet_size: state.fleet_size,
          pct_ev: state.pct_ev,
          vehicle_size: dominantVehicleSize(),
          daily_km: dailyKmBucket(state.daily_km),
          operating_hours: state.operating_hours,
          province: state.province,
          annual_fuel_spend: state.annual_fuel_spend,
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