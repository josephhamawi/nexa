/* Dashboard renderer.

   Runs with context isolation on; the only bridge to the main process is
   window.bls, defined in preload.ts. No Node access, no remote module. */

const $ = (id) => document.getElementById(id);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

let latest = null;
let cooldownTimer = null;

/* ── Theme: light by default, dark and system on request ─────────────────── */

const THEME_KEY = 'bls-theme-preference';
const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(choice) {
  const resolved = choice === 'system' ? (systemQuery.matches ? 'dark' : 'light') : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private mode: the theme simply resets next launch */
  }
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
  }
}

systemQuery.addEventListener('change', () => {
  if (storedTheme() === 'system') applyTheme('system');
});

applyTheme(storedTheme());

/* ── Formatting ──────────────────────────────────────────────────────────── */

function formatDateLong(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return isoDate || '-';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function clockOf(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString([], { hour12: false });
}

function dayOf(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return formatDateLong(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  );
}

function relativeFrom(iso) {
  if (!iso) return '-';
  const delta = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(delta)) return '-';
  if (delta <= 0) return 'due now';
  const minutes = Math.floor(delta / 60000);
  const seconds = Math.round((delta % 60000) / 1000);
  return minutes > 0 ? `in ${minutes}m ${String(seconds).padStart(2, '0')}s` : `in ${seconds}s`;
}

