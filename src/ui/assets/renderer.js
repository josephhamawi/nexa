/* Nexa Control Center renderer.

   Runs with context isolation on; the only bridge to the main process is
   window.nexa, defined in preload.ts. No Node, no direct filesystem access. */

const $ = (id) => document.getElementById(id);

let state = null;
let config = null;

/* ── Theme: light by default, dark and system on request ─────────────────── */

const THEME_KEY = 'nexa-theme-preference';
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
    /* private mode: the theme resets next launch */
  }
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
  }
}

systemQuery.addEventListener('change', () => {
  if (storedTheme() === 'system') applyTheme('system');
});

applyTheme(storedTheme());

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const VIEW_SUBTITLES = {
  overview: 'Your AI operations agent',
  tasks: 'Everything Nexa is working on, and everything it has finished',
  watchers: 'Pages and searches Nexa keeps an eye on',
  approvals: 'Steps that need your say-so before they run',
  activity: 'What the agent has actually been doing',
  browser: 'Persistent browser sessions Nexa can drive',
  settings: 'Provider, Telegram, your profile and safety',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clockOf(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString([], { hour12: false });
}

function whenOf(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const delta = date.getTime() - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return delta > 0 ? 'in under a minute' : 'just now';
  if (minutes < 60) return delta > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return delta > 0 ? `in ${hours}h` : `${hours}h ago`;
  return date.toLocaleString();
}

function statusClass(status) {
  switch (status) {
    case 'RUNNING':
      return 'running';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'WAITING_FOR_HUMAN':
    case 'WAITING_FOR_APPROVAL':
      return 'waiting';
    case 'PAUSED':
      return 'paused';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return '';
  }
}

function prettyStatus(status) {
  return status.replace(/_/g, ' ').toLowerCase();
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

function render(next) {
  if (!next) return;
  state = next;

  $('stat-active').textContent = state.counts.activeTasks;
  $('stat-watchers').textContent = state.counts.runningWatchers;
  $('stat-waiting').textContent = state.counts.waitingForHuman + state.counts.pendingApprovals;
  $('stat-done').textContent = state.counts.completedToday;
  $('stat-failed').textContent = state.counts.failedToday;

  setPill('pill-tasks', state.counts.activeTasks);
  setPill('pill-watchers', state.counts.runningWatchers);
  setPill('pill-approvals', state.counts.waitingForHuman + state.counts.pendingApprovals);

  const busy = state.tasks.some((task) => task.status === 'RUNNING');
  const waiting = state.counts.waitingForHuman + state.counts.pendingApprovals > 0;
  $('agent-dot').className = `dot ${waiting ? 'warn' : busy ? 'busy' : state.agent.running ? 'running' : ''}`;
  $('agent-state-label').textContent = waiting
    ? 'needs you'
    : busy
      ? 'working'
      : state.agent.running
        ? 'idle'
        : 'stopped';

  const llm = $('llm-badge');
  llm.textContent = state.agent.llm.available
    ? `model: ${state.agent.llm.model}`
    : 'model: rules only';
  llm.className = `meta ${state.agent.llm.available ? 'ok' : 'warn'}`;

  const telegram = $('telegram-badge');
  const tg = state.notifications.telegram;
  telegram.textContent = `telegram: ${tg === 'connected' ? 'connected' : tg === 'disabled' ? 'off' : 'not set up'}`;
  telegram.className = `meta ${tg === 'connected' ? 'ok' : 'warn'}`;

  if (state.agent.demoMode) {
    $('view-subtitle').textContent = 'Demo mode: results are simulated and nothing is contacted';
  }

  renderTaskList($('overview-tasks'), state.tasks.slice(0, 4), $('overview-tasks-empty'));
  renderTaskList($('tasks-active'), state.tasks, $('tasks-active-empty'));
  renderTaskList($('tasks-history'), state.history, $('tasks-history-empty'), true);
  renderWatchers();
  renderApprovals();
  renderBrowser();
  renderMcp();
}

function setPill(id, value) {
  const pill = $(id);
  pill.textContent = value;
  pill.classList.toggle('zero', value === 0);
}

function renderTaskList(container, tasks, emptyNode, compact = false) {
  container.innerHTML = '';
  if (emptyNode) emptyNode.classList.toggle('hidden', tasks.length > 0);

  for (const task of tasks) {
    const record = el('div', 'record');

    const head = el('div', 'record-head');
    head.append(el('span', 'record-title', task.name));
    head.append(el('span', `status ${statusClass(task.status)}`, prettyStatus(task.status)));
    record.append(head);

    const bits = [];
    if (task.recurrence && task.recurrence.kind !== 'once') bits.push(describeRecurrence(task.recurrence));
    if (task.nextRun && task.status !== 'COMPLETED') bits.push(`next ${whenOf(task.nextRun)}`);
    if (task.lastRun) bits.push(`last ${whenOf(task.lastRun)}`);
    record.append(el('div', 'record-sub', bits.join('  ·  ') || task.description || task.naturalLanguageRequest));

    if (!compact && task.steps.length > 0) {
      const bar = el('div', 'progress');
      const fill = el('span');
      fill.style.width = `${task.progress}%`;
      bar.append(fill);
      record.append(bar);

      const steps = el('div', 'steps-inline');
      for (const [index, step] of task.steps.entries()) {
        const mark = step.status === 'DONE' ? '✓' : step.status === 'FAILED' ? '✕' : step.status === 'RUNNING' ? '▶' : '·';
        const cls = step.status === 'DONE' ? 'done' : step.status === 'FAILED' ? 'failed' : step.status === 'RUNNING' ? 'active' : '';
        steps.append(el('div', cls, `${mark} ${index + 1}. ${step.description}`));
      }
      record.append(steps);
    }

    if (task.confidence) record.append(confidenceMeter(task.confidence));

    if (task.result) {
      const result = el('div', 'record-result', task.result.slice(0, 1200));
      if (task.result.length > 400) result.classList.add('clipped');
      record.append(result);
    }

    const actions = el('div', 'record-actions');
    if (task.status === 'WAITING_FOR_APPROVAL') {
      actions.append(button('Approve', 'btn btn-sm btn-solid', () => call(window.nexa.approveTask(task.id, true))));
      actions.append(button('Reject', 'btn btn-sm btn-danger', () => call(window.nexa.approveTask(task.id, false))));
    } else if (task.status === 'WAITING_FOR_HUMAN') {
      actions.append(button('Open browser', 'btn btn-sm btn-solid', () => call(window.nexa.openBrowser())));
      actions.append(button('Resume', 'btn btn-sm', () => call(window.nexa.resumeTask(task.id))));
    } else if (task.status === 'PAUSED') {
      actions.append(button('Resume', 'btn btn-sm', () => call(window.nexa.resumeTask(task.id))));
    } else if (task.status === 'RUNNING' || task.status === 'QUEUED') {
      actions.append(button('Pause', 'btn btn-sm btn-quiet', () => call(window.nexa.pauseTask(task.id))));
    } else if (task.status === 'COMPLETED' || task.status === 'FAILED') {
      actions.append(button('Run again', 'btn btn-sm btn-quiet', () => call(window.nexa.runTask(task.id))));
    }

    if (task.evidence && task.evidence.length > 0) {
      const withFile = task.evidence.filter((item) => item.path);
      if (withFile.length > 0) {
        actions.append(
          button(`Evidence (${withFile.length})`, 'btn btn-sm btn-quiet', async () => {
            const res = await window.nexa.openEvidence(withFile[withFile.length - 1].path);
            if (!res.ok) reply(res.error || 'Could not open that evidence file.');
          }),
        );
      }
    }

    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      actions.append(button('Cancel', 'btn btn-sm btn-quiet btn-danger', () => call(window.nexa.cancelTask(task.id))));
    }

    if (actions.children.length > 0) record.append(actions);
    container.append(record);
  }
}

function renderWatchers() {
  const container = $('watchers-list');
  container.innerHTML = '';
  $('watchers-empty').classList.toggle('hidden', state.watchers.length > 0);

  for (const watcher of state.watchers) {
    const record = el('div', 'record');

    const head = el('div', 'record-head');
    head.append(el('span', 'record-title', watcher.name));
    head.append(el('span', `status ${watcher.status === 'ACTIVE' ? 'running' : watcher.status === 'ERROR' ? 'failed' : 'paused'}`, watcher.status.toLowerCase()));
    record.append(head);

    record.append(el('div', 'record-sub', watcher.target));
    record.append(
      el(
        'div',
        'record-sub',
        [
          `every ${Math.round(watcher.intervalSeconds / 60)}m`,
          `checked ${whenOf(watcher.lastChecked)}`,
          watcher.lastChanged ? `changed ${whenOf(watcher.lastChanged)}` : 'no change yet',
          watcher.lastError ? `error: ${watcher.lastError}` : '',
        ]
          .filter(Boolean)
          .join('  ·  '),
      ),
    );

    if (watcher.changeSummary) record.append(el('div', 'record-sub', watcher.changeSummary.slice(0, 300)));

    const actions = el('div', 'record-actions');
    actions.append(button('Check now', 'btn btn-sm btn-quiet', () => call(window.nexa.checkWatcher(watcher.id))));
    actions.append(
      button(watcher.status === 'ACTIVE' ? 'Pause' : 'Resume', 'btn btn-sm', () =>
        call(window.nexa.setWatcherStatus(watcher.id, watcher.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')),
      ),
    );
    actions.append(button('Delete', 'btn btn-sm btn-quiet btn-danger', () => call(window.nexa.removeWatcher(watcher.id))));
    record.append(actions);

    container.append(record);
  }
}

function renderApprovals() {
  const waiting = state.tasks.filter(
    (task) => task.status === 'WAITING_FOR_APPROVAL' || task.status === 'WAITING_FOR_HUMAN',
  );
  $('approvals-empty').classList.toggle('hidden', waiting.length > 0);
  renderTaskList($('approvals-list'), waiting, null);
}

function renderBrowser() {
  const container = $('browser-list');
  container.innerHTML = '';

  for (const profile of state.browser.profiles) {
    const record = el('div', 'record');
    const head = el('div', 'record-head');
    head.append(el('span', 'record-title', profile.name));
    const active = state.browser.active.includes(profile.id);
    head.append(
      el('span', `status ${state.browser.inUseByHuman && active ? 'waiting' : active ? 'running' : ''}`,
        state.browser.inUseByHuman && active ? 'in use by you' : active ? 'open' : 'closed'),
    );
    record.append(head);
    record.append(el('div', 'record-sub', `${profile.engine}  ·  ${profile.headless ? 'headless' : 'windowed'}  ·  id ${profile.id}`));

    const actions = el('div', 'record-actions');
    actions.append(button('Open', 'btn btn-sm btn-quiet', () => call(window.nexa.openBrowser(profile.id))));
    record.append(actions);
    container.append(record);
  }
}

/**
 * The accuracy meter: a bar, a number, and the reasons behind it.
 * Showing the reasons is the point; a bare percentage invites false trust.
 */
function confidenceMeter(confidence) {
  const wrap = el('div', `confidence ${confidence.level}`);

  const head = el('div', 'confidence-head');
  head.append(el('span', 'confidence-label', 'Confidence'));
  head.append(el('span', 'confidence-score', confidence.level === 'none' ? 'simulated' : `${confidence.score}%`));
  wrap.append(head);

  const bar = el('div', 'confidence-bar');
  const fill = el('span');
  fill.style.width = `${confidence.score}%`;
  bar.append(fill);
  wrap.append(bar);

  if (confidence.factors && confidence.factors.length > 0) {
    const factors = el('div', 'confidence-factors');
    for (const factor of confidence.factors) {
      factors.append(el('span', factor.delta >= 0 ? 'up' : 'down', `${factor.delta >= 0 ? '+' : ''}${factor.delta} ${factor.label}`));
    }
    wrap.append(factors);
  }

  return wrap;
}

function renderMcp() {
  const container = $('mcp-list');
  const servers = state.mcp || [];
  container.innerHTML = '';
  $('mcp-empty').classList.toggle('hidden', servers.length > 0);

  for (const server of servers) {
    const record = el('div', 'record');
    const head = el('div', 'record-head');
    head.append(el('span', 'record-title', server.name));
    head.append(
      el('span', `status ${server.connected ? 'running' : 'failed'}`, server.connected ? 'connected' : 'not connected'),
    );
    record.append(head);
    record.append(
      el('div', 'record-sub', server.connected ? `${server.tools} tool(s) available to tasks` : 'check the command in config.json'),
    );
    container.append(record);
  }
}

function renderActivity(entries) {
  for (const listId of ['overview-activity', 'activity-list']) {
    const list = $(listId);
    list.innerHTML = '';
    const slice = listId === 'overview-activity' ? entries.slice(0, 12) : entries;
    for (const entry of slice) list.append(activityRow(entry));
  }
  $('overview-activity-empty').classList.toggle('hidden', entries.length > 0);
}

function activityRow(entry) {
  const li = el('li', entry.level);
  li.append(el('span', 'time', entry.clock));
  li.append(el('span', 'message', entry.message));
  return li;
}

function prependActivity(entry) {
  for (const listId of ['overview-activity', 'activity-list']) {
    const list = $(listId);
    list.prepend(activityRow(entry));
    while (list.children.length > 200) list.lastElementChild.remove();
  }
  $('overview-activity-empty').classList.add('hidden');
}

function describeRecurrence(recurrence) {
  switch (recurrence.kind) {
    case 'interval': {
      const seconds = recurrence.everySeconds || 3600;
      return seconds % 3600 === 0 ? `every ${seconds / 3600}h` : `every ${Math.round(seconds / 60)}m`;
    }
    case 'daily':
      return `daily at ${recurrence.at || '08:00'}`;
    case 'weekly': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `every ${days[recurrence.weekday ?? 1]} at ${recurrence.at || '08:00'}`;
    }
    default:
      return 'once';
  }
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.addEventListener('click', onClick);
  return node;
}

async function call(promise) {
  const next = await promise;
  if (next && next.counts) render(next);
}

function reply(text) {
  $('command-reply').textContent = text;
  $('answer-chips').innerHTML = '';
}

/** Turns a clarifying question's suggestions into one-click answers. */
function renderSuggestedAnswers(clarifying) {
  const container = $('answer-chips');
  container.innerHTML = '';
  if (!clarifying) return;

  const suggestions = clarifying.questions.flatMap((question) => question.suggestions || []);
  for (const suggestion of suggestions.slice(0, 6)) {
    container.append(
      button(suggestion, 'chip', () => {
        $('command-input').value = suggestion;
        submitCommand();
      }),
    );
  }
  if (suggestions.length > 0) {
    container.append(
      button('just do it', 'chip', () => {
        $('command-input').value = 'just do it';
        submitCommand();
      }),
    );
  }
}

/* ── Settings ────────────────────────────────────────────────────────────── */

function fillSettings(next) {
  config = next;

  $('f-llm-provider').value = config.llm.provider;
  $('f-llm-model').value = config.llm.model;
  $('f-llm-baseurl').value = config.llm.baseUrl || '';

  $('f-summary').value = config.userProfile.summary || '';
  $('f-skills').value = (config.userProfile.skills || []).join(', ');
  $('f-technologies').value = (config.userProfile.technologies || []).join(', ');
  $('f-roles').value = (config.userProfile.preferredRoles || []).join(', ');
  $('f-excluded').value = (config.userProfile.excludedRoles || []).join(', ');
  $('f-remote').value = config.userProfile.remotePreference || 'remote';
  $('f-salary').value = config.userProfile.salaryMin || 0;

  $('f-watch-interval').value = config.agent.minWatchIntervalSeconds;
  $('f-retries').value = config.agent.maxStepRetries;
  $('f-approval').checked = Boolean(config.agent.requireApprovalForWrites);
  $('f-demo').checked = Boolean(config.agent.demoMode);

  $('f-telegram-on').checked = Boolean(config.notifications.telegram);
  $('f-desktop-on').checked = Boolean(config.notifications.desktop);
  $('f-sound-on').checked = Boolean(config.notifications.sound);

  renderFolders();
}

function renderFolders() {
  const list = $('folder-list');
  list.innerHTML = '';
  const folders = config.files.allowedDirectories || [];

  if (folders.length === 0) {
    list.append(el('div', 'note', 'No folders allowed yet. File tasks stay disabled until you add one.'));
  }

  for (const folder of folders) {
    const row = el('div', 'folder-row');
    row.append(el('span', null, folder));
    row.append(
      button('Remove', 'btn btn-sm btn-quiet btn-danger', () => {
        config.files.allowedDirectories = folders.filter((item) => item !== folder);
        renderFolders();
      }),
    );
    list.append(row);
  }
}

function readSettings() {
  const list = (value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    llm: {
      provider: $('f-llm-provider').value,
      model: $('f-llm-model').value.trim() || 'claude-sonnet-5',
      baseUrl: $('f-llm-baseurl').value.trim(),
    },
    agent: {
      minWatchIntervalSeconds: Number($('f-watch-interval').value || 300),
      maxStepRetries: Number($('f-retries').value || 2),
      requireApprovalForWrites: $('f-approval').checked,
      demoMode: $('f-demo').checked,
    },
    notifications: {
      telegram: $('f-telegram-on').checked,
      desktop: $('f-desktop-on').checked,
      sound: $('f-sound-on').checked,
    },
    files: { allowedDirectories: config.files.allowedDirectories || [] },
    userProfile: {
      summary: $('f-summary').value.trim(),
      skills: list($('f-skills').value),
      technologies: list($('f-technologies').value),
      preferredRoles: list($('f-roles').value),
      excludedRoles: list($('f-excluded').value),
      remotePreference: $('f-remote').value,
      salaryMin: Number($('f-salary').value || 0),
    },
  };
}

function setStatus(id, text, tone = '') {
  const node = $(id);
  node.textContent = text;
  node.className = `form-status ${tone}`;
  if (tone === 'ok') {
    setTimeout(() => {
      if (node.textContent === text) node.textContent = '';
    }, 5000);
  }
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

function switchView(name) {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.view === name);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('active', view.dataset.view === name);
  }
  $('view-title').textContent = name.charAt(0).toUpperCase() + name.slice(1);
  $('view-subtitle').textContent = VIEW_SUBTITLES[name] || '';
}

async function submitCommand() {
  const input = $('command-input');
  const text = input.value.trim();
  if (!text) return;

  const send = $('command-send');
  send.disabled = true;
  send.textContent = 'Planning';
  reply('Working out a plan...');

  try {
    const result = await window.nexa.request(text);
    if (!result.ok) {
      reply(result.error || 'That did not work.');
    } else {
      reply(result.text);
      input.value = '';
      // Nexa asked something back: offer the suggested answers as chips and
      // keep focus in the box so replying is one keystroke away.
      renderSuggestedAnswers(result.clarifying);
      if (result.state) render(result.state);
      input.focus();
    }
  } finally {
    send.disabled = false;
    send.textContent = 'Run';
  }
}

async function boot() {
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  }
  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => switchView(item.dataset.view));
  }
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      $('command-input').value = chip.dataset.suggest;
      $('command-input').focus();
    });
  }

  const tick = () => {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
  };
  tick();
  setInterval(tick, 1000);

  $('command-send').addEventListener('click', submitCommand);
  $('command-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitCommand();
  });

  const [initialState, activity, initialConfig, secrets] = await Promise.all([
    window.nexa.getState(),
    window.nexa.getActivity(),
    window.nexa.getConfig(),
    window.nexa.getSecrets(),
  ]);

  render(initialState);
  renderActivity(activity);
  fillSettings(initialConfig);
  applySecrets(secrets);

  window.nexa.onState(render);
  window.nexa.onActivity(prependActivity);

  // Settings wiring
  $('settings-save').addEventListener('click', async () => {
    setStatus('settings-status', 'Saving...');
    const result = await window.nexa.saveConfig(readSettings());
    if (!result.ok) return setStatus('settings-status', result.error || 'Could not save.', 'bad');
    fillSettings(result.config);
    setStatus('settings-status', 'Saved.', 'ok');
    render(await window.nexa.getState());
  });

  $('settings-revert').addEventListener('click', async () => {
    fillSettings(await window.nexa.getConfig());
    setStatus('settings-status', 'Reverted.', 'ok');
  });

  $('add-folder').addEventListener('click', async () => {
    const result = await window.nexa.pickFolder();
    if (!result.ok) return;
    config.files.allowedDirectories = [...new Set([...(config.files.allowedDirectories || []), result.path])];
    renderFolders();
    setStatus('settings-status', 'Folder added. Press Save settings to confirm.', 'ok');
  });

  $('llm-save').addEventListener('click', async () => {
    setStatus('llm-status', 'Saving...');
    const saved = await window.nexa.saveConfig({
      llm: {
        provider: $('f-llm-provider').value,
        model: $('f-llm-model').value.trim() || 'claude-sonnet-5',
        baseUrl: $('f-llm-baseurl').value.trim(),
      },
    });
    if (!saved.ok) return setStatus('llm-status', saved.error || 'Could not save.', 'bad');

    const key = $('f-llm-key').value.trim();
    if (key) {
      const result = await window.nexa.saveLlm({
        provider: $('f-llm-provider').value,
        apiKey: key,
        baseUrl: $('f-llm-baseurl').value.trim(),
      });
      if (!result.ok) return setStatus('llm-status', result.error || 'Could not save the key.', 'bad');
      $('f-llm-key').value = '';
    }

    applySecrets(await window.nexa.getSecrets());
    setStatus('llm-status', 'Provider saved.', 'ok');
    render(await window.nexa.getState());
  });

  $('telegram-save').addEventListener('click', async () => {
    setStatus('telegram-status', 'Saving...');
    const result = await window.nexa.saveTelegram({
      botToken: $('f-bot-token').value,
      chatId: $('f-chat-id').value,
    });
    if (!result.ok) return setStatus('telegram-status', result.error || 'Could not save.', 'bad');
    $('f-bot-token').value = '';
    applySecrets(await window.nexa.getSecrets());
    setStatus(
      'telegram-status',
      result.verified ? `Saved and verified${result.botName ? ` as @${result.botName}` : ''}.` : `Saved, but Telegram said: ${result.error}`,
      result.verified ? 'ok' : 'bad',
    );
    render(await window.nexa.getState());
  });

  $('detect-chat').addEventListener('click', async () => {
    setStatus('telegram-status', 'Asking your bot who has messaged it...');
    const result = await window.nexa.detectChat($('f-bot-token').value.trim());

    if (!result.ok) return setStatus('telegram-status', result.error || 'Could not detect.', 'bad');

    const chats = result.chats || [];
    $('f-chat-id').value = chats[0].chatId;
    setStatus(
      'telegram-status',
      chats.length === 1
        ? `Found chat ${chats[0].chatId} (${chats[0].from}). Press Save and verify.`
        : `Found ${chats.length} chats; using ${chats[0].chatId} (${chats[0].from}).`,
      'ok',
    );
  });

  $('telegram-test').addEventListener('click', async () => {
    setStatus('telegram-status', 'Sending...');
    const outcome = await window.nexa.testNotifications();
    setStatus(
      'telegram-status',
      outcome.telegram.ok ? 'Test sent. Check Telegram.' : outcome.telegram.error || 'Send failed.',
      outcome.telegram.ok ? 'ok' : 'bad',
    );
  });

  // Periodic refresh keeps relative times honest even when nothing is pushed.
  setInterval(async () => render(await window.nexa.getState()), 15000);
}

function applySecrets(secrets) {
  $('f-chat-id').value = secrets.telegram.chatId || '';
  $('f-bot-token').placeholder = secrets.telegram.tokenPresent
    ? 'Saved. Type a new token only to replace it.'
    : '123456789:AAE...';
  $('token-state').textContent = secrets.telegram.tokenPresent
    ? `A token is stored in ${secrets.envPath}. It is never shown again.`
    : `Will be written to ${secrets.envPath} with owner-only permissions.`;

  const present = secrets.anthropic.keyPresent || secrets.openai.keyPresent;
  $('f-llm-key').placeholder = present ? 'Saved. Type a new key only to replace it.' : 'sk-ant-...';
  $('llm-key-state').textContent = present
    ? `A key is stored in ${secrets.envPath}. It is never shown again and never logged.`
    : 'Written to your .env with owner-only permissions, and never logged.';
  if (secrets.openai.baseUrl && !$('f-llm-baseurl').value) $('f-llm-baseurl').value = secrets.openai.baseUrl;
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#b3261e;font:13px ui-monospace,monospace">Nexa dashboard failed to start: ${
    err && err.message ? err.message : String(err)
  }</pre>`;
});
