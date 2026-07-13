(function () {
  const state = {
    companyName: '',
    location: '',
    fleetSize: '',
    centralDepot: null,
    landOwnership: null,
    leaseRemainingYears: null,
    strataApproval: null,
    chargerRoom: null,
    opsStartHour: 7,
    opsEndHour: 18,
  };

  const TOTAL_STEPS = 7; // steps 0..6
  let currentStep = 0;

  FuseScene.init(document.getElementById('scene-canvas'));

  const stepEls = Array.from(document.querySelectorAll('.step'));
  const progressEl = document.getElementById('progress');

  function fleetCap(value) {
    const map = { '1-10': 6, '10-20': 10, '20-50': 16, '50+': 24 };
    return map[value] || 0;
  }

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
        FuseScene.showFleetGrid(fleetCap(state.fleetSize));
        break;
      case 3:
        // FuseScene.cityReset();
        // FuseScene.enterCity();
        syncHoursTrucks();
        break;
      case 4:
        FuseScene.depotReset();
        applyDepotState();
        break;
      case 5:
        FuseScene.depotReset();
        FuseScene.depotParkTrucks(Math.min(fleetCap(state.fleetSize) || 6, 8));
        FuseScene.enterRecharge();
        break;
      case 6:
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
  document.querySelectorAll('input[name="fleetSize"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.fleetSize = radio.value;
      FuseScene.showFleetGrid(fleetCap(state.fleetSize));
      nextButtonFor(2).disabled = false;
    });
  });

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
    nextButtonFor(4).disabled = !hasSelection;
    depotSubQuestions.classList.toggle('open', hasSelection);
    FuseScene.enterDepot(state.centralDepot === true);
    const count = state.centralDepot === true ? Math.min(fleetCap(state.fleetSize) || 6, 8) : 0;
    FuseScene.depotParkTrucks(count);
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
    if (currentStep !== 4) return;
    const fraction = Math.max(0, (state.opsEndHour - state.opsStartHour)) / 24;
    FuseScene.citySetVisibleCount(Math.round(fraction * 12));
  }

  opsStartEl.addEventListener('input', updateHoursUI);
  opsEndEl.addEventListener('input', updateHoursUI);
  updateHoursUI();

  // ---------- step 6: review + submit ----------
  const YES_NO = v => (v === null ? '—' : v ? 'Yes' : 'No');

  function renderSummary() {
    const rows = [
      ['Company', state.companyName || '—'],
      ['Location', state.location || '—'],
      ['Fleet size', state.fleetSize || '—'],
      ['Central depot', YES_NO(state.centralDepot)],
      ['Land ownership', state.landOwnership || '—'],
      ['Lease remaining (yrs)', state.leaseRemainingYears ?? '—'],
      ['Strata approval required', YES_NO(state.strataApproval)],
      ['Room for chargers', YES_NO(state.chargerRoom)],
      ['Operating hours', `${formatHour(state.opsStartHour)} – ${formatHour(state.opsEndHour)}`],
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