function titleCase(status) {
  return status
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

function dotClassFor(state) {
  switch (state.status) {
    case 'AVAILABLE':
      return 'found';
    case 'MONITORING':
      return 'running';
    case 'NOT_AVAILABLE':
      return state.runState === 'RUNNING' ? 'running' : 'idle';
    case 'CAPTCHA_REQUIRED':
    case 'HUMAN_VERIFICATION_REQUIRED':
    case 'LOGIN_REQUIRED':
    case 'SESSION_EXPIRED':
    case 'PAUSED':
      return 'warn';
    case 'ERROR':
    case 'SITE_UNAVAILABLE':
      return 'error';
    default:
      return 'idle';
  }
}

function setTag(el, text, tone) {
  el.textContent = text;
  el.className = `tag ${tone}`;
}

/* ── Render ──────────────────────────────────────────────────────────────── */

function render(state) {
  if (!state) return;
  latest = state;

  const identity = state.identity;
  $('visa-type').textContent = identity.visaSubCategory
    ? `${identity.visaType}, ${identity.visaSubCategory}`
    : identity.visaType;
  $('applicant-summary').textContent =
    identity.applicantType === 'Individual'
      ? 'Individual applicant'
      : `${identity.applicantType} of ${identity.memberCount}`;
  $('status-label').textContent = titleCase(state.status);
  $('status-dot').className = `dot ${dotClassFor(state)}`;
  $('availability-message').textContent = state.availabilityMessage;

  $('last-check').textContent = clockOf(state.lastCheck);
  $('last-check-date').textContent = state.lastCheck ? dayOf(state.lastCheck) : 'not yet run';
  $('next-check').textContent = state.nextCheck ? clockOf(state.nextCheck) : '-';
  $('next-check-in').textContent = state.nextCheck ? relativeFrom(state.nextCheck) : 'not scheduled';
  $('interval').textContent = `${Math.round(state.intervalRange.minSeconds / 60)}-${Math.round(
    state.intervalRange.maxSeconds / 60,
  )} min`;
  $('backoff-note').textContent =
    state.intervalRange.tier === 'normal'
      ? ''
      : `Error backoff active (${state.intervalRange.tier}) after ${state.errorCount} error${
          state.errorCount === 1 ? '' : 's'
        }.`;

  $('stat-checks').textContent = state.stats.checksToday;
  $('stat-found').textContent = state.stats.appointmentsFound;
  $('stat-errors').textContent = state.stats.errorsToday;

  if (state.sessionStatus === 'AUTHENTICATED') setTag($('session-status'), 'Authenticated', 'ok');
  else if (state.sessionStatus === 'LOGIN_REQUIRED') setTag($('session-status'), 'Login required', 'warn');
  else setTag($('session-status'), 'Unknown', 'neutral');

  if (state.browserInUse) setTag($('browser-status'), 'In use by you', 'warn');
  else setTag($('browser-status'), state.browserOpen ? 'Open' : 'Closed', state.browserOpen ? 'ok' : 'neutral');

  const telegram = state.notifications.telegram;
  setTag(
    $('ch-telegram'),
    telegram === 'connected' ? 'Connected' : telegram === 'disabled' ? 'Disabled' : 'Not configured',
    telegram === 'connected' ? 'ok' : telegram === 'disabled' ? 'off' : 'warn',
  );
  setTag(
    $('ch-desktop'),
    state.notifications.desktop === 'enabled' ? 'Enabled' : 'Disabled',
    state.notifications.desktop === 'enabled' ? 'ok' : 'off',
  );
  setTag(
    $('ch-sound'),
    state.notifications.sound === 'enabled' ? 'Enabled' : 'Disabled',
    state.notifications.sound === 'enabled' ? 'ok' : 'off',
  );

  $('pref-date-from').textContent = state.preferences.preferredDateFrom || 'any';
  $('pref-date-to').textContent = state.preferences.preferredDateTo || 'any';
  $('pref-time-from').textContent = state.preferences.preferredTimeFrom || 'any';
  $('pref-time-to').textContent = state.preferences.preferredTimeTo || 'any';

  const toggle = $('btn-toggle');
  if (state.runState === 'RUNNING') toggle.textContent = 'Pause';
  else if (state.manualActionRequired || state.runState === 'PAUSED') toggle.textContent = 'Resume monitoring';
  else toggle.textContent = 'Start';

  renderAlert(state);
  updateCooldown(state.cooldownRemainingSeconds);
}

function renderAlert(state) {
  const panel = $('alert-panel');
  const manual = state.manualActionRequired;
  const found = state.status === 'AVAILABLE' && state.appointments.length > 0;

  if (!manual && !found) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  panel.classList.toggle('manual', manual && !found);
  $('alert-visa').textContent = state.identity.visaSubCategory
    ? `${state.identity.visaType}, ${state.identity.visaSubCategory}`
    : state.identity.visaType;
  $('alert-detected').textContent = clockOf(state.lastCheck);
  $('alert-view-screenshot').classList.toggle('hidden', !state.screenshotPath);

  if (found) {
    const slot = state.appointments[0];
    $('alert-title').textContent = 'Appointment available';
    $('alert-badge').textContent = 'Monitoring stopped';
    $('alert-date').textContent = formatDateLong(slot.date);
    $('alert-time').textContent = slot.time || '-';
    $('alert-note').textContent =
      'The browser has been left open on the appointment page. Complete the booking yourself. This application will not click a confirmation or a payment step.';
    $('alert-resume').classList.add('hidden');

    const more = $('alert-more');
    if (state.appointments.length > 1) {
      more.classList.remove('hidden');
      more.textContent = `Also visible: ${state.appointments
        .slice(1, 9)
        .map((s) => (s.time ? `${s.date} ${s.time}` : s.date))
        .join('   ·   ')}`;
    } else {
      more.classList.add('hidden');
    }
    return;
  }

  const isCaptcha =
    state.status === 'CAPTCHA_REQUIRED' || state.status === 'HUMAN_VERIFICATION_REQUIRED';
  const isLogin = state.status === 'LOGIN_REQUIRED' || state.status === 'SESSION_EXPIRED';

  $('alert-title').textContent = isCaptcha
    ? 'Manual verification required'
    : isLogin
      ? 'Login required'
      : 'Manual action required';
  $('alert-badge').textContent = 'Monitoring paused';
  $('alert-date').textContent = '-';
  $('alert-time').textContent = '-';
  $('alert-more').classList.add('hidden');
  $('alert-note').textContent = `${state.manualActionReason || state.availabilityMessage}\n\nComplete the step yourself in the Chromium window. Monitoring resumes on its own once you are through, and nothing on the verification is touched by this application.`;
  $('alert-resume').classList.remove('hidden');
}

function addEventRow(event, prepend = true) {
  const list = $('event-log');
  const li = document.createElement('li');
  li.className = event.level;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = event.clock;

  const message = document.createElement('span');
  message.className = 'message';
  message.textContent = event.message;

  li.append(time, message);
  if (prepend) list.prepend(li);
  else list.append(li);

  $('log-empty').classList.add('hidden');
  while (list.children.length > 200) list.lastElementChild.remove();
}

function toast(text, ms = 4500) {
  const el = $('toast');
  el.textContent = text;
  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, ms);
  }
}

