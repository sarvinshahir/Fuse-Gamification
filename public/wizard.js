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
    opsStartHour: 7,
    opsEndHour: 18,
    distance_km: 150,
    pct_ev: 0,
    annual_fuel_spend: 0
  };

  // const response = await fetch("http://localhost:8000/calculate", {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     fleet_size: updatedAnswers.fleet_size,
  //     pct_ev: updatedAnswers.pct_ev,
  //     vehicle_size: updatedAnswers.vehicle_size,
  //     daily_km: updatedAnswers.daily_km,
  //     operating_hours: updatedAnswers.operating_hours,
  //     province: updatedAnswers.province,
  //     annual_fuel_spend: updatedAnswers.annual_fuel_spend,
  //   }),
  // });

  const TOTAL_STEPS = 9; // steps 0..8
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
        FuseScene.hideCity();
        FuseScene.showFleetGrid(state.heavyCount, state.mediumCount);
        break;
      case 3:
        FuseScene.enterCity();
        syncHoursTrucks();
        break;
      case 4:
        FuseScene.enterCity();
        break;
      case 5:
        FuseScene.enterCity();
        break;
      case 6:
        FuseScene.enterDepot(true);
        applyDepotState();
        FuseScene.hidePowerlines();
        break;
      case 7:
        FuseScene.SetEvFraction(state.pct_ev / 100);
        FuseScene.showPowerlines();
        break;
      case 8:
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
    state.province = locationEl.value;
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
    FuseScene.setDepotFleetSize(state.heavyCount + state.mediumCount);
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

  // document.querySelectorAll('input[name="chargerRoom"]').forEach(radio => {
  //   radio.addEventListener('change', () => { state.chargerRoom = radio.value === 'yes'; });
  // });

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
    state.distance_km = km;
    distanceFillEl.style.left = '0';
    distanceFillEl.style.width = (km / Number(avgDistanceEl.max)) * 100 + '%';
    distanceValueEl.textContent = `${km} km/day`;
  }

  function updateCity(){
    
    const km = Number(avgDistanceEl.value);
    FuseScene.setDistanceZoom(km);
    FuseScene.setCityExtent(km);
  }

  avgDistanceEl.addEventListener('input', updateDistanceUI);
  avgDistanceEl.addEventListener("mouseup", updateCity);
  updateDistanceUI();
  updateCity()

  // ---------- step 5: average annual fuel spend ----------
  const fuelSpendEl = document.getElementById('fuelSpend');

  function updateFuelSpendUI() {
    // strip anything that isn't a digit so only whole numbers can ever land in state
    const digitsOnly = fuelSpendEl.value.replace(/[^\d]/g, '');
    if (digitsOnly !== fuelSpendEl.value) fuelSpendEl.value = digitsOnly;
    state.annual_fuel_spend = digitsOnly === '' ? 0 : Number(digitsOnly);
  }

  fuelSpendEl.addEventListener('input', updateFuelSpendUI);
  updateFuelSpendUI();

  // ---------- V2G expected value calculation (used by both the EV% step and review) ----------
  // Placeholder market/vehicle assumptions — tune to real figures.
  const VALUE_ASSUMPTIONS = {
    heavyKwhPerKm: 1.8,        // full-size (heavy duty) bus energy use
    mediumKwhPerKm: 0.9,       // cutaway (medium duty) bus energy use
    chargerKw: 40,             // depot charger power rating
    pricePerKwh: 1.5,          // $ paid per kWh of V2G energy sold back to the grid
    heavyVehicleCost: 500000,  // incremental EV cost vs. diesel, heavy duty
    mediumVehicleCost: 150000, // incremental EV cost vs. diesel, medium duty
    daysPerYear: 365,
  };

  // #EVs = fleetSize * %EVs
  // powerConsumed = distance * vehicle energy consumption
  // rechargeTime = powerConsumed / chargerKw
  // V2G uptime = 24 - operatingHours - rechargeTime
  // kWhReturned = V2G uptime / 2 * chargerKw
  // value = days * #EVs * kWhReturned * $/kWh - vehicleCost * #EVs
  function valueForFleet(count, kwhPerKm, vehicleCost) {
    const evCount = Math.round(count * (state.pct_ev / 100));
    if (evCount <= 0) return 0;
    const operatingHours = Math.max(0, state.opsEndHour - state.opsStartHour);
    const powerConsumed = state.distance_km * kwhPerKm;
    const rechargeTime = powerConsumed / VALUE_ASSUMPTIONS.chargerKw;
    const v2gUptime = Math.max(0, 24 - operatingHours - rechargeTime);
    const kWhReturned = (v2gUptime) * VALUE_ASSUMPTIONS.chargerKw;
    return VALUE_ASSUMPTIONS.daysPerYear * evCount * kWhReturned * VALUE_ASSUMPTIONS.pricePerKwh;
    //remove vehicle cost for now
    //  - vehicleCost * evCount;
  }

  function computeExpectedValue() {
    return valueForFleet(state.heavyCount, VALUE_ASSUMPTIONS.heavyKwhPerKm, VALUE_ASSUMPTIONS.heavyVehicleCost)
      + valueForFleet(state.mediumCount, VALUE_ASSUMPTIONS.mediumKwhPerKm, VALUE_ASSUMPTIONS.mediumVehicleCost);
  }

  // updates any value-callout amount element (by id) with the current expected value
  function updateValueCallout(amountElId) {
    const amountEl = document.getElementById(amountElId);
    if (!amountEl) return;
    const expectedValue = computeExpectedValue();
    amountEl.textContent = expectedValue.toLocaleString('en-CA', {
      style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
    });
    amountEl.classList.toggle('negative', expectedValue < 0);
  }

  // hours a single vehicle of this type has left to sell power back to the
  // grid each day, after its commute and its own recharge are accounted for
  function v2gUptimeHoursFor(kwhPerKm) {
    const operatingHours = Math.max(0, state.opsEndHour - state.opsStartHour);
    const powerConsumed = state.distance_km * kwhPerKm;
    const rechargeTime = powerConsumed / VALUE_ASSUMPTIONS.chargerKw;
    return Math.max(0, 24 - operatingHours - rechargeTime);
  }

  function pluralize(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
  function formatHours(h) { return `${(Math.round(h * 10) / 10)} hour${Math.round(h * 10) === 10 ? '' : 's'}`; }

  // ---------- step 6: EV percentage ----------
  const pct_evEl = document.getElementById('evPercent');
  const evFillEl = document.getElementById('evFill');
  const evValueEl = document.getElementById('evValue');

  function updateEvUI() {
    const pct = Number(pct_evEl.value);
    state.pct_ev = pct;
    evFillEl.style.left = '0';
    evFillEl.style.width = pct + '%';
    evValueEl.textContent = `${pct}% electric`;
    updateValueCallout('evStepValueAmount');
    syncEvTrucks();
  }

  function syncEvTrucks() {
    if (currentStep !== 7) return;
    FuseScene.SetEvFraction(state.pct_ev / 100);
  }

  pct_evEl.addEventListener('input', updateEvUI);
  updateEvUI();

  // ---------- step 7: review + submit ----------
  function renderSummary() {
    updateValueCallout('valueAmount');

    const totalVehicles = state.heavyCount + state.mediumCount;
    const evHeavy = Math.round(state.heavyCount * (state.pct_ev / 100));
    const evMedium = Math.round(state.mediumCount * (state.pct_ev / 100));
    const totalEVs = evHeavy + evMedium;

    const operatingHours = Math.max(0, state.opsEndHour - state.opsStartHour);
    const hoursAtDepot = Math.max(0, 24 - operatingHours);

    const heavyUptime = v2gUptimeHoursFor(VALUE_ASSUMPTIONS.heavyKwhPerKm);
    const mediumUptime = v2gUptimeHoursFor(VALUE_ASSUMPTIONS.mediumKwhPerKm);
    const blendedUptime = totalEVs > 0
      ? (evHeavy * heavyUptime + evMedium * mediumUptime) / totalEVs
      : 0;

    const paragraphs = [];

    paragraphs.push(
      `${state.companyName || 'Your fleet'} runs from <strong>${formatHour(state.opsStartHour)}</strong> ` +
      `to <strong>${formatHour(state.opsEndHour)}</strong> — ${pluralize(Math.round(operatingHours * 10) / 10, 'hour')} ` +
      `a day. That leaves <strong>${formatHours(hoursAtDepot)}</strong> overnight when every vehicle is parked back ` +
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
        ? `At <strong>${state.distance_km} km</strong> of driving a day, each EV still has about ` +
          `<strong>${formatHours(blendedUptime)}</strong> a day free to return power to the grid after its own ` +
          `recharge — worth an estimated <strong>${computeExpectedValue().toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })}</strong> a year across your fleet.`
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

  // ---------- post-submit contact modal ----------
  const contactModalEl = document.getElementById('contactModal');
  let lastSubmissionId = null;

  document.getElementById('contactModalClose').addEventListener('click', () => {
    contactModalEl.classList.remove('show');
  });
  contactModalEl.addEventListener('click', e => {
    if (e.target === contactModalEl) contactModalEl.classList.remove('show');
  });

  // Captures a lead's own contact info (separate from the fleet scorecard
  // submission above) so Fuse can follow up. Keyed on email so that once
  // account login exists, this same record can become their account.
  const contactNameEl = document.getElementById('contactName');
  const contactEmailEl = document.getElementById('contactEmail');
  const contactPhoneEl = document.getElementById('contactPhone');
  const contactSaveBtn = document.getElementById('contactSaveBtn');
  const contactSaveStatusEl = document.getElementById('contactSaveStatus');

  contactSaveBtn.addEventListener('click', async () => {
    const name = contactNameEl.value.trim();
    const email = contactEmailEl.value.trim();
    const phone = contactPhoneEl.value.trim();
    if (!name || !email) {
      contactSaveStatusEl.className = 'contact-save-status err';
      contactSaveStatusEl.textContent = 'Name and email are required.';
      return;
    }
    contactSaveBtn.disabled = true;
    contactSaveStatusEl.className = 'contact-save-status';
    contactSaveStatusEl.textContent = 'Saving…';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone: phone || null, submissionId: lastSubmissionId }),
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
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'Submission failed');
      statusEl.className = 'submit-status ok';
      statusEl.textContent = `Submitted — reference #${data.id}`;
      lastSubmissionId = data.id;
      saved = true;
    } catch (err) {
      statusEl.className = 'submit-status err';
      statusEl.textContent = err.message;
      btn.disabled = false;
    }
    // show the toast + contact modal either way — a backend hiccup shouldn't
    // block the user from seeing the value prop / how to get in touch
    showToast(saved ? 'Saved to database' : "Couldn't save, but here's how to reach us");
    contactModalEl.classList.add('show');
  });

  // ---------- init ----------
  buildProgress();
  goToStep(0);
})();