function updateCooldown(remaining) {
  const button = $('btn-check-now');
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
  if (!remaining || remaining <= 0) {
    button.disabled = false;
    button.textContent = 'Check now';
    return;
  }

  let left = remaining;
  button.disabled = true;
  button.textContent = `Check now · ${left}s`;
  cooldownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      button.disabled = false;
      button.textContent = 'Check now';
      return;
    }
    button.textContent = `Check now · ${left}s`;
  }, 1000);
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
  if (latest?.nextCheck) $('next-check-in').textContent = relativeFrom(latest.nextCheck);
}

/* ── Application details form ────────────────────────────────────────────── */

const FIELDS = {
  visaType: 'f-visa-type',
  visaSubCategory: 'f-visa-subcategory',
  applicantType: 'f-applicant-type',
  memberCount: 'f-member-count',
  preferredDateFrom: 'f-date-from',
  preferredDateTo: 'f-date-to',
  preferredTimeFrom: 'f-time-from',
  preferredTimeTo: 'f-time-to',
  intervalMinSeconds: 'f-interval-min',
  intervalMaxSeconds: 'f-interval-max',
};

const CUSTOM = '__custom__';
const NONE = '';
let options = null;

/** Builds a select, keeping the saved value selectable even if unknown. */
function renderSelect(select, values, selected, { allowNone = false, noneLabel = 'None' } = {}) {
  select.innerHTML = '';
  if (allowNone) select.append(new Option(noneLabel, NONE));
  for (const value of values) select.append(new Option(value, value));
  select.append(new Option('Custom...', CUSTOM));

  if (selected && !values.some((v) => v === selected)) {
    // A saved wording the lists do not know about: keep it, as Custom.
    select.value = CUSTOM;
    return CUSTOM;
  }
  select.value = selected || (allowNone ? NONE : values[0] || CUSTOM);
  return select.value;
}

/** Shows the free-text box only when Custom is chosen. */
function syncCustom(selectId) {
  const select = $(selectId);
  const custom = $(`${selectId}-custom`);
  if (!custom) return;
  const isCustom = select.value === CUSTOM;
  custom.classList.toggle('hidden', !isCustom);
  if (isCustom) custom.focus({ preventScroll: true });
}

function readSelect(selectId) {
  const select = $(selectId);
  if (select.value !== CUSTOM) return select.value;
  return ($(`${selectId}-custom`)?.value ?? '').trim();
}

function renderVisaSelects(config) {
  if (!options) return;
  const type = config.bls.visaType ?? '';
  const chosen = renderSelect($('f-visa-type'), options.visaTypes, type);
  if (chosen === CUSTOM) $('f-visa-type-custom').value = type;
  syncCustom('f-visa-type');
  renderCategorySelect(config.bls.visaSubCategory ?? '');
}

function renderCategorySelect(selected) {
  if (!options) return;
  const type = readSelect('f-visa-type');
  const list = options.subCategories[type] ?? [];
  const chosen = renderSelect($('f-visa-subcategory'), list, selected, {
    allowNone: true,
    noneLabel: 'None (form asks once)',
  });
  if (chosen === CUSTOM) $('f-visa-subcategory-custom').value = selected;
  syncCustom('f-visa-subcategory');
}

function renderOptionsSource() {
  if (!options) return;
  const note = $('options-source');
  if (options.fromLiveForm && options.discoveredAt) {
    const when = new Date(options.discoveredAt);
    note.textContent = `Choices below were read from your BLS booking form on ${dayOf(
      options.discoveredAt,
    )} at ${clockOf(options.discoveredAt)}. Centres offered: ${options.locations.join(', ')}.`;
    note.classList.add('live');
    if (Number.isNaN(when.getTime())) note.classList.remove('live');
  } else {
    note.textContent =
      'Choices below are the published BLS categories. Sign in, then press Load lists from BLS to replace them with exactly what your account is offered.';
    note.classList.remove('live');
  }
}

function fillForm(config) {
  for (const [key, id] of Object.entries(FIELDS)) {
    if (id === 'f-visa-type' || id === 'f-visa-subcategory') continue;
    const el = $(id);
    if (el) el.value = config.bls[key] ?? '';
  }
  const applicantValues = options ? options.applicantTypes : ['Individual', 'Family', 'Group'];
  renderSelect($('f-applicant-type'), applicantValues, config.bls.applicantType);
  // The schema only accepts the three known values, so no Custom entry here.
  const customOption = [...$('f-applicant-type').options].find((o) => o.value === CUSTOM);
  customOption?.remove();
  renderVisaSelects(config);
  renderOptionsSource();
  $('f-telegram').checked = Boolean(config.notifications.telegram);
  $('f-desktop').checked = Boolean(config.notifications.desktop);
  $('f-sound').checked = Boolean(config.notifications.sound);
  syncMemberCount();
}

/** An Individual booking is always one applicant; the schema enforces it too. */
function syncMemberCount() {
  const individual = $('f-applicant-type').value === 'Individual';
  const count = $('f-member-count');
  count.disabled = individual;
  count.min = individual ? '1' : '2';
  if (individual) count.value = '1';
  else if (Number(count.value) < 2) count.value = '2';
}

function readForm() {
  return {
    bls: {
      visaType: readSelect('f-visa-type'),
      visaSubCategory: readSelect('f-visa-subcategory'),
      applicantType: $('f-applicant-type').value,
      memberCount: Number($('f-member-count').value || 1),
      preferredDateFrom: $('f-date-from').value,
      preferredDateTo: $('f-date-to').value,
      preferredTimeFrom: $('f-time-from').value,
      preferredTimeTo: $('f-time-to').value,
      intervalMinSeconds: Number($('f-interval-min').value || 180),
      intervalMaxSeconds: Number($('f-interval-max').value || 360),
    },
    notifications: {
      telegram: $('f-telegram').checked,
      desktop: $('f-desktop').checked,
      sound: $('f-sound').checked,
    },
  };
}

/** Turns a Zod error dump into the one line that matters. */
function firstIssue(message) {
  const line = String(message)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('- '));
  return line ? line.slice(2) : String(message).split('\n')[0];
}

function setFormStatus(text, tone = '') {
  const el = $('settings-status');
  el.textContent = text;
  el.className = `form-status ${tone}`;
  if (text && tone === 'ok') {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, 5000);
  }
}

/* Telegram setup */

function setTelegramStatus(text, tone = '') {
  const el = $('telegram-status');
  el.textContent = text;
  el.className = `form-status ${tone}`;
}

async function refreshTelegramState() {
  const info = await window.bls.getTelegram();
  $('f-chat-id').value = info.chatId || '';
  $('f-bot-token').placeholder = info.tokenPresent
    ? 'Saved. Type a new token only to replace it.'
    : '123456789:AAE...';
  $('token-state').textContent = info.tokenPresent
    ? `A token is stored in ${info.envPath}. It is never shown again and never logged.`
    : `Will be written to ${info.envPath} with owner-only permissions, and never logged.`;
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

async function boot() {
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  }

  tickClock();
  setInterval(tickClock, 1000);

  const [state, events, config, loadedOptions] = await Promise.all([
    window.bls.getState(),
    window.bls.getEvents(),
    window.bls.getConfig(),
    window.bls.getOptions(),
  ]);
  options = loadedOptions;
  render(state);
  fillForm(config);
  await refreshTelegramState();
  for (const event of events.slice().reverse()) addEventRow(event, true);

  window.bls.onState(render);
  window.bls.onEvent((event) => addEventRow(event, true));

  $('f-applicant-type').addEventListener('change', syncMemberCount);

  $('f-visa-type').addEventListener('change', () => {
    syncCustom('f-visa-type');
    renderCategorySelect('');
  });
  $('f-visa-type-custom').addEventListener('input', () => renderCategorySelect(''));
  $('f-visa-subcategory').addEventListener('change', () => syncCustom('f-visa-subcategory'));

  $('refresh-options').addEventListener('click', async () => {
    const button = $('refresh-options');
    button.disabled = true;
    button.textContent = 'Reading BLS...';
    const result = await window.bls.refreshOptions();
    options = result.options;
    fillForm(await window.bls.getConfig());
    button.disabled = false;
    button.textContent = 'Load lists from BLS';
    toast(
      result.ok
        ? 'Visa lists updated from your BLS account.'
        : result.reason || 'Could not read the BLS lists.',
      7000,
    );
  });

  $('telegram-setup').addEventListener('click', async () => {
    $('telegram-panel').classList.toggle('hidden');
    if (!$('telegram-panel').classList.contains('hidden')) {
      await refreshTelegramState();
      $('telegram-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  $('telegram-close').addEventListener('click', () => $('telegram-panel').classList.add('hidden'));

  $('telegram-save').addEventListener('click', async () => {
    setTelegramStatus('Saving...');
    const result = await window.bls.saveTelegram({
      botToken: $('f-bot-token').value,
      chatId: $('f-chat-id').value,
    });
    if (!result.ok) {
      setTelegramStatus(result.error || 'Could not save.', 'bad');
      return;
    }
    $('f-bot-token').value = '';
    await refreshTelegramState();
    setTelegramStatus(
      result.verified
        ? `Saved and verified${result.botName ? ` as @${result.botName}` : ''}.`
        : `Saved, but Telegram rejected it: ${result.error}`,
      result.verified ? 'ok' : 'bad',
    );
    render(await window.bls.getState());
  });

  $('telegram-test').addEventListener('click', async () => {
    setTelegramStatus('Sending...');
    const outcome = await window.bls.testNotifications();
    setTelegramStatus(
      outcome.telegram.ok
        ? 'Test message sent. Check your Telegram chat.'
        : outcome.telegram.error || 'Telegram send failed.',
      outcome.telegram.ok ? 'ok' : 'bad',
    );
  });

  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormStatus('Saving…');
    const result = await window.bls.saveConfig(readForm());
    if (!result.ok) {
      setFormStatus(result.error ? firstIssue(result.error) : 'Could not save.', 'bad');
      return;
    }
    fillForm(result.config);
    setFormStatus('Saved. Applied to the next check.', 'ok');
    render(await window.bls.getState());
  });

  $('settings-revert').addEventListener('click', async () => {
    fillForm(await window.bls.getConfig());
    setFormStatus('Reverted to the saved values.', 'ok');
  });

  $('btn-sign-in').addEventListener('click', async () => {
    toast('Opening the BLS login page. Sign in there, not here.', 6000);
    render(await window.bls.openLogin());
  });

  $('btn-toggle').addEventListener('click', async () => {
    if (!latest) return;
    if (latest.runState === 'RUNNING') render(await window.bls.pause());
    else if (latest.manualActionRequired || latest.runState === 'PAUSED') render(await window.bls.resume());
    else render(await window.bls.start());
  });

  $('btn-check-now').addEventListener('click', async () => {
    $('btn-check-now').disabled = true;
    const outcome = await window.bls.checkNow();
    if (!outcome.accepted) toast(outcome.reason || 'Please wait before checking again.');
    render(outcome.state);
  });

  const openBrowser = async () => render(await window.bls.openBrowser());
  $('btn-open-browser').addEventListener('click', openBrowser);
  $('alert-open-browser').addEventListener('click', openBrowser);

  $('alert-resume').addEventListener('click', async () => render(await window.bls.resume()));

  $('btn-screenshots').addEventListener('click', async () => {
    const res = await window.bls.openScreenshotFolder();
    if (!res.ok) toast(res.error || 'Could not open the screenshot folder.');
  });

  $('alert-view-screenshot').addEventListener('click', async () => {
    if (!latest?.screenshotPath) return toast('No screenshot for this event.');
    const res = await window.bls.openScreenshot(latest.screenshotPath);
    if (!res.ok) toast(res.error || 'Could not open the screenshot.');
  });

  $('test-notifications').addEventListener('click', async () => {
    toast('Sending test…', 2500);
    const outcome = await window.bls.testNotifications();
    toast(
      `Test sent, telegram ${outcome.telegram.ok ? 'ok' : outcome.telegram.error || 'failed'}, desktop ${
        outcome.desktop ? 'ok' : 'off'
      }, sound ${outcome.sound ? 'ok' : 'off'}`,
      7000,
    );
  });

  setInterval(async () => render(await window.bls.getState()), 15000);
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#a4231f">Dashboard failed to start: ${
    err && err.message ? err.message : String(err)
  }</pre>`;
});
