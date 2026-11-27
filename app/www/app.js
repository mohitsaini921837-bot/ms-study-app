/* MS Study — app shell (Capacitor 6, single-page app). NO-PASSWORD
 * build (v1.0.23): there is no login, no lock screen, no password
 * anywhere. The device id IS the identity — a UUID generated once
 * (native MsAccess plugin, AES-encrypted store; localStorage
 * `ms_device_id` fallback in a plain browser) and sent as {deviceId}
 * on every server call. The server accepts deviceId-only.
 * The hidden chat (3s logo long-press + chat code in the native
 * store) is separate from login and is untouched.
 *
 * SECURITY RULES (do not weaken):
 *   - NO download option for any content anywhere in the UI.
 *   - NO Google Sign-In / Drive key in the client (see drive.js).
 */

'use strict';

/* ================= Config ================= */
var SERVER_URL = 'https://byulsopangzovpwywgzf.supabase.co/functions/v1/ms-api';
var UPDATE_URL = 'https://mohitsaini921837-bot.github.io/ms-study-app/update/version.json';
var CURRENT_VERSION_CODE = 24;

/* Exposed read-only for drive.js (it reads SERVER_URL from here). */
window.MsStudyConfig = { SERVER_URL: SERVER_URL, UPDATE_URL: UPDATE_URL, CURRENT_VERSION_CODE: CURRENT_VERSION_CODE };

/* In-memory session ONLY. Never persisted. */
window.MsStudySession = { deviceId: '', deviceLabel: 'MS Study App' };

var pendingUpdate = null;

/* ================= Small helpers ================= */
function $(id) { return document.getElementById(id); }

function showToast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { t.hidden = true; }, 3500);
}

function capPlugin(name) {
  try {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  } catch (e) { return null; }
}

function uuid() {
  // RFC 4122 v4 UUID (crypto.randomUUID when available).
  if (window.crypto && window.crypto.randomUUID) { return window.crypto.randomUUID(); }
  var b = new Uint8Array(16);
  window.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = function (i) { return ('0' + b[i].toString(16)).slice(-2); };
  return h(0) + h(1) + h(2) + h(3) + '-' + h(4) + h(5) + '-' + h(6) + h(7) +
    '-' + h(8) + h(9) + '-' + h(10) + h(11) + h(12) + h(13) + h(14) + h(15);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* Device identity: native plugin first (UUID generated once, stored
 * AES-encrypted — mirrors PW's PwSessionStore fallback-id mechanism).
 * Browser fallback only: a UUID in localStorage. */
async function getDeviceInfo() {
  var plugin = capPlugin('MsAccess');
  if (plugin && plugin.getDeviceInfo) {
    try {
      var info = await plugin.getDeviceInfo();
      if (info && info.deviceId) {
        return { deviceId: info.deviceId, deviceLabel: info.deviceLabel || 'MS Study App' };
      }
    } catch (e) { /* fall through to browser fallback */ }
  }
  var stored = null;
  try { stored = window.localStorage.getItem('ms_device_id'); } catch (e) {}
  if (!stored) {
    stored = 'ms-' + uuid();
    try { window.localStorage.setItem('ms_device_id', stored); } catch (e) {}
  }
  return { deviceId: stored, deviceLabel: 'MS Study App' };
}

/* ================= Screens / router ================= */
var MAIN_SCREENS = ['screen-notes', 'screen-tests', 'screen-practice'];
var ALL_SCREENS = MAIN_SCREENS.concat(['screen-chat-lock', 'screen-chat', 'screen-take', 'screen-test-subjects', 'screen-test-chapters', 'screen-test-list', 'screen-practice-subjects', 'screen-practice-chapters', 'screen-practice-list']);

var currentScreenId = 'screen-notes'; // FIX 10 (v1.0.12): tracked for live refresh

function showScreen(id) {
  currentScreenId = id;
  ALL_SCREENS.forEach(function (s) {
    var el = $(s);
    if (el) { el.hidden = (s !== id); }
  });
  // Bottom nav only on the main screens (never on lock / chat entry).
  $('bottomNav').hidden = (MAIN_SCREENS.indexOf(id) === -1);
  // Keep the nav highlight in sync.
  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-screen') === id);
  });
  window.scrollTo(0, 0);
  // Lazy-load the screen's data when it is shown (FIX 10: every tab
  // switch re-fetches, so a change from another device appears at once).
  if (id === 'screen-notes') { notesBrowser.load(); }
  else if (id === 'screen-practice') { practiceBrowser.load(); refreshPracticeSets(); }
  else if (id === 'screen-tests') { refreshTestsScreen(); }
}

document.querySelectorAll('.nav-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    // FIX 12: a lateral tab switch clears the back stack — the user is
    // starting a fresh top-level context, not going deeper.
    clearBackStack();
    showScreen(btn.getAttribute('data-screen'));
  }, { passive: true });
});

/* ================= Live update (FIX 10, v1.0.12) =================
 * Everything updates live — no close/reopen. The current screen re-fetches
 * on every tab switch (see showScreen), on resume (visibilitychange), on a
 * background poll, and immediately after every mutation (each create /
 * upload / delete / generate / submit handler already re-loads its list).
 * The poll is SILENT (no spinners, no toasts, no scroll reset, open
 * sections stay open) and only polls the currently visible screen, only
 * while the app is open (never on the lock screen).
 * POLL INTERVAL (user order 2026-11-24 20:24 IST): 0.5 seconds (500ms),
 * chained with setTimeout AFTER each fetch completes (never overlapping).
 * If a poll fails, it backs off silently to 5s and returns to 0.5s on the
 * next success — never an error to the user for a background poll. */
function refreshCurrentScreen(silent) {
  if (currentScreenId === 'screen-notes') { return notesBrowser.load(silent); }
  if (currentScreenId === 'screen-practice') { refreshPracticeSets(silent); return practiceBrowser.load(silent); }
  if (currentScreenId === 'screen-tests') { return refreshSavedTests(silent); }
  // v1.0.20: on a practice sub-page, re-fetch the practice sets silently
  // and re-render this page from the fresh cache.
  if (currentScreenId === 'screen-practice-subjects' || currentScreenId === 'screen-practice-chapters' || currentScreenId === 'screen-practice-list') {
    return refreshPracticeSets(true).then(function () { rerenderPracticeSubPage(); }).catch(function () { /* silent */ });
  }
  // v1.0.18: on a test sub-page, re-fetch the tests silently and
  // re-render this page from the fresh cache.
  if (currentScreenId === 'screen-test-subjects' || currentScreenId === 'screen-test-chapters' || currentScreenId === 'screen-test-list') {
    return refreshSavedTests(true).then(function () { rerenderTestSubPage(); }).catch(function () { /* silent */ });
  }
  return Promise.resolve();
}

var livePollTimer = null;
var livePollDelay = 500;

function scheduleLivePoll(delay) {
  if (livePollTimer) { clearTimeout(livePollTimer); }
  livePollTimer = setTimeout(runLivePoll, delay);
}

async function runLivePoll() {
  livePollTimer = null;
  /* v1.0.23 scroll smoothness: never fetch + rebuild the visible list
   * mid-scroll — the rebuild (innerHTML of every row/card, plus the
   * /tests/list + /folders/list + /sections/list + /items/list round
   * trips) is what made scrolling stutter every 500ms. Defer until
   * the scroll settles; the scroll-end handler re-schedules at once. */
  if (isScrolling) { pollDeferredWhileScrolling = true; scheduleLivePoll(300); return; }
  try {
    await refreshCurrentScreen(true);
    livePollDelay = 500; // success: back to 0.5s
  } catch (e) {
    livePollDelay = 5000; // failure: back off silently to 5s
  }
  scheduleLivePoll(livePollDelay);
}

function startLivePoll() {
  stopLivePoll();
  livePollDelay = 500;
  scheduleLivePoll(500);
}

function stopLivePoll() {
  if (livePollTimer) { clearTimeout(livePollTimer); livePollTimer = null; }
}

/* v1.0.23 scroll smoothness — scroll state shared by the live poll and
 * the aurora (see styles.css html.is-scrolling). The listener is
 * passive (never blocks scrolling) and capture-phase, so the inner
 * scrollers (chat list, palette grid, viewer) pause the poll/aurora
 * too. Scroll "ends" 150ms after the last scroll event; a poll that
 * was deferred mid-scroll is then re-scheduled immediately. */
var isScrolling = false;
var pollDeferredWhileScrolling = false;
var scrollEndTimer = null;
function noteScrollActivity() {
  isScrolling = true;
  document.documentElement.classList.add('is-scrolling');
  if (scrollEndTimer) { clearTimeout(scrollEndTimer); }
  scrollEndTimer = setTimeout(function () {
    isScrolling = false;
    document.documentElement.classList.remove('is-scrolling');
    if (pollDeferredWhileScrolling) { pollDeferredWhileScrolling = false; scheduleLivePoll(50); }
  }, 150);
}
document.addEventListener('scroll', noteScrollActivity, { capture: true, passive: true });

/* Refresh the current screen when the app comes back to the foreground. */
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) {
    refreshCurrentScreen(true).catch(function () { /* silent */ });
  }
});

/* ================= Android back button (FIX 12, v1.0.12) =================
 * The phone's back button goes back ONE step at a time, never closing
 * everything at once. A simple back stack records each deeper step
 * (viewer, palette, choice dialog, chat menu, take test, chat);
 * one press pops one entry and undoes it. Folder/section navigation is
 * hierarchical with breadcrumb jumps, so it is handled from the live state
 * (collapse an open section, then go up one folder level) instead of a
 * recorded stack — a recorded stack would drift on a breadcrumb jump and
 * could go FORWARD instead of back. The observable behaviour is exactly
 * the required priority order:
 *   1. overlay open (viewer / palette / dialog / menu) -> close only it
 *   2. section open or inside a folder -> back one level
 *   3. sub-screen (take / chat) -> back to the main screen
 *   4. main tab at the top level, nothing open -> exit the app
 * The in-app upper-corner back buttons call the same goBackOneStep(), so
 * both back paths always agree. */
var backStack = [];
function pushBack(entry) { backStack.push(entry); }
function popBack() { return backStack.pop() || null; }
function clearBackStack() { backStack = []; }
/* Remove the most recent entry of a kind (used when an overlay is closed
 * directly, e.g. by its own close button, so no stale entry remains). */
function removeBackEntry(kind) {
  for (var i = backStack.length - 1; i >= 0; i -= 1) {
    if (backStack[i].kind === kind) { backStack.splice(i, 1); return; }
  }
}

function goBackOneStep() {
  var entry = popBack();
  if (entry && typeof entry.undo === 'function') {
    entry.undo();
    return;
  }
  goBackByState();
}

function goBackByState() {
  // 1. Any overlay still open? Close only it.
  if ($('screen-viewer') && !$('screen-viewer').hidden) { closeViewer(); return; }
  if ($('takePalette') && !$('takePalette').hidden) { closeTakePalette(); return; }
  if ($('chatMsgMenu') && !$('chatMsgMenu').hidden) { closeChatMsgMenu(); return; }
  // 2. A sub-screen? Back to the main screen it came from.
  if (currentScreenId === 'screen-take') { exitTakeScreen(); return; }
  // v1.0.18: test navigation sub-pages — back to the parent page.
  if (currentScreenId === 'screen-test-subjects') { showScreen('screen-tests'); return; }
  if (currentScreenId === 'screen-test-chapters') { showScreen('screen-tests'); return; }
  if (currentScreenId === 'screen-test-list') {
    if (testsNav.chapter) { renderTestChapters(testsNav.subject); showScreen('screen-test-chapters'); }
    else if (testsNav.exam) { renderTestSubjects(testsNav.exam); showScreen('screen-test-subjects'); }
    else { showScreen('screen-tests'); }
    return;
  }
  // v1.0.20: practice navigation sub-pages — back to the parent page.
  if (currentScreenId === 'screen-practice-subjects') { showScreen('screen-practice'); return; }
  if (currentScreenId === 'screen-practice-chapters') {
    renderPracticeSubjects(practiceNav.exam); showScreen('screen-practice-subjects'); return;
  }
  if (currentScreenId === 'screen-practice-list') {
    if (practiceNav.chapter) { renderPracticeChapters(practiceNav.subject); showScreen('screen-practice-chapters'); }
    else if (practiceNav.subject) { renderPracticeSubjects(practiceNav.exam); showScreen('screen-practice-subjects'); }
    else { showScreen('screen-practice'); }
    return;
  }
  if (currentScreenId === 'screen-chat' || currentScreenId === 'screen-chat-lock') { stopChat(); showScreen('screen-notes'); return; }
  // 3. Folder / section back, one level (state-based).
  if (currentScreenId === 'screen-notes' || currentScreenId === 'screen-practice') {
    var browser = (currentScreenId === 'screen-notes') ? notesBrowser : practiceBrowser;
    if (browser && browser.goBackOneLevel && browser.goBackOneLevel()) { return; }
  }
  // 4. Main tab at the top level with nothing open: exit the app.
  exitApp();
}

function exitTakeScreen() {
  stopTakeTimer();
  takeState = null;
  // v1.0.20: return to the practice list this set was opened from.
  if (takeReturnContext && takeReturnContext.mode === 'practice') {
    var pctx = takeReturnContext;
    takeReturnContext = null;
    practiceNav = { exam: pctx.exam, subject: pctx.subject, chapter: pctx.chapter };
    if (pctx.chapter) {
      renderPracticeList(practiceForChapter(pctx.exam, pctx.subject, pctx.chapter), pctx.chapter);
    } else if (pctx.subject) {
      renderPracticeList(practiceForSubject(pctx.exam, pctx.subject), pctx.subject);
    }
    showScreen('screen-practice-list');
    return;
  }
  // v1.0.18: return to the test list this test was opened from.
  if (takeReturnContext) {
    var ctx = takeReturnContext;
    takeReturnContext = null;
    testsNav = { exam: ctx.exam, subject: ctx.subject, chapter: ctx.chapter };
    if (ctx.chapter) {
      renderTestList(testsForChapter(ctx.exam, ctx.subject, ctx.chapter), ctx.chapter);
    } else if (ctx.subject) {
      renderTestList(testsForSubject(ctx.exam, ctx.subject), ctx.subject);
    }
    showScreen('screen-test-list');
    return;
  }
  showScreen('screen-tests');
}

function exitApp() {
  var AppPlugin = capPlugin('App');
  if (AppPlugin && AppPlugin.exitApp) { AppPlugin.exitApp(); }
  // Without the plugin (web preview) there is no system back button, so
  // doing nothing here is correct.
}

/* Wire the Capacitor App plugin (@capacitor/app is already installed and
 * synced — see android/app/src/main/assets/capacitor.plugins.json).
 * Registering a backButton listener suppresses the default exit, so this
 * handler IS the back behaviour. */
(function setupSystemBackButton() {
  var AppPlugin = capPlugin('App');
  if (!AppPlugin || !AppPlugin.addListener) { return; }
  AppPlugin.addListener('backButton', function () { goBackOneStep(); });
  AppPlugin.addListener('appStateChange', function (state) {
    if (state && state.isActive) {
      refreshCurrentScreen(true).catch(function () { /* silent */ });
    }
  });
})();

/* ================= No-password entry (v1.0.23) =================
 * No login screen, no password, no revalidation: the app opens
 * straight to Notes and the device id (see getDeviceInfo) is the
 * only identity, sent as {deviceId} on every server call. */
function enterApp() {
  $('activeChip').hidden = false;
  showScreen('screen-notes');
  loadCompletions(); // v1.0.14: green ticks for Mark as Complete
  startLivePoll();
  checkForUpdate();
}

/* ================= API helper ================= */
/* POST JSON to the server with {deviceId} only (v1.0.23: no password).
 * Failures surface as one short line: "Not allowed." / "Try again." */
async function apiCall(path, extra) {
  // Device id must always be set before any server call — an empty
  // deviceId used to make folders/sections look unmade and invisible.
  if (!window.MsStudySession.deviceId) {
    var dinfo = await getDeviceInfo();
    window.MsStudySession.deviceId = dinfo.deviceId;
    window.MsStudySession.deviceLabel = dinfo.deviceLabel;
  }
  var body = { deviceId: window.MsStudySession.deviceId };
  Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
  var res = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  var data = await res.json().catch(function () { return {}; });
  if (data && (data.result === 'incorrect' || data.result === 'kicked')) { throw new Error('Try again.'); }
  if (data && data.result === 'unauthorized') { throw new Error('Not allowed.'); }
  if (data && data.result === 'unavailable') { throw new Error('Try again.'); }
  if (!res.ok) { throw new Error('Try again.'); }
  return data;
}

/* ================= Mark as Complete (v1.0.14) ================= */
/* Every folder / section / note / practice sheet — and every test and
 * practice-set card — has a 3-dot menu with "Mark as complete": a
 * green-circled tick shows on the row/card. The completion is stored
 * on the server keyed by device_id (ms_completions), so the tick
 * follows this device. Test cards use item_type "test", practice
 * cards use item_type "practice", so the two never collide. */
var completions = {}; // "type:id" -> true

async function loadCompletions() {
  try {
    var data = await apiCall('/complete/list', {});
    completions = {};
    (data.completions || []).forEach(function (c) {
      if (c && c.item_type && c.item_id) { completions[c.item_type + ':' + c.item_id] = true; }
    });
  } catch (e) { /* silent: ticks just don't show until the next load */ }
}

function isComplete(itemType, itemId) { return !!completions[itemType + ':' + itemId]; }

async function toggleComplete(itemType, itemId) {
  var done = isComplete(itemType, itemId);
  try {
    var data = await apiCall(done ? '/complete/unmark' : '/complete/mark', { itemType: itemType, itemId: itemId });
    if (data && data.result === 'ok') {
      if (done) { delete completions[itemType + ':' + itemId]; } else { completions[itemType + ':' + itemId] = true; }
      refreshCurrentScreen(true).catch(function () { /* silent */ });
    }
  } catch (e) { /* silent */ }
}

/* The 3-dot row menu (one shared popup). Tapping ⋮ on any folder /
 * section / note / sheet opens it near the button; the single option
 * toggles that row's completion. */
var rowMenuTarget = null; // {type, id}
function openRowMenu(type, id, anchorEl) {
  rowMenuTarget = { type: type, id: id };
  $('rowMenuComplete').textContent = isComplete(type, id) ? 'Mark as incomplete' : 'Mark as complete';
  var menu = $('rowMenu');
  menu.hidden = false;
  var r = anchorEl.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - 110, r.bottom + 6) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  pushBack({ kind: 'rowmenu', undo: closeRowMenu });
}
function closeRowMenu() {
  removeBackEntry('rowmenu');
  rowMenuTarget = null;
  var m = $('rowMenu');
  if (m) { m.hidden = true; }
}

/* ================= Folder browser (Notes / Tests / Practice / Classes) ================= */
/* Each browser keeps its own folder + path. Folders open on tap
 * (breadcrumb to go back), sections expand to show their items,
 * items open their Drive link on tap.
 * Inside a folder: "New folder" / "New section" create row.
 * Inside an open section: Note / Practice sheet upload
 * cards — both kinds, on every browser screen. */
function createBrowser(opts) {
  var state = { folderId: null, path: [], foldersById: {}, expanded: {} };

  function renderCrumb() {
    var c = $(opts.crumb);
    if (!c) { return; }
    var html = '<button type="button" class="crumb-btn" data-crumb="">All</button>';
    state.path.forEach(function (p, i) {
      html += '<span class="crumb-sep">/</span><button type="button" class="crumb-btn" data-crumb="' + i + '">' + esc(p.name) + '</button>';
    });
    c.innerHTML = html;
  }

  /* Create row, inside the CURRENT folder ("All" = top level).
   * New folder works at any level; New section needs a folder open. */
  function renderCreate() {
    var box = $(opts.create);
    if (!box) { return; }
    box.hidden = false;
    var html = '<div class="row-form"><input class="field-input" data-new-folder type="text" placeholder="Folder name" autocomplete="off" />' +
      '<button class="btn-secondary" data-add-folder type="button">Add folder</button></div>' +
      '<p class="muted small" data-folder-status></p>';
    if (state.folderId) {
      html += '<div class="row-form"><input class="field-input" data-new-section type="text" placeholder="Section name" autocomplete="off" />' +
        '<button class="btn-secondary" data-add-section type="button">Add section</button></div>' +
        '<p class="muted small" data-section-status></p>';
    } else {
      html += '<p class="muted small">Open a folder first.</p>';
    }
    box.innerHTML = html;
  }

  function setCreateStatus(kind, msg) {
    var box = $(opts.create);
    if (!box) { return; }
    var el = box.querySelector('[data-' + kind + '-status]');
    if (el) { el.textContent = msg; }
  }

  async function createFolder() {
    var box = $(opts.create);
    if (!box) { return; }
    var input = box.querySelector('[data-new-folder]');
    var name = (input && input.value ? input.value : '').trim();
    if (!name) { setCreateStatus('folder', 'Enter a name.'); return; }
    var btn = box.querySelector('[data-add-folder]');
    if (btn) { btn.disabled = true; }
    setCreateStatus('folder', 'Creating…');
    try {
      await apiCall('/folders/create', { name: name, parentId: state.folderId, scope: opts.scope });
      if (input) { input.value = ''; }
      setCreateStatus('folder', 'Folder created.');
      load();
    } catch (e) {
      setCreateStatus('folder', e.message || 'Try again.');
    } finally {
      if (btn) { btn.disabled = false; }
    }
  }

  async function createSection() {
    var box = $(opts.create);
    if (!box) { return; }
    if (!state.folderId) { setCreateStatus('section', 'Open a folder first.'); return; }
    var input = box.querySelector('[data-new-section]');
    var name = (input && input.value ? input.value : '').trim();
    if (!name) { setCreateStatus('section', 'Enter a name.'); return; }
    var btn = box.querySelector('[data-add-section]');
    if (btn) { btn.disabled = true; }
    setCreateStatus('section', 'Creating…');
    try {
      await apiCall('/sections/create', { name: name, folderId: state.folderId });
      if (input) { input.value = ''; }
      setCreateStatus('section', 'Section created.');
      load();
    } catch (e) {
      setCreateStatus('section', e.message || 'Try again.');
    } finally {
      if (btn) { btn.disabled = false; }
    }
  }

  /* Upload cards inside an open section — all three kinds, every screen.
   * data-section carries the section id for the upload. */
  function uploadCardsHtml(sectionId) {
    var kinds = [['note', 'Note'], ['sheet', 'Practice sheet']];
    var html = '<div class="section-uploads">';
    kinds.forEach(function (k) {
      html += '<div class="upload-card" data-section="' + esc(sectionId) + '">' +
        '<div class="upload-title">Upload ' + k[1] + '</div>' +
        '<input class="field-input" data-up-title="' + k[0] + '" type="text" placeholder="Title" autocomplete="off" />' +
        '<input class="field-input file-input" data-up-file="' + k[0] + '" type="file" />' +
        '<button class="btn-primary" data-up-btn="' + k[0] + '" type="button">Upload</button>' +
        '<p class="muted small" data-up-status="' + k[0] + '"></p>' +
        '</div>';
    });
    return html + '</div>';
  }

  async function loadSectionItems(sectionId, box, silent) {
    if (!silent) { box.innerHTML = '<p class="muted">Loading…</p>'; }
    box.hidden = false;
    try {
      var data = await apiCall('/items/list', { folderId: state.folderId, sectionId: sectionId });
      var items = (data && data.items) || [];
      if (opts.kind) { items = items.filter(function (it) { return it.kind === opts.kind; }); }
      var html = '';
      if (items.length === 0) { html = '<p class="muted">Empty.</p>'; }
      items.forEach(function (it) {
        // FIX 7 (v1.0.12): items open in the in-app viewer — never Drive.
        html += '<div class="row-wrap"><button type="button" class="row-item row-main" data-item="1" data-item-id="' + esc(it.id || '') + '" data-item-kind="' + esc(it.kind || '') + '" data-item-title="' + esc(it.title || '') + '" data-item-file="' + esc(it.drive_file_id || '') + '">' +
          esc(it.title || '') + '</button>' +
          (isComplete('item', it.id) ? '<span class="complete-tick">✓</span>' : '') +
          '<button type="button" class="row-dot" data-dot-type="item" data-dot-id="' + esc(it.id || '') + '" aria-label="Options">⋮</button></div>';
      });
      html += uploadCardsHtml(sectionId);
      box.innerHTML = html;
    } catch (e) {
      if (!silent) {
        box.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
      }
      if (silent) { throw e; }
    }
  }

  function toggleSection(sectionId, box) {
    if (!box.hidden) { box.hidden = true; return; }
    loadSectionItems(sectionId, box);
  }

  async function uploadIntoSection(btn) {
    var kind = btn.getAttribute('data-up-btn');
    var card = btn.closest('.upload-card');
    if (!card || !kind) { return; }
    var sectionId = card.getAttribute('data-section');
    var titleInput = card.querySelector('[data-up-title="' + kind + '"]');
    var fileInput = card.querySelector('[data-up-file="' + kind + '"]');
    var status = card.querySelector('[data-up-status="' + kind + '"]');
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { if (status) { status.textContent = 'Choose a file.'; } return; }
    var title = (titleInput && titleInput.value ? titleInput.value : '').trim();
    btn.disabled = true;
    if (status) { status.textContent = 'Uploading…'; }
    try {
      await window.MsDrive.upload(file, title, kind, state.folderId, sectionId);
      if (status) { status.textContent = 'Uploaded.'; }
      if (fileInput) { fileInput.value = ''; }
      if (titleInput) { titleInput.value = ''; }
      var box = $(opts.list + '-sec-' + sectionId);
      if (box) { loadSectionItems(sectionId, box); }
    } catch (e) {
      if (status) { status.textContent = e.message || 'Try again.'; }
    } finally {
      btn.disabled = false;
    }
  }

  /* Delete: confirm first; the folder delete also removes
   * its subfolders, sections and items server-side. If the deleted folder
   * is the one (or an ancestor of the one) currently open, go back to
   * the top level instead of showing a dead breadcrumb. */
  async function deleteFolder(folderId) {
    if (!window.confirm('Delete this folder and everything inside it?')) { return; }
    try {
      await apiCall('/folders/delete', { folderId: folderId });
      if (state.folderId === folderId || state.path.some(function (p) { return p.id === folderId; })) {
        state.folderId = null; state.path = []; state.expanded = {};
      }
      load();
    } catch (e) {
      setCreateStatus('folder', e.message || 'Try again.');
    }
  }

  async function deleteSection(sectionId) {
    if (!window.confirm('Delete this section and its items?')) { return; }
    try {
      await apiCall('/sections/delete', { sectionId: sectionId });
      load();
    } catch (e) {
      setCreateStatus('section', e.message || 'Try again.');
    }
  }

  function openFolder(id, name) {
    state.folderId = id;
    state.path.push({ id: id, name: name });
    state.expanded = {};
    load();
  }

  function goCrumb(idx) {
    if (idx === '' || idx == null) {
      state.folderId = null;
      state.path = [];
    } else {
      var i = parseInt(idx, 10);
      state.path = state.path.slice(0, i + 1);
      state.folderId = state.path[state.path.length - 1].id;
    }
    state.expanded = {};
    load();
  }

  async function load(silent) {
    var list = $(opts.list);
    if (!list) { return; }
    // v1.0.13 FIX (PDF upload bug, user video 2026-11-24 22:54 IST):
    // the 0.5s silent poll rebuilt the whole list AND every open
    // section (including its upload card) every 500ms — so a picked
    // PDF file was wiped within half a second, before she could tap
    // Upload ("Choose a file." every time, upload never happened).
    // A silent refresh must NEVER run while an upload is in progress:
    // if any open section's upload card has a file picked, or the user
    // is typing in it, skip this refresh entirely — the next poll
    // (500ms later) will pick up new items once the upload is done.
    if (silent) {
      var uploadBusy = false;
      list.querySelectorAll('.section-items').forEach(function (box) {
        if (box.hidden) { return; }
        var fis = box.querySelectorAll('.file-input');
        for (var i = 0; i < fis.length; i++) {
          if (fis[i].files && fis[i].files.length) { uploadBusy = true; }
        }
        if (box.contains(document.activeElement) && document.activeElement && document.activeElement.tagName === 'INPUT') { uploadBusy = true; }
      });
      if (uploadBusy) { return; }
    }
    // FIX 10 (v1.0.12): a silent refresh (background poll) never shows a
    // spinner, never wipes the list on a transient failure, never resets
    // the scroll, and keeps open sections open (refreshing their items).
    var openSections = [];
    var scrollY = 0;
    if (silent) {
      scrollY = window.scrollY || 0;
      list.querySelectorAll('.section-items').forEach(function (box) {
        if (!box.hidden) {
          var m = box.id.match(/-sec-(.+)$/);
          if (m) { openSections.push(m[1]); }
        }
      });
    } else {
      renderCrumb();
      renderCreate();
      list.innerHTML = '<p class="muted">Loading…</p>';
    }
    try {
      var fdata = await apiCall('/folders/list', { parentId: state.folderId, scope: opts.scope });
      var folders = (fdata && fdata.folders) || [];
      // Sections live INSIDE a folder — at the top level ("All") there is
      // no folder open, and /sections/list answers "unavailable" without
      // one. Calling it anyway made the whole list fail with "Try again."
      // and no folder ever showed, even though creates were succeeding.
      var sections = [];
      if (state.folderId) {
        var sdata = await apiCall('/sections/list', { folderId: state.folderId });
        sections = (sdata && sdata.sections) || [];
      }
      var idata = await apiCall('/items/list', { folderId: state.folderId, sectionId: null });
      var items = (idata && idata.items) || [];
      if (opts.kind) { items = items.filter(function (it) { return it.kind === opts.kind; }); }
      state.foldersById = {};
      folders.forEach(function (f) { state.foldersById[f.id] = f.name; });
      var html = '';
      folders.forEach(function (f) {
        html += '<div class="row-wrap"><button type="button" class="row-item row-main" data-folder="' + esc(f.id) + '">' + '📁 ' + esc(f.name) + '</button>' +
          (isComplete('folder', f.id) ? '<span class="complete-tick">✓</span>' : '') +
          '<button type="button" class="row-dot" data-dot-type="folder" data-dot-id="' + esc(f.id) + '" aria-label="Options">⋮</button>' +
          '<button type="button" class="row-del" data-del-folder="' + esc(f.id) + '" aria-label="Delete folder">×</button></div>';
      });
      sections.forEach(function (s) {
        // FIX 8 (v1.0.12): a section with EXACTLY ONE item opens that item
        // directly on tap — no item row, no expand. 0 or 2+ items keep the
        // normal expand behaviour. The hidden section-items div stays so
        // upload/delete still have their box.
        var single = (s.item_count === 1 && s.single_item) ? s.single_item : null;
        var openAttrs = '';
        if (single) {
          openAttrs = ' data-open-item="1" data-item-kind="' + esc(single.kind || '') + '" data-item-title="' + esc(single.title || '') + '" data-item-file="' + esc(single.drive_file_id || '') + '"';
        }
        html += '<div class="row-wrap"><button type="button" class="row-item row-main" data-section="' + esc(s.id) + '"' + openAttrs + '>' + '▸ ' + esc(s.name) + '</button>' +
          (isComplete('section', s.id) ? '<span class="complete-tick">✓</span>' : '') +
          '<button type="button" class="row-dot" data-dot-type="section" data-dot-id="' + esc(s.id) + '" aria-label="Options">⋮</button>' +
          '<button type="button" class="row-del" data-del-section="' + esc(s.id) + '" aria-label="Delete section">×</button></div>';
        html += '<div class="section-items" id="' + opts.list + '-sec-' + esc(s.id) + '" hidden></div>';
      });
      items.forEach(function (it) {
        // FIX 7 (v1.0.12): items open in the in-app viewer — never Drive.
        html += '<div class="row-wrap"><button type="button" class="row-item row-main" data-item="1" data-item-id="' + esc(it.id || '') + '" data-item-kind="' + esc(it.kind || '') + '" data-item-title="' + esc(it.title || '') + '" data-item-file="' + esc(it.drive_file_id || '') + '">' +
          esc(it.title || '') + '</button>' +
          (isComplete('item', it.id) ? '<span class="complete-tick">✓</span>' : '') +
          '<button type="button" class="row-dot" data-dot-type="item" data-dot-id="' + esc(it.id || '') + '" aria-label="Options">⋮</button></div>';
      });
      if (!html) { html = '<p class="muted">Empty.</p>'; }
      list.innerHTML = html;
      if (silent) {
        // Re-open the sections that were open before the refresh, and
        // refresh their items in place.
        openSections.forEach(function (sid) {
          var box = $(opts.list + '-sec-' + sid);
          if (box) { loadSectionItems(sid, box, true); }
        });
        if (scrollY) { window.scrollTo(0, scrollY); }
      }
    } catch (e) {
      if (!silent) {
        list.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
      }
      // Silent: keep the old content; the next poll retries. Re-throw so
      // the poll can back off.
      if (silent) { throw e; }
    }
  }

  function bind() {
    var crumb = $(opts.crumb);
    if (crumb) {
      crumb.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-crumb]');
        if (!b) { return; }
        goCrumb(b.getAttribute('data-crumb'));
      });
    }
    var createBox = $(opts.create);
    if (createBox) {
      createBox.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-add-folder]')) { createFolder(); return; }
        if (ev.target.closest('[data-add-section]')) { createSection(); return; }
      });
    }
    var list = $(opts.list);
    if (list) {
      list.addEventListener('click', function (ev) {
        // v1.0.14: the 3-dot menu — checked FIRST so tapping ⋮ never
        // opens the folder/section/item underneath it.
        var dot = ev.target.closest('[data-dot-type]');
        if (dot) { openRowMenu(dot.getAttribute('data-dot-type'), dot.getAttribute('data-dot-id'), dot); return; }
        var df = ev.target.closest('[data-del-folder]');
        if (df) { deleteFolder(df.getAttribute('data-del-folder')); return; }
        var ds = ev.target.closest('[data-del-section]');
        if (ds) { deleteSection(ds.getAttribute('data-del-section')); return; }
        var up = ev.target.closest('[data-up-btn]');
        if (up) { uploadIntoSection(up); return; }
        /* Taps inside an upload card (title / file inputs, status text)
         * must NOT toggle the section: the card itself carries
         * data-section (uploadIntoSection reads the section id from it),
         * so closest('[data-section]') below would match the card and
         * collapse the open section. That hid the card the moment the
         * user tapped the file input, and re-expanding re-rendered the
         * card and wiped the picked file — so no upload could ever
         * complete ("Choose a file." every time). */
        if (ev.target.closest('.upload-card')) { return; }
        // FIX 8 (v1.0.12): a single-item section opens its item directly —
        // checked BEFORE the normal section toggle, so it never expands.
        var oi = ev.target.closest('[data-open-item]');
        if (oi) {
          openViewer({ id: '', kind: oi.getAttribute('data-item-kind') || '', title: oi.getAttribute('data-item-title') || '', fileId: oi.getAttribute('data-item-file') || '' });
          return;
        }
        var f = ev.target.closest('[data-folder]');
        if (f) { openFolder(f.getAttribute('data-folder'), state.foldersById[f.getAttribute('data-folder')] || ''); return; }
        var s = ev.target.closest('[data-section]');
        if (s) {
          var box = $(opts.list + '-sec-' + s.getAttribute('data-section'));
          if (box) { toggleSection(s.getAttribute('data-section'), box); }
          return;
        }
        // FIX 7 (v1.0.12): an item opens in the in-app viewer — never Drive.
        var l = ev.target.closest('[data-item]');
        if (l) {
          openViewer({ id: l.getAttribute('data-item-id') || '', kind: l.getAttribute('data-item-kind') || '', title: l.getAttribute('data-item-title') || '', fileId: l.getAttribute('data-item-file') || '' });
          return;
        }
      });
    }
  }

  /* FIX 12 (v1.0.12): one step back inside this browser — collapse an
   * open section first, otherwise go up one folder level. Returns false
   * when already at the top level with nothing open. */
  function goBackOneLevel() {
    var list = $(opts.list);
    var openBox = null;
    if (list) {
      list.querySelectorAll('.section-items').forEach(function (box) {
        if (!box.hidden) { openBox = box; }
      });
    }
    if (openBox) {
      openBox.hidden = true;
      return true;
    }
    if (state.folderId) {
      var parentIdx = state.path.length - 2;
      goCrumb(parentIdx < 0 ? '' : parentIdx);
      return true;
    }
    return false;
  }

  bind();
  return { load: load, goBackOneLevel: goBackOneLevel };
}

/* ================= In-app PDF viewer (FIX 7, v1.0.12) =================
 * A note/sheet opens INSIDE the app — never a Drive redirect. PDFs render
 * with PDF.js (bundled in vendor/pdfjs/); images show as a plain <img>.
 * The file bytes come from the server's POST /drive/file proxy (a Drive
 * link has no CORS headers, so PDF.js could not fetch it directly). If the
 * file cannot be opened, a clean in-app error shows — never a redirect. */
var viewerState = { doc: null, page: 1, total: 0, title: '', blobUrl: null };

function viewerShowError() {
  $('viewerCanvas').hidden = true;
  $('viewerImg').hidden = true;
  $('viewerNav').hidden = true;
  $('viewerError').hidden = false;
}

async function renderViewerPage() {
  var doc = viewerState.doc;
  if (!doc) { return; }
  try {
    var page = await doc.getPage(viewerState.page);
    var viewport = page.getViewport({ scale: 1.5 });
    var canvas = $('viewerCanvas');
    var ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    $('viewerPageLabel').textContent = 'Page ' + viewerState.page + ' of ' + viewerState.total;
    $('viewerPrevBtn').disabled = (viewerState.page <= 1);
    $('viewerNextBtn').disabled = (viewerState.page >= viewerState.total);
  } catch (e) { viewerShowError(); }
}

async function openViewer(item) {
  var fileId = (item && item.fileId) || '';
  var title = (item && item.title) || 'File';
  if (!fileId) { return; }
  if (viewerState.doc) { try { viewerState.doc.destroy(); } catch (e) {} }
  viewerState.doc = null; viewerState.page = 1; viewerState.total = 0; viewerState.title = title;
  if (viewerState.blobUrl) { try { URL.revokeObjectURL(viewerState.blobUrl); } catch (e) {} viewerState.blobUrl = null; }
  $('viewerTitle').textContent = title;
  $('viewerCanvas').hidden = true;
  $('viewerImg').hidden = true;
  $('viewerNav').hidden = true;
  $('viewerError').hidden = true;
  $('screen-viewer').hidden = false;
  pushBack({ kind: 'viewer', undo: closeViewer });
  try {
    var res = await fetch(SERVER_URL + '/drive/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: window.MsStudySession.deviceId, fileId: fileId })
    });
    if (!res.ok) { viewerShowError(); return; }
    var contentType = (res.headers.get('Content-Type') || '').toLowerCase();
    var buf = await res.arrayBuffer();
    if (contentType.indexOf('image/') === 0) {
      var blob = new Blob([buf], { type: contentType.split(';')[0] });
      viewerState.blobUrl = URL.createObjectURL(blob);
      $('viewerImg').src = viewerState.blobUrl;
      $('viewerImg').hidden = false;
      return;
    }
    if (typeof window.pdfjsLib === 'undefined') { viewerShowError(); return; }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    var doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    viewerState.doc = doc;
    viewerState.total = doc.numPages;
    viewerState.page = 1;
    $('viewerCanvas').hidden = false;
    $('viewerNav').hidden = false;
    await renderViewerPage();
  } catch (e) {
    viewerShowError();
  }
}

function closeViewer() {
  removeBackEntry('viewer');
  if (viewerState.doc) { try { viewerState.doc.destroy(); } catch (e) {} }
  viewerState.doc = null;
  if (viewerState.blobUrl) { try { URL.revokeObjectURL(viewerState.blobUrl); } catch (e) {} viewerState.blobUrl = null; }
  $('screen-viewer').hidden = true;
}

$('viewerCloseBtn').addEventListener('click', function () { goBackOneStep(); });
$('viewerPrevBtn').addEventListener('click', function () {
  if (viewerState.doc && viewerState.page > 1) { viewerState.page -= 1; renderViewerPage(); }
});
$('viewerNextBtn').addEventListener('click', function () {
  if (viewerState.doc && viewerState.page < viewerState.total) { viewerState.page += 1; renderViewerPage(); }
});

/* Scope: a folder created on one screen only ever shows on that screen.
 * Notes='notes', Practice='practice', Tests='tests'. (Classes was removed.) */
var notesBrowser = createBrowser({ crumb: 'notesCrumb', list: 'notesList', kind: 'note', create: 'notesCreate', scope: 'notes' });
var practiceBrowser = createBrowser({ crumb: 'practiceCrumb', list: 'practiceList', kind: 'sheet', create: 'practiceCreate', scope: 'practice' });

/* ================= Tests screen: saved tests ================= */
/* v1.0.14 (user order 2026-11-25): AI test generation REMOVED entirely —
 * tests are now uploaded manually (checked answers) and visible to all.
 * The AI form is gone from the app; this only refreshes saved tests. */
function refreshTestsScreen() {
  refreshSavedTests();
}

/* The current user's latest attempt per test id (from /tests/last-attempt).
 * Attempts are per-device, so this map only ever holds THIS user's results. */
var savedAttempts = {};
var lastAttemptChecked = {};

/* v1.0.18 (user order 2026-11-25): test navigation is PAGE-BASED.
 * Every level opens a NEW page — never expand/collapse in place.
 *   Tests screen → Exam folders (full name only, no counts)
 *   Exam → Subject page (names only, no counts)
 *   Subject → Chapter page (chapter tests only; names only)
 *   Chapter (or Subject for sectional) → Test page
 * A test card shows Attempt when never taken, and Result + Re-attempt
 * when this user has taken it (Vidyagram-style). */
var allTestsCache = [];
var testsNav = { exam: null, subject: null, chapter: null };
var takeReturnContext = null; // where to return after a test / result view

function testExamOf(t) {
  return (t.exam || 'Chapter Test').toString();
}
function testCategoryOf(t) {
  return (t.category || 'Tests').toString();
}
function testChapterOf(t) {
  return (t.chapter || '').toString();
}
/* v1.0.19: the Chapter Test / Sectional Test tabs are back on top.
 * A chapter test always has a chapter; a sectional test has none —
 * that is how the tabs split the tests.
 * v1.0.19 (user order 2026-11-25): NO exam level for chapter tests —
 * Vidyagram does not name any exam for them, so the Chapter tab goes
 * straight to subjects. Sectional tests DO have exams (SSC CGL, UP
 * Police, …), so the Sectional tab goes Exam → Subject → Test. */
function isChapterTest(t) {
  return testChapterOf(t).trim().length > 0;
}
function tabTests() {
  var tab = window.__testsTab || 'chapter';
  // v1.0.20: belt-and-braces — practice sets never leak into the Tests
  // tab (the server also defaults /tests/list to kind "notes").
  return allTestsCache.filter(function (t) {
    if ((t.kind || 'notes') === 'practice') { return false; }
    return tab === 'chapter' ? isChapterTest(t) : !isChapterTest(t);
  });
}
function testsForExam(exam) {
  return tabTests().filter(function (t) { return testExamOf(t) === exam; });
}
function testsForSubjectTab(subject) {
  return tabTests().filter(function (t) { return testCategoryOf(t) === subject; });
}
function chaptersForSubject(subject) {
  return uniqueSorted(testsForSubjectTab(subject).map(function (t) { return testChapterOf(t); }).filter(function (c) { return !!c; }));
}
function testsForSubject(exam, subject) {
  // exam is null in the Chapter tab (no exam level there) — then match
  // by subject only. In the Sectional tab exam is set — match both.
  var base = exam ? testsForExam(exam) : tabTests();
  return base.filter(function (t) { return testCategoryOf(t) === subject; });
}
function testsForChapter(exam, subject, chapter) {
  return testsForSubject(exam, subject).filter(function (t) { return testChapterOf(t) === chapter; });
}
function uniqueSorted(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
  return out.sort();
}
function navRowHtml(label, attr, val) {
  return '<button type="button" class="row-item test-nav-row" ' + attr + '="' + esc(val) + '">' +
    '<span class="row-label">📁 ' + esc(label) + '</span></button>';
}

async function refreshSavedTests(silent) {
  var list = $('savedTestsList');
  if (!list) { return; }
  if (!silent) {
    list.innerHTML = '<p class="muted">Loading…</p>';
    $('testDetail').textContent = '';
  }
  try {
    var data = await apiCall('/tests/list', {});
    var tests = (data && data.tests) || [];
    allTestsCache = tests;
    var tabList = tabTests();
    if (tabList.length === 0) { list.innerHTML = '<p class="muted">No tests yet.</p>'; return; }
    // Chapter tab: subjects straight away (NO exam level — Vidyagram
    // names no exam for chapter tests). Sectional tab: exam folders
    // (full name only, NO counts).
    if ((window.__testsTab || 'chapter') === 'chapter') {
      var subjects = uniqueSorted(tabList.map(function (t) { return testCategoryOf(t); }));
      list.innerHTML = subjects.map(function (s) { return navRowHtml(s, 'data-test-subject', s); }).join('');
    } else {
      var exams = uniqueSorted(tabList.map(function (t) { return testExamOf(t); }));
      list.innerHTML = exams.map(function (ex) { return navRowHtml(ex, 'data-test-exam', ex); }).join('');
    }
    // Per-test last-attempt checks (a silent poll skips them — the
    // attempt state is already known from the initial load).
    if (silent) { return; }
    savedAttempts = {};
    tests.forEach(function (t) {
      apiCall('/tests/last-attempt', { testId: t.id }).then(function (d) {
        lastAttemptChecked[t.id] = true;
        if (d && d.attempt) { savedAttempts[t.id] = d.attempt; }
      }).catch(function () { lastAttemptChecked[t.id] = true; });
    });
  } catch (e) {
    if (!silent) {
      list.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
    }
    if (silent) { throw e; }
  }
}

function renderTestSubjects(exam) {
  var subjects = uniqueSorted(testsForExam(exam).map(function (t) { return testCategoryOf(t); }));
  $('testSubjectsTitle').textContent = exam;
  $('testSubjectList').innerHTML = subjects.length
    ? subjects.map(function (s) { return navRowHtml(s, 'data-test-subject', s); }).join('')
    : '<p class="muted">No subjects.</p>';
}

function renderTestChapters(subject) {
  var chapters = chaptersForSubject(subject);
  $('testChaptersTitle').textContent = subject;
  $('testChapterList').innerHTML = chapters.length
    ? chapters.map(function (c) { return navRowHtml(c, 'data-test-chapter', c); }).join('')
    : '<p class="muted">No chapters.</p>';
}

/* v1.0.23: every test / practice card has a 3-dot menu (Mark as
 * complete) and, when complete, a green-circled tick on the RIGHT,
 * next to the 3-dot button. completeType is "test" for test cards
 * and "practice" for practice cards (distinct item_type values, so
 * a test and a practice set never share a completion row). */
function testCardHtml(t, completeType) {
  var kind = completeType || 'test';
  var lang = (t.language === 'hi') ? 'Hindi' : (t.language === 'en') ? 'English' : (t.language || '');
  // v1.0.20: practice sets have duration_min 0 (no timer) — never show "0 min".
  var parts = [];
  if (t.question_count) { parts.push(t.question_count + ' questions'); }
  if (t.duration_min) { parts.push(t.duration_min + ' min'); }
  if (lang) { parts.push(lang); }
  var meta = parts.join(' · ');
  return '<div class="test-card" data-test="' + esc(t.id) + '">' +
    '<div class="test-card-head"><span class="test-card-title">' + esc(t.title || 'Test') + '</span>' +
    '<span class="test-card-side">' +
    (isComplete(kind, t.id) ? '<span class="complete-tick">✓</span>' : '') +
    '<button type="button" class="row-dot test-card-dot" data-dot-type="' + kind + '" data-dot-id="' + esc(t.id) + '" aria-label="Options">⋮</button>' +
    '</span></div>' +
    '<span class="test-card-meta">' + esc(meta) + '</span>' +
    '<div class="test-card-actions" data-actions-for="' + esc(t.id) + '">' +
    '<button type="button" class="btn-primary btn-glass-color test-act-btn" data-act="attempt" data-test="' + esc(t.id) + '">Attempt</button>' +
    '</div></div>';
}

function testCardActionsHtml(testId, hasAttempt) {
  if (!hasAttempt) {
    return '<button type="button" class="btn-primary btn-glass-color test-act-btn" data-act="attempt" data-test="' + esc(testId) + '">Attempt</button>';
  }
  return '<button type="button" class="btn-secondary test-act-btn" data-act="result" data-test="' + esc(testId) + '">Result</button>' +
    '<button type="button" class="btn-primary btn-glass-color test-act-btn" data-act="reattempt" data-test="' + esc(testId) + '">Re-attempt</button>';
}

/* v1.0.20: parameterised so the practice list reuses the same cards
 * (Attempt / Result + Re-attempt come free). ids defaults to the test
 * list elements; practice passes its own. */
function renderTestList(tests, title, ids, completeType) {
  ids = ids || { title: 'testListTitle', list: 'testList', detail: 'testListDetail' };
  $(ids.title).textContent = title;
  var listEl = $(ids.list);
  var detailEl = $(ids.detail);
  if (detailEl) { detailEl.textContent = ''; }
  if (!tests.length) { listEl.innerHTML = '<p class="muted">No tests.</p>'; return; }
  var kind = completeType || 'test';
  listEl.innerHTML = tests.map(function (t) { return testCardHtml(t, kind); }).join('');
  // For each test, check THIS user's latest attempt and swap the card's
  // buttons: Attempt only when never taken; Result + Re-attempt when taken.
  tests.forEach(function (t) {
    var apply = function (attempt) {
      var box = listEl.querySelector('[data-actions-for="' + t.id + '"]');
      if (box) { box.innerHTML = testCardActionsHtml(t.id, !!attempt); }
    };
    if (lastAttemptChecked[t.id]) { apply(savedAttempts[t.id] || null); return; }
    apiCall('/tests/last-attempt', { testId: t.id }).then(function (d) {
      lastAttemptChecked[t.id] = true;
      if (d && d.attempt) { savedAttempts[t.id] = d.attempt; }
      apply(d && d.attempt ? d.attempt : null);
    }).catch(function () { lastAttemptChecked[t.id] = true; });
  });
}

function rerenderTestSubPage() {
  if (currentScreenId === 'screen-test-subjects' && testsNav.exam) { renderTestSubjects(testsNav.exam); return; }
  if (currentScreenId === 'screen-test-chapters' && testsNav.subject) { renderTestChapters(testsNav.subject); return; }
  if (currentScreenId === 'screen-test-list') {
    if (testsNav.subject && testsNav.chapter) {
      renderTestList(testsForChapter(testsNav.exam, testsNav.subject, testsNav.chapter), testsNav.chapter);
    } else if (testsNav.subject) {
      renderTestList(testsForSubject(testsNav.exam, testsNav.subject), testsNav.subject);
    }
    return;
  }
}

function openTestExam(exam) {
  testsNav = { exam: exam, subject: null, chapter: null };
  renderTestSubjects(exam);
  showScreen('screen-test-subjects');
  pushBack({ kind: 'testnav', undo: function () { showScreen('screen-tests'); } });
}

function openTestSubject(subject) {
  testsNav.subject = subject;
  testsNav.chapter = null;
  // Chapter tab: subject → chapters page. Sectional tab: subject →
  // test list straight away (sectional tests have no chapters).
  if ((window.__testsTab || 'chapter') === 'chapter') {
    renderTestChapters(subject);
    showScreen('screen-test-chapters');
    pushBack({ kind: 'testnav', undo: function () { showScreen('screen-tests'); } });
  } else {
    takeReturnContext = { screen: 'screen-test-list', exam: testsNav.exam, subject: subject, chapter: null };
    renderTestList(testsForSubject(testsNav.exam, subject), subject);
    showScreen('screen-test-list');
    pushBack({ kind: 'testnav', undo: function () { renderTestSubjects(testsNav.exam); showScreen('screen-test-subjects'); } });
  }
}

function openTestChapter(chapter) {
  testsNav.chapter = chapter;
  takeReturnContext = { screen: 'screen-test-list', exam: null, subject: testsNav.subject, chapter: chapter };
  renderTestList(testsForChapter(null, testsNav.subject, chapter), chapter);
  showScreen('screen-test-list');
  pushBack({ kind: 'testnav', undo: function () { renderTestChapters(testsNav.subject); showScreen('screen-test-chapters'); } });
}

/* Back buttons on the test sub-pages — same as the system back button. */
$('testSubjectsBackBtn').addEventListener('click', goBackOneStep);
$('testChaptersBackBtn').addEventListener('click', goBackOneStep);
$('testListBackBtn').addEventListener('click', goBackOneStep);

/* v1.0.19: Chapter Test / Sectional Test tabs are back on top (user
 * order 2026-11-25). Switching tabs resets the navigation and shows
 * that tab's exams. */
$('testsTabs').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-tests-tab]');
  if (!b) { return; }
  var tab = b.getAttribute('data-tests-tab');
  if (window.__testsTab === tab) { return; }
  window.__testsTab = tab;
  testsNav = { exam: null, subject: null, chapter: null };
  clearBackStack();
  document.querySelectorAll('#testsTabs .tests-tab').forEach(function (el) {
    el.classList.toggle('tests-tab-active', el.getAttribute('data-tests-tab') === tab);
  });
  showScreen('screen-tests');
  refreshSavedTests(true);
});

$('savedTestsList').addEventListener('click', function (ev) {
  // Chapter tab: the Tests screen lists subjects — tap one to see its
  // chapters. Sectional tab: it lists exams — tap one to see subjects.
  var s = ev.target.closest('[data-test-subject]');
  if (s) { openTestSubject(s.getAttribute('data-test-subject')); return; }
  var ex = ev.target.closest('[data-test-exam]');
  if (!ex) { return; }
  openTestExam(ex.getAttribute('data-test-exam'));
});

$('testSubjectList').addEventListener('click', function (ev) {
  var s = ev.target.closest('[data-test-subject]');
  if (!s) { return; }
  openTestSubject(s.getAttribute('data-test-subject'));
});

$('testChapterList').addEventListener('click', function (ev) {
  var c = ev.target.closest('[data-test-chapter]');
  if (!c) { return; }
  openTestChapter(c.getAttribute('data-test-chapter'));
});

$('testList').addEventListener('click', function (ev) {
  var dot = ev.target.closest('[data-dot-type]');
  if (dot) { openRowMenu(dot.getAttribute('data-dot-type'), dot.getAttribute('data-dot-id'), dot); return; }
  var b = ev.target.closest('[data-act]');
  if (!b) { return; }
  var testId = b.getAttribute('data-test');
  var act = b.getAttribute('data-act');
  if (act === 'attempt' || act === 'reattempt') {
    openTest(testId);
    return;
  }
  if (act === 'result') {
    var attempt = savedAttempts[testId];
    if (attempt) { viewSavedResult(testId, attempt); return; }
    // Attempt status not loaded yet — check live, then show the result.
    var detailEl = $('testListDetail');
    if (detailEl) { detailEl.textContent = 'Loading…'; }
    apiCall('/tests/last-attempt', { testId: testId }).then(function (d) {
      lastAttemptChecked[testId] = true;
      if (detailEl) { detailEl.textContent = ''; }
      if (d && d.attempt) {
        savedAttempts[testId] = d.attempt;
        viewSavedResult(testId, d.attempt);
      } else if (detailEl) {
        detailEl.textContent = 'No result yet.';
      }
    }).catch(function (e) {
      if (detailEl) { detailEl.textContent = e.message || 'Try again.'; }
    });
  }
});
/* ================= Practice screen: question sets (v1.0.20) ================
 * Practice → Exam (UPSI) → Subject (Reasoning) → Chapter (Analogy) →
 * practice set list. Mirrors the test navigation page-for-page.
 * The sets come from /tests/list with kind "practice" — the same
 * ms_tests / ms_questions rows as tests, only the kind differs.
 * The Drive-file browser (practiceBrowser) stays BELOW the tree on the
 * same screen, untouched. */
var allPracticeCache = [];
var practiceNav = { exam: null, subject: null, chapter: null };

function practiceExamOf(t) {
  return (t.exam || 'UPSI').toString();
}
function practiceCategoryOf(t) {
  return (t.category || 'Practice').toString();
}
function practiceChapterOf(t) {
  return (t.chapter || '').toString();
}
function practiceForExam(exam) {
  return allPracticeCache.filter(function (t) { return practiceExamOf(t) === exam; });
}
function practiceForSubject(exam, subject) {
  return practiceForExam(exam).filter(function (t) { return practiceCategoryOf(t) === subject; });
}
function practiceChaptersForSubject(exam, subject) {
  return uniqueSorted(practiceForSubject(exam, subject).map(function (t) { return practiceChapterOf(t); }).filter(function (c) { return !!c; }));
}
function practiceForChapter(exam, subject, chapter) {
  return practiceForSubject(exam, subject).filter(function (t) { return practiceChapterOf(t) === chapter; });
}

async function refreshPracticeSets(silent) {
  var list = $('practiceSetList');
  if (!list) { return; }
  if (!silent) {
    list.innerHTML = '<p class="muted">Loading…</p>';
    var det = $('practiceSetDetail');
    if (det) { det.textContent = ''; }
  }
  try {
    var data = await apiCall('/tests/list', { kind: 'practice' });
    var sets = (data && data.tests) || [];
    allPracticeCache = sets;
    if (!sets.length) { list.innerHTML = '<p class="muted">No practice sets yet.</p>'; return; }
    var exams = uniqueSorted(sets.map(function (t) { return practiceExamOf(t); }));
    list.innerHTML = exams.map(function (ex) { return navRowHtml(ex, 'data-practice-exam', ex); }).join('');
    // Per-set last-attempt checks (a silent poll skips them — the attempt
    // state is already known from the initial load). Reuses the shared
    // savedAttempts / lastAttemptChecked maps (test ids are unique).
    if (silent) { return; }
    sets.forEach(function (t) {
      apiCall('/tests/last-attempt', { testId: t.id }).then(function (d) {
        lastAttemptChecked[t.id] = true;
        if (d && d.attempt) { savedAttempts[t.id] = d.attempt; }
      }).catch(function () { lastAttemptChecked[t.id] = true; });
    });
  } catch (e) {
    if (!silent) {
      list.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
    }
    if (silent) { throw e; }
  }
}

function renderPracticeSubjects(exam) {
  var subjects = uniqueSorted(practiceForExam(exam).map(function (t) { return practiceCategoryOf(t); }));
  $('practiceSubjectsTitle').textContent = exam;
  $('practiceSubjectList').innerHTML = subjects.length
    ? subjects.map(function (s) { return navRowHtml(s, 'data-practice-subject', s); }).join('')
    : '<p class="muted">No subjects.</p>';
}

function renderPracticeChapters(subject) {
  var chapters = practiceChaptersForSubject(practiceNav.exam, subject);
  $('practiceChaptersTitle').textContent = subject;
  $('practiceChapterList').innerHTML = chapters.length
    ? chapters.map(function (c) { return navRowHtml(c, 'data-practice-chapter', c); }).join('')
    : '<p class="muted">No chapters.</p>';
}

/* v1.0.21: the practice-sets list uses its own ids (practiceSetsList /
 * practiceSetsDetail). The id "practiceList" is the Drive file browser's
 * list on screen-practice — reusing it here made getElementById return
 * that hidden element, so the set cards were drawn off-screen and the
 * chapter page looked empty. */
function renderPracticeList(tests, title) {
  renderTestList(tests, title, { title: 'practiceListTitle', list: 'practiceSetsList', detail: 'practiceSetsDetail' }, 'practice');
}

function rerenderPracticeSubPage() {
  if (currentScreenId === 'screen-practice-subjects' && practiceNav.exam) { renderPracticeSubjects(practiceNav.exam); return; }
  if (currentScreenId === 'screen-practice-chapters' && practiceNav.subject) { renderPracticeChapters(practiceNav.subject); return; }
  if (currentScreenId === 'screen-practice-list') {
    if (practiceNav.subject && practiceNav.chapter) {
      renderPracticeList(practiceForChapter(practiceNav.exam, practiceNav.subject, practiceNav.chapter), practiceNav.chapter);
    } else if (practiceNav.subject) {
      renderPracticeList(practiceForSubject(practiceNav.exam, practiceNav.subject), practiceNav.subject);
    }
    return;
  }
}

function openPracticeExam(exam) {
  practiceNav = { exam: exam, subject: null, chapter: null };
  renderPracticeSubjects(exam);
  showScreen('screen-practice-subjects');
  pushBack({ kind: 'practicnav', undo: function () { showScreen('screen-practice'); } });
}

function openPracticeSubject(subject) {
  practiceNav.subject = subject;
  practiceNav.chapter = null;
  // Practice sets are chapter-wise: subject → chapters page. If a set
  // ever has no chapter, go straight to its list instead.
  if (practiceChaptersForSubject(practiceNav.exam, subject).length) {
    renderPracticeChapters(subject);
    showScreen('screen-practice-chapters');
    pushBack({ kind: 'practicnav', undo: function () { renderPracticeSubjects(practiceNav.exam); showScreen('screen-practice-subjects'); } });
  } else {
    takeReturnContext = { mode: 'practice', screen: 'screen-practice-list', exam: practiceNav.exam, subject: subject, chapter: null };
    renderPracticeList(practiceForSubject(practiceNav.exam, subject), subject);
    showScreen('screen-practice-list');
    pushBack({ kind: 'practicnav', undo: function () { renderPracticeSubjects(practiceNav.exam); showScreen('screen-practice-subjects'); } });
  }
}

function openPracticeChapter(chapter) {
  practiceNav.chapter = chapter;
  takeReturnContext = { mode: 'practice', screen: 'screen-practice-list', exam: practiceNav.exam, subject: practiceNav.subject, chapter: chapter };
  renderPracticeList(practiceForChapter(practiceNav.exam, practiceNav.subject, chapter), chapter);
  showScreen('screen-practice-list');
  pushBack({ kind: 'practicnav', undo: function () { renderPracticeChapters(practiceNav.subject); showScreen('screen-practice-chapters'); } });
}

/* Back buttons on the practice sub-pages — same as the system back button. */
$('practiceSubjectsBackBtn').addEventListener('click', goBackOneStep);
$('practiceChaptersBackBtn').addEventListener('click', goBackOneStep);
$('practiceListBackBtn').addEventListener('click', goBackOneStep);

$('practiceSetList').addEventListener('click', function (ev) {
  var ex = ev.target.closest('[data-practice-exam]');
  if (!ex) { return; }
  openPracticeExam(ex.getAttribute('data-practice-exam'));
});

$('practiceSubjectList').addEventListener('click', function (ev) {
  var s = ev.target.closest('[data-practice-subject]');
  if (!s) { return; }
  openPracticeSubject(s.getAttribute('data-practice-subject'));
});

$('practiceChapterList').addEventListener('click', function (ev) {
  var c = ev.target.closest('[data-practice-chapter]');
  if (!c) { return; }
  openPracticeChapter(c.getAttribute('data-practice-chapter'));
});

$('practiceSetsList').addEventListener('click', function (ev) {
  var dot = ev.target.closest('[data-dot-type]');
  if (dot) { openRowMenu(dot.getAttribute('data-dot-type'), dot.getAttribute('data-dot-id'), dot); return; }
  var b = ev.target.closest('[data-act]');
  if (!b) { return; }
  var testId = b.getAttribute('data-test');
  var act = b.getAttribute('data-act');
  if (act === 'attempt' || act === 'reattempt') {
    openPracticeSet(testId);
    return;
  }
  if (act === 'result') {
    var attempt = savedAttempts[testId];
    if (attempt) { viewSavedResult(testId, attempt); return; }
    var detailEl = $('practiceSetsDetail');
    if (detailEl) { detailEl.textContent = 'Loading…'; }
    apiCall('/tests/last-attempt', { testId: testId }).then(function (d) {
      lastAttemptChecked[testId] = true;
      if (detailEl) { detailEl.textContent = ''; }
      if (d && d.attempt) {
        savedAttempts[testId] = d.attempt;
        viewSavedResult(testId, d.attempt);
      } else if (detailEl) {
        detailEl.textContent = 'No result yet.';
      }
    }).catch(function (e) {
      if (detailEl) { detailEl.textContent = e.message || 'Try again.'; }
    });
  }
});

/* v1.0.14 (user order 2026-11-25): AI test generation removed — the
 * form, its listeners and the /tests/generate call are all gone. Tests
 * are uploaded manually now and visible to everyone. */

/* ================= Take a test ================= */
/* One question at a time, countdown from duration_min, score computed
 * locally, full review after submit. The result is sent to the server
 * with retries (see submitTakeResult) — a failed submit never blocks
 * the result screen; it only changes the save-status line. */
var takeState = null;

function takeFormatTime(sec) {
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function stopTakeTimer() {
  if (takeState && takeState.timer) { clearInterval(takeState.timer); takeState.timer = null; }
}

function takeRenderTimer() {
  var el = $('takeTimer');
  if (!el || !takeState) { return; }
  // v1.0.20: practice sets have no timer (remainingSec null) — blank.
  if (takeState.remainingSec == null) { el.textContent = ''; return; }
  el.textContent = 'Time left: ' + takeFormatTime(Math.max(0, takeState.remainingSec));
  el.classList.toggle('take-timer-low', takeState.remainingSec <= 60);
}

function takeRenderQuestion() {
  var st = takeState;
  if (!st) { return; }
  var q = st.questions[st.idx];
  $('takeProgress').textContent = 'Question ' + (st.idx + 1) + ' of ' + st.questions.length;
  // v1.0.15: live answered counter + marks / negative marking line.
  var answered = 0;
  st.answers.forEach(function (a) { if (a !== -1) { answered += 1; } });
  $('takeAnsweredCount').textContent = answered + ' of ' + st.questions.length + ' answered';
  $('takeMarks').textContent = 'Marks for correct answer: ' + st.marksPerQ + ' | Negative: ' + st.negativePerQ;
  // v1.0.15: zoom level applies to the question + options.
  var qEl = $('takeQuestion');
  qEl.style.fontSize = (17 + st.zoomLevel * 2) + 'px';
  qEl.textContent = q.question || '';
  // v1.0.22: image system — question figure above the stem when present.
  // Text-only questions hide the wrap, so the layout is byte-identical.
  var qImgWrap = $('takeQImageWrap');
  var qImg = $('takeQImage');
  var qImgErr = $('takeQImageError');
  if (qImgWrap && qImg) {
    if (q.question_image_url) {
      qImgWrap.hidden = false;
      if (qImgErr) { qImgErr.hidden = true; }
      if (qImg.getAttribute('src') !== q.question_image_url) { qImg.src = q.question_image_url; }
      qImg.onerror = function () { if (qImgErr) { qImgErr.hidden = false; } };
      qImg.onload = function () { if (qImgErr) { qImgErr.hidden = true; } };
    } else {
      qImgWrap.hidden = true;
      qImg.removeAttribute('src');
      qImg.onerror = null;
      qImg.onload = null;
    }
  }
  var letters = ['A', 'B', 'C', 'D'];
  var html = '';
  // v1.0.20: practice mode — instant result. Once answered, the correct
  // option goes green, a wrong chosen option goes red, and the question
  // locks (the tap handler ignores further taps on it).
  var practiceAnswered = (st.mode === 'practice' && st.answers[st.idx] !== -1);
  var correctIdx = (typeof q.answer_index === 'number') ? q.answer_index : -1;
  (q.options || []).forEach(function (opt, i) {
    var cls = 'take-option';
    if (practiceAnswered) {
      if (i === correctIdx) { cls += ' correct'; }
      else if (i === st.answers[st.idx]) { cls += ' wrong'; }
    } else if (st.answers[st.idx] === i) { cls += ' selected'; }
    // v1.0.22: image system — an option with a figure renders the image
    // (tapping the image zooms it; tapping the rest of the button selects
    // it). Text options render exactly as before.
    var optImg = (q.option_image_urls && q.option_image_urls[i]) || null;
    if (optImg) {
      html += '<button type="button" class="' + cls + ' take-option-img" data-opt="' + i +
        '" style="font-size:' + (15 + st.zoomLevel * 2) + 'px"><span class="take-opt-letter">' + letters[i] + '.</span><img class="take-optimg" src="' + esc(optImg) + '" alt="Option ' + letters[i] + ' figure" data-img="' + esc(optImg) + '"></button>';
    } else {
      html += '<button type="button" class="' + cls +
        '" data-opt="' + i + '" style="font-size:' + (15 + st.zoomLevel * 2) + 'px">' + esc(letters[i] + '. ' + (opt || '')) + '</button>';
    }
  });
  $('takeOptions').innerHTML = html;
  // v1.0.20: practice mode — the book solution appears below the options
  // as soon as an option is tapped.
  var solEl = $('takeSolution');
  if (solEl) {
    if (practiceAnswered) {
      solEl.hidden = false;
      solEl.innerHTML = '<p class="take-review-line"><strong>Solution</strong></p>' +
        '<p class="take-review-line take-explain">' + esc(q.explanation || 'No solution.') + '</p>';
    } else {
      solEl.hidden = true;
      solEl.innerHTML = '';
    }
  }
  $('takePrevBtn').disabled = (st.idx === 0);
  var last = (st.idx === st.questions.length - 1);
  $('takeNextBtn').textContent = last ? (st.mode === 'practice' ? 'Finish' : 'Submit') : 'Next';
  // v1.0.15: Mark for Review button shows the current state.
  $('takeMarkBtn').textContent = st.marked[st.idx] ? 'Unmark Review' : 'Mark for Review';
  // Palette stays live: if it is open, refresh it as the current question
  // and the answered counts change.
  var pal = $('takePalette');
  if (pal && !pal.hidden) { takeRenderPalette(); }
}

/* v1.0.20: opts.mode "practice" opens a practice set — no timer, no
 * negative marking, instant result on every tap (see takeRenderQuestion).
 * openPracticeSet() is the practice entry point (same questions endpoint). */
async function openTest(testId, opts) {
  opts = opts || {};
  var mode = (opts.mode === 'practice') ? 'practice' : 'test';
  $('testDetail').textContent = 'Loading…';
  try {
    var data = await apiCall('/tests/questions', { testId: testId });
    var questions = (data && data.questions) || [];
    var test = (data && data.test) || {};
    if (!questions.length) { $('testDetail').textContent = 'Try again.'; return; }
    stopTakeTimer();
    // v1.0.15: negative marking — 0.25 per wrong answer (Vidyagram
    // standard: 25%). Marks per question = total marks / questions
    // (usually 1). Score = correct*marksPerQ - wrong*negativePerQ.
    // v1.0.20: practice sets — 1 mark per question, no negative marking.
    var totalMarks = (typeof test.total_marks === 'number') ? test.total_marks : questions.length;
    var marksPerQ = questions.length ? Math.round((totalMarks / questions.length) * 100) / 100 : 1;
    if (!marksPerQ || marksPerQ <= 0) { marksPerQ = 1; }
    takeState = {
      test: test,
      questions: questions,
      idx: 0,
      answers: questions.map(function () { return -1; }),
      marked: questions.map(function () { return false; }),
      zoomLevel: 0,
      paused: false,
      mode: mode,
      marksPerQ: (mode === 'practice') ? 1 : marksPerQ,
      negativePerQ: (mode === 'practice') ? 0 : Math.round(marksPerQ * 0.25 * 100) / 100,
      remainingSec: (mode === 'practice') ? null : Math.max(1, (parseInt(test.duration_min, 10) || 10) * 60),
      timer: null,
      submitted: false,
      startedAt: null
    };
    $('takeTitle').textContent = test.title || 'Test';
    $('takeIntroDetail').textContent = (mode === 'practice')
      ? 'Practice set · Questions: ' + questions.length + ' · No timer · Tap an option to see the answer and solution at once.'
      : 'Duration: ' + (parseInt(test.duration_min, 10) || 10) + ' minutes · Questions: ' + questions.length + ' · Marks: ' + totalMarks + ' · Negative marking: 25% per wrong answer.';
    // v1.0.20: practice mode hides the timer, the pause button and the
    // test-only intro bullets; Submit becomes Finish; Clear is disabled
    // (a practice answer locks the moment it is tapped).
    var testOnlyBullets = document.querySelectorAll('.take-intro-testonly');
    testOnlyBullets.forEach(function (el) { el.hidden = (mode === 'practice'); });
    $('takeTimer').hidden = (mode === 'practice');
    $('takePauseBtn').hidden = (mode === 'practice');
    $('takeSubmitBtn').textContent = (mode === 'practice') ? 'Finish' : 'Submit';
    $('takeDoneBtn').textContent = (mode === 'practice') ? 'Back to practice' : 'Back to tests';
    $('takeClearBtn').disabled = (mode === 'practice');
    $('takeIntro').hidden = false;
    $('takeBody').hidden = true;
    $('takeResult').hidden = true;
    var prevStatus = $('takeSaveStatus');
    if (prevStatus) { prevStatus.textContent = ''; }
    $('testDetail').textContent = '';
    showScreen('screen-take');
    pushBack({ kind: 'take', undo: exitTakeScreen });
    takeRenderTimer();
  } catch (e) {
    $('testDetail').textContent = e.message || 'Try again.';
  }
}

/* v1.0.20: practice entry point — openTest with mode "practice". */
function openPracticeSet(testId) {
  return openTest(testId, { mode: 'practice' });
}

/* v1.0.15: the timer starts only when "I am ready to begin" is tapped
 * (Vidyagram-style instructions screen). */
function startTakeTest() {
  var st = takeState;
  if (!st || st.startedAt) { return; }
  st.startedAt = Date.now();
  $('takeIntro').hidden = true;
  $('takeBody').hidden = false;
  takeRenderQuestion();
  // v1.0.20: practice sets have no timer — no countdown interval.
  if (st.mode === 'practice') { return; }
  st.timer = setInterval(function () {
    if (!takeState || takeState.submitted || takeState.paused) { return; }
    takeState.remainingSec -= 1;
    takeRenderTimer();
    if (takeState.remainingSec <= 0) { submitTake(); }
  }, 1000);
}

function takeSaveStatusEl() {
  var el = $('takeSaveStatus');
  if (el) { return el; }
  el = document.createElement('p');
  el.id = 'takeSaveStatus';
  el.className = 'muted small';
  var scoreEl = $('takeScore');
  if (scoreEl && scoreEl.parentNode) {
    scoreEl.parentNode.insertBefore(el, scoreEl.nextSibling);
  }
  return el;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function submitTakeResult(score, total, detail) {
  // POST /tests/submit with up to 3 attempts (~800ms between them).
  // Body is exactly what handleTestsSubmit expects: deviceId (only)
  // plus testId/score/total/answers and the full
  // result detail (time taken, correct, wrong, unattempted).
  // Never blocks the result screen: the score and review are already
  // shown before this is called; only the status line changes.
  if (!takeState) { return; }
  var statusEl = takeSaveStatusEl();
  statusEl.textContent = 'Saving result…';
  var d = detail || {};
  var payload = {
    testId: takeState.test.id,
    score: score,
    total: total,
    answers: takeState.answers.slice(),
    time_taken_sec: (typeof d.timeTakenSec === 'number') ? d.timeTakenSec : 0,
    correct_count: (typeof d.correct === 'number') ? d.correct : 0,
    wrong_count: (typeof d.wrong === 'number') ? d.wrong : 0,
    unattempted_count: (typeof d.unattempted === 'number') ? d.unattempted : 0
  };
  var saved = false;
  for (var attempt = 1; attempt <= 3 && !saved; attempt++) {
    try {
      if (!window.MsStudySession.deviceId) {
        var dinfo = await getDeviceInfo();
        window.MsStudySession.deviceId = dinfo.deviceId;
        window.MsStudySession.deviceLabel = dinfo.deviceLabel;
      }
      var body = { deviceId: window.MsStudySession.deviceId };
      Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });
      var res = await fetch(SERVER_URL + '/tests/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (data && data.result === 'ok') { saved = true; }
      }
    } catch (e) { /* retry below; a failed save never blocks the result */ }
    if (!saved && attempt < 3) { await sleep(800); }
  }
  statusEl.textContent = saved ? 'Result saved.' : 'Could not save result.';
}

/* Full result summary card: score, time taken, correct, wrong, unattempted.
 * `detail` = { score, total, timeTakenSec, correct, wrong, unattempted,
 * when (optional finished_at string shown as "Attempted on …") }. */
function takeSummaryHtml(detail) {
  var d = detail || {};
  var score = (typeof d.score === 'number') ? d.score : 0;
  var total = (typeof d.total === 'number') ? d.total : 0;
  var timeSec = (typeof d.timeTakenSec === 'number') ? d.timeTakenSec : 0;
  var correct = (typeof d.correct === 'number') ? d.correct : 0;
  var wrong = (typeof d.wrong === 'number') ? d.wrong : 0;
  var unattempted = (typeof d.unattempted === 'number') ? d.unattempted : 0;
  var html = '<div class="take-summary">' +
    '<p class="take-summary-big">Score: ' + score + ' / ' + total + '</p>' +
    // v1.0.20: practice sets have no timer — hide the Time row.
    (d.hideTime ? '' : '<div class="take-summary-row"><span>Time taken</span><span>' + esc(takeFormatTime(Math.max(0, timeSec))) + '</span></div>') +
    '<div class="take-summary-row"><span class="take-correct">Correct</span><span class="take-correct">' + correct + '</span></div>' +
    '<div class="take-summary-row"><span class="take-wrong">Wrong</span><span class="take-wrong">' + wrong + '</span></div>' +
    '<div class="take-summary-row"><span>Unattempted</span><span>' + unattempted + '</span></div>' +
    (d.when ? '<p class="take-summary-when">Attempted on ' + esc(d.when) + '</p>' : '') +
    '</div>';
  return html;
}

/* Question-by-question review from a questions list + an answers array
 * (answers[i] = chosen option index, -1 = not answered). Shared by the
 * fresh result and the saved-result view. v1.0.15: filter tabs
 * (All/Correct/Incorrect/Unattempted/Marked) + a "Marked for review"
 * tag on flagged questions. */
var takeReviewFilter = 'all';
var takeReviewCache = null; // {questions, answers, marked}

function takeReviewHtml(questions, answers, marked) {
  var letters = ['A', 'B', 'C', 'D'];
  var html = '';
  (questions || []).forEach(function (q, i) {
    var chosen = (answers && typeof answers[i] === 'number') ? answers[i] : -1;
    var correct = (typeof q.answer_index === 'number') ? q.answer_index : -1;
    var ok = (chosen !== -1 && chosen === correct);
    var isMarked = !!(marked && marked[i]);
    var kind = ok ? 'correct' : (chosen === -1 ? 'unattempted' : 'incorrect');
    // Apply the active filter tab.
    if (takeReviewFilter !== 'all') {
      if (takeReviewFilter === 'marked' && !isMarked) { return; }
      if (takeReviewFilter !== 'marked' && takeReviewFilter !== kind) { return; }
    }
    html += '<div class="take-review-item">' +
      '<p class="take-review-q">' + esc((i + 1) + '. ' + (q.question || '')) + '</p>' +
      // v1.0.22: image system — question figure, option thumbnails on the
      // answer lines, and the solution figure (all tap-to-zoom via the
      // delegated takeReview click handler below). Null for text questions.
      (q.question_image_url ? '<img class="take-review-img" src="' + esc(q.question_image_url) + '" alt="Question figure" data-img="' + esc(q.question_image_url) + '">' : '') +
      '<p class="take-review-line ' + (ok ? 'take-correct' : 'take-wrong') + '">' +
      (ok ? '✓ Correct' : (chosen === -1 ? '– Not attempted' : '✗ Wrong')) + '</p>' +
      (isMarked ? '<p class="take-review-line take-marked-tag">★ Marked for review</p>' : '') +
      '<p class="take-review-line">Your answer: ' + esc(chosen === -1 ? 'Not answered' : (letters[chosen] + '. ' + ((q.options || [])[chosen] || ''))) + ((chosen !== -1 && q.option_image_urls && q.option_image_urls[chosen]) ? ' <img class="take-review-optimg" src="' + esc(q.option_image_urls[chosen]) + '" alt="Your answer figure" data-img="' + esc(q.option_image_urls[chosen]) + '">' : '') + '</p>' +
      '<p class="take-review-line">Correct answer: ' + esc(correct === -1 ? '—' : (letters[correct] + '. ' + ((q.options || [])[correct] || ''))) + ((correct !== -1 && q.option_image_urls && q.option_image_urls[correct]) ? ' <img class="take-review-optimg" src="' + esc(q.option_image_urls[correct]) + '" alt="Correct answer figure" data-img="' + esc(q.option_image_urls[correct]) + '">' : '') + '</p>' +
      (q.explanation ? '<p class="take-review-line take-explain">' + esc(q.explanation) + '</p>' : '') +
      (q.solution_image_url ? '<img class="take-review-img" src="' + esc(q.solution_image_url) + '" alt="Solution figure" data-img="' + esc(q.solution_image_url) + '">' : '') +
      '</div>';
  });
  return html || '<p class="muted">No questions in this filter.</p>';
}

function showTakeReview(filter) {
  takeReviewFilter = filter || 'all';
  if (!takeReviewCache) { return; }
  $('takeReview').innerHTML = takeReviewHtml(takeReviewCache.questions, takeReviewCache.answers, takeReviewCache.marked);
  var filters = $('takeReviewFilters');
  if (filters) {
    filters.hidden = false;
    var btns = filters.querySelectorAll('[data-review-filter]');
    btns.forEach(function (b) {
      b.classList.toggle('take-filter-active', b.getAttribute('data-review-filter') === takeReviewFilter);
    });
  }
}

/* Counts from questions + answers (fallback when the server row has no
 * stored counts, e.g. an attempt saved before the detail columns existed). */
function takeCountsFromAnswers(questions, answers) {
  var correct = 0, wrong = 0, unattempted = 0;
  (questions || []).forEach(function (q, i) {
    var chosen = (answers && typeof answers[i] === 'number') ? answers[i] : -1;
    if (chosen === -1) { unattempted += 1; return; }
    if (chosen === q.answer_index) { correct += 1; } else { wrong += 1; }
  });
  return { correct: correct, wrong: wrong, unattempted: unattempted };
}

function submitTake() {
  var st = takeState;
  if (!st || st.submitted) { return; }
  st.submitted = true;
  stopTakeTimer();
  var counts = takeCountsFromAnswers(st.questions, st.answers);
  // v1.0.15: negative marking — score = correct*marks - wrong*negative.
  var score = Math.round((counts.correct * st.marksPerQ - counts.wrong * st.negativePerQ) * 100) / 100;
  if (score < 0) { score = 0; }
  var timeTakenSec = st.startedAt ? Math.max(0, Math.round((Date.now() - st.startedAt) / 1000)) : 0;
  var detail = {
    score: score,
    total: st.questions.length,
    timeTakenSec: timeTakenSec,
    correct: counts.correct,
    wrong: counts.wrong,
    unattempted: counts.unattempted,
    hideTime: (st.mode === 'practice')
  };
  $('takeSummary').innerHTML = takeSummaryHtml(detail);
  $('takeScore').textContent = 'You scored ' + score + ' out of ' + st.questions.length + '.';
  takeReviewCache = { questions: st.questions, answers: st.answers.slice(), marked: st.marked.slice() };
  showTakeReview('all');
  $('takeBody').hidden = true;
  $('takeResult').hidden = false;
  submitTakeResult(score, st.questions.length, detail);
}

/* Read-only view of a SAVED attempt (from View Results): same full summary
 * + question-by-question review, rebuilt from the saved answers. */
async function viewSavedResult(testId, attempt) {
  $('testDetail').textContent = 'Loading…';
  try {
    var data = await apiCall('/tests/questions', { testId: testId });
    var questions = (data && data.questions) || [];
    var test = (data && data.test) || {};
    if (!questions.length) { $('testDetail').textContent = 'Try again.'; return; }
    var answers = (attempt && Array.isArray(attempt.answers)) ? attempt.answers : [];
    var counts = takeCountsFromAnswers(questions, answers);
    var score = (typeof attempt.score === 'number') ? attempt.score : counts.correct;
    var total = (typeof attempt.total === 'number') ? attempt.total : questions.length;
    var when = '';
    if (attempt.finished_at) {
      var dt = new Date(attempt.finished_at);
      if (!isNaN(dt.getTime())) { when = dt.toLocaleString(); }
    }
    var detail = {
      score: score,
      total: total,
      timeTakenSec: (typeof attempt.time_taken_sec === 'number') ? attempt.time_taken_sec : 0,
      correct: (typeof attempt.correct_count === 'number') ? attempt.correct_count : counts.correct,
      wrong: (typeof attempt.wrong_count === 'number') ? attempt.wrong_count : counts.wrong,
      unattempted: (typeof attempt.unattempted_count === 'number') ? attempt.unattempted_count : counts.unattempted,
      when: when,
      // v1.0.20: a saved practice result hides the Time row too.
      hideTime: (test.kind === 'practice')
    };
    // v1.0.20: result view of a practice set goes back to Practice.
    $('takeDoneBtn').textContent = (test.kind === 'practice') ? 'Back to practice' : 'Back to tests';
    stopTakeTimer();
    takeState = null;
    $('takeTitle').textContent = test.title || 'Test';
    $('takeTimer').textContent = '';
    $('takeSummary').innerHTML = takeSummaryHtml(detail);
    $('takeScore').textContent = 'You scored ' + score + ' out of ' + total + '.';
    takeReviewCache = { questions: questions, answers: answers.slice(), marked: questions.map(function () { return false; }) };
    showTakeReview('all');
    var prevStatus = $('takeSaveStatus');
    if (prevStatus) { prevStatus.textContent = ''; }
    $('testDetail').textContent = '';
    $('takeBody').hidden = true;
    $('takeResult').hidden = false;
    showScreen('screen-take');
    pushBack({ kind: 'take', undo: exitTakeScreen });
  } catch (e) {
    $('testDetail').textContent = e.message || 'Try again.';
  }
}

$('takeOptions').addEventListener('click', function (ev) {
  // v1.0.22: image system — tapping an option image zooms it instead of
  // selecting the option (works even after a practice question locks).
  var img = ev.target.closest('[data-img]');
  if (img) { takeOpenImg(img.getAttribute('data-img')); return; }
  var b = ev.target.closest('[data-opt]');
  if (!b || !takeState || takeState.submitted) { return; }
  // v1.0.20: in practice mode a question locks after the first tap —
  // the instant result is already showing, so further taps do nothing.
  if (takeState.mode === 'practice' && takeState.answers[takeState.idx] !== -1) { return; }
  takeState.answers[takeState.idx] = parseInt(b.getAttribute('data-opt'), 10);
  takeRenderQuestion();
});

$('takePrevBtn').addEventListener('click', function () {
  if (!takeState || takeState.submitted || takeState.idx === 0) { return; }
  takeState.idx -= 1;
  takeRenderQuestion();
});

$('takeNextBtn').addEventListener('click', function () {
  if (!takeState || takeState.submitted) { return; }
  if (takeState.idx === takeState.questions.length - 1) { submitTake(); return; }
  takeState.idx += 1;
  takeRenderQuestion();
});

$('takeSubmitBtn').addEventListener('click', function () {
  submitTake();
});

/* ================= Question palette ================= */
/* Grid of numbered buttons: current question = highlighted, answered =
 * filled gradient, unattempted = plain glass. Tapping a number jumps
 * straight to that question. Re-rendered every time it opens (and while
 * open, from takeRenderQuestion), so it is always live. */
function takeRenderPalette() {
  var st = takeState;
  var grid = $('takePaletteGrid');
  if (!grid || !st) { return; }
  var answered = 0;
  var html = '';
  st.questions.forEach(function (q, i) {
    var done = (st.answers[i] !== -1);
    var marked = !!(st.marked && st.marked[i]);
    if (done) { answered += 1; }
    // v1.0.15: palette colours — green = answered, red = marked (not
    // answered), yellow = answered + marked (Vidyagram legend).
    var cls = 'take-palette-num' +
      (i === st.idx ? ' is-current' : '') +
      (done ? ' is-done' : '') +
      (marked && done ? ' is-marked-done' : '') +
      (marked && !done ? ' is-marked' : '');
    html += '<button type="button" class="' + cls + '" data-jump="' + i + '">' + (i + 1) + '</button>';
  });
  grid.innerHTML = html;
  var remaining = st.questions.length - answered;
  $('takePaletteSummary').textContent = answered + ' of ' + st.questions.length + ' answered · ' + remaining + ' remaining';
}

function openTakePalette() {
  if (!takeState || takeState.submitted) { return; }
  takeRenderPalette();
  $('takePalette').hidden = false;
  pushBack({ kind: 'palette', undo: closeTakePalette });
}

function closeTakePalette() {
  removeBackEntry('palette');
  $('takePalette').hidden = true;
}

$('takePaletteBtn').addEventListener('click', openTakePalette);
$('takePaletteCloseBtn').addEventListener('click', closeTakePalette);
$('takePalette').addEventListener('click', function (ev) {
  if (ev.target === $('takePalette')) { closeTakePalette(); }
});
$('takePaletteGrid').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-jump]');
  if (!b || !takeState || takeState.submitted) { return; }
  takeState.idx = parseInt(b.getAttribute('data-jump'), 10) || 0;
  takeRenderQuestion();
  closeTakePalette();
});

$('takeBackBtn').addEventListener('click', function () { goBackOneStep(); });
$('takeDoneBtn').addEventListener('click', function () { goBackOneStep(); });

/* v1.0.15: new test-taking controls (Vidyagram features). */
$('takeStartBtn').addEventListener('click', startTakeTest);

$('takeMarkBtn').addEventListener('click', function () {
  if (!takeState || takeState.submitted) { return; }
  takeState.marked[takeState.idx] = !takeState.marked[takeState.idx];
  takeRenderQuestion();
});

$('takeClearBtn').addEventListener('click', function () {
  if (!takeState || takeState.submitted) { return; }
  // v1.0.20: Clear is disabled in practice mode (answers lock on tap).
  if (takeState.mode === 'practice') { return; }
  takeState.answers[takeState.idx] = -1;
  takeRenderQuestion();
});

$('takeZoomInBtn').addEventListener('click', function () {
  if (!takeState) { return; }
  takeState.zoomLevel = Math.min(3, takeState.zoomLevel + 1);
  takeRenderQuestion();
});

$('takeZoomOutBtn').addEventListener('click', function () {
  if (!takeState) { return; }
  takeState.zoomLevel = Math.max(-2, takeState.zoomLevel - 1);
  takeRenderQuestion();
});

function takePause() {
  if (!takeState || takeState.submitted || takeState.paused) { return; }
  // v1.0.20: no pause in practice mode (there is no timer to freeze).
  if (takeState.mode === 'practice') { return; }
  takeState.paused = true;
  var answered = 0;
  takeState.answers.forEach(function (a) { if (a !== -1) { answered += 1; } });
  $('takePauseSummary').textContent = 'Answered: ' + answered + ' · Not answered: ' + (takeState.questions.length - answered) + ' · Time left: ' + takeFormatTime(Math.max(0, takeState.remainingSec));
  $('takePauseOverlay').hidden = false;
  pushBack({ kind: 'takepause', undo: takeResume });
}
function takeResume() {
  if (!takeState) { return; }
  takeState.paused = false;
  removeBackEntry('takepause');
  $('takePauseOverlay').hidden = true;
}
$('takePauseBtn').addEventListener('click', takePause);
$('takeResumeBtn').addEventListener('click', takeResume);

/* v1.0.22: image system — fullscreen image overlay. Tapping a question,
 * option or review image opens it; Close (or the backdrop) closes it.
 * The back stack treats it like the pause overlay (pushBack/removeBackEntry). */
function takeOpenImg(src) {
  if (!src) { return; }
  var full = $('takeImgFull');
  if (full) { full.src = src; }
  var ov = $('takeImgOverlay');
  if (ov) { ov.hidden = false; }
  pushBack({ kind: 'takeimg', undo: takeCloseImg });
}
function takeCloseImg() {
  var ov = $('takeImgOverlay');
  if (ov) { ov.hidden = true; }
  removeBackEntry('takeimg');
}
$('takeImgCloseBtn').addEventListener('click', takeCloseImg);
$('takeImgOverlay').addEventListener('click', function (ev) {
  if (ev.target === this) { takeCloseImg(); }
});
$('takeQImage').addEventListener('click', function () { takeOpenImg(this.src); });
$('takeQImageError').addEventListener('click', function () {
  var im = $('takeQImage');
  if (im && im.getAttribute('src')) { im.src = im.getAttribute('src'); }
});
$('takeReview').addEventListener('click', function (ev) {
  var img = ev.target.closest('[data-img]');
  if (img) { takeOpenImg(img.getAttribute('data-img')); }
});

$('takeReviewFilters').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-review-filter]');
  if (!b) { return; }
  showTakeReview(b.getAttribute('data-review-filter'));
});

/* ================= Hidden chat entry + real chat ================= */
/* The chat code is the pairing key, so it must survive app updates.
 * It lives in the native encrypted store, NOT in
 * WebView localStorage. localStorage is kept only as a fallback, and a
 * code found there is migrated to the native store on first read. */
var CHAT_CODE_KEY = 'ms_chat_code';
var LONG_PRESS_MS = 3000;
var longPressTimer = null;

function chatPlugin() {
  return capPlugin('MsAccess');
}

async function getStoredChatCode() {
  var plugin = chatPlugin();
  if (plugin && plugin.getChatCode) {
    try {
      var r = await plugin.getChatCode();
      if (r && r.code) { return r.code; }
    } catch (e) {}
  }
  var local = null;
  try { local = window.localStorage.getItem(CHAT_CODE_KEY); } catch (e) {}
  if (local && plugin && plugin.setChatCode) {
    try { await plugin.setChatCode({ code: local }); } catch (e) {}
  }
  return local;
}

async function setStoredChatCode(code) {
  var plugin = chatPlugin();
  if (plugin && plugin.setChatCode) {
    try { await plugin.setChatCode({ code: code }); } catch (e) {}
  }
  try { window.localStorage.setItem(CHAT_CODE_KEY, code); } catch (e) {}
}

async function openChatLock() {
  stopChat();
  var hasCode = await getStoredChatCode();
  $('chatLockError').hidden = true;
  $('chatLockStatus').textContent = '';
  $('chatCodeInput').value = '';
  $('chatCodeConfirm').value = '';
  if (hasCode) {
    $('chatLockTitle').textContent = 'Enter chat code';
    $('chatCodeConfirmWrap').hidden = true;
    $('chatLockBtn').textContent = 'Open chat';
  } else {
    $('chatLockTitle').textContent = 'Set a chat code';
    $('chatCodeConfirmWrap').hidden = false;
    $('chatLockBtn').textContent = 'Set code';
  }
  showScreen('screen-chat-lock');
}

function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

function armLongPress() {
  cancelLongPress();
  longPressTimer = setTimeout(function () {
    longPressTimer = null;
    openChatLock();
  }, LONG_PRESS_MS);
}

(function bindLogoLongPress() {
  var logo = $('appLogo');
  logo.addEventListener('touchstart', armLongPress, { passive: true });
  logo.addEventListener('touchend', cancelLongPress, { passive: true });
  logo.addEventListener('touchmove', cancelLongPress, { passive: true });
  logo.addEventListener('touchcancel', cancelLongPress, { passive: true });
  logo.addEventListener('mousedown', armLongPress);
  logo.addEventListener('mouseup', cancelLongPress);
  logo.addEventListener('mouseleave', cancelLongPress);
  logo.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
})();

$('chatLockBtn').addEventListener('click', async function () {
  var code = ($('chatCodeInput').value || '').trim();
  if (!code) { return; }
  var btn = $('chatLockBtn');
  btn.disabled = true;
  $('chatLockStatus').textContent = '';
  try {
    var stored = await getStoredChatCode();
    if (!stored) {
      var confirmCode = ($('chatCodeConfirm').value || '').trim();
      if (code !== confirmCode) {
        $('chatLockError').hidden = false;
        $('chatLockCard').classList.remove('shake');
        void $('chatLockCard').offsetWidth;
        $('chatLockCard').classList.add('shake');
        return;
      }
      await setStoredChatCode(code);
    } else if (code !== stored) {
      $('chatLockError').hidden = false;
      $('chatLockCard').classList.remove('shake');
      void $('chatLockCard').offsetWidth;
      $('chatLockCard').classList.add('shake');
      return;
    }
    /* Code is correct — join the room on the server before opening it.
     * A first-time code creates the room; the same code on a second
     * device joins the same room (max 2). */
    $('chatLockStatus').textContent = 'Joining…';
    var joined = await joinChat(code);
    if (!joined.ok) {
      $('chatLockStatus').textContent =
        (joined.reason === 'full') ? 'This code is already in use.' : 'Try again.';
      return;
    }
    showScreen('screen-chat');
    pushBack({ kind: 'chat', undo: function () { stopChat(); showScreen('screen-notes'); } });
    startChat();
  } catch (e) {
    /* apiCall already locks out on an auth failure; anything else is
     * a transient failure while still on the lock screen. */
    $('chatLockStatus').textContent = 'Try again.';
  } finally {
    btn.disabled = false;
  }
});
$('chatCodeInput').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { $('chatLockBtn').click(); }
});
$('chatLockBackBtn').addEventListener('click', function () { showScreen('screen-notes'); });

/* ================= Hidden chat ================= */
/* Text chat only. Polls /chat/messages every 2s while open, and fetches
 * immediately when the chat opens (no waiting for the first tick). */
var chatState = {
  code: null,
  roomId: null,
  myDeviceId: '',
  messages: [],   // [{id, room_id, sender_device, body, reply_to, created_at}]
  byId: {},
  members: [],
  presence: [],
  pollTimer: null,
  pollBusy: false,
  markReadBusy: false, // FIX 6 (v1.0.12): throttles /chat/mark-read to once per poll cycle
  _otherReadAt: null,  // FIX 6 (v1.0.12): last seen other-member last_read_at (for tick re-render)
  renderedMsgIds: {},  // v1.0.13: ids already rendered (so a re-render does not re-animate them)
  renderedOnce: false, // v1.0.13: true after the first render of this chat open
  sending: false,
  replyTo: null,
  menuMsgId: null
};

/* ================= Chat push notifications (FCM) ================= */
/* Hidden-chat push via @capacitor/push-notifications (FCM, Firebase
 * project weather-c0a4e — the com.kiara.msstudy client in
 * google-services.json). The token is sent to the server on join (and
 * again whenever it refreshes), so the server can push a GENERIC
 * "New message" alert to the OTHER member when the app is closed.
 * Everything here is best-effort and silent: if push is unavailable
 * or the user denies the permission, the chat keeps working exactly
 * as today by polling every 2s while open. No error is ever shown. */
var pushState = { token: null, listenersAdded: false };
var PUSH_TOKEN_KEY = 'ms_push_token';

function pushPlugin() { return capPlugin('PushNotifications'); }

/* Re-send the current token to the server for the open room (if any).
 * Called when a token arrives/refreshes and after joining a chat. */
async function sendPushTokenToServer() {
  if (!pushState.token || !chatState.code) { return; }
  try {
    await apiCall('/chat/push-token', { code: chatState.code, pushToken: pushState.token });
  } catch (e) { /* silent: re-sent on the next join / token refresh */ }
}

/* Ask for the notification permission (only prompts when the status is
 * 'prompt' — a denied user is never re-prompted) and register for FCM.
 * Skipped when we already have a token; the 'registration' listener
 * below re-fires on token refresh, so a rotated token is re-sent. */
async function ensurePushRegistered() {
  var plugin = pushPlugin();
  if (!plugin || pushState.token) { return; }
  try {
    var perm = await plugin.checkPermissions();
    if (perm && perm.receive === 'prompt') { perm = await plugin.requestPermissions(); }
    if (perm && perm.receive === 'denied') { return; }
  } catch (e) { /* pre-Android 13 / no prompt: carry on to register */ }
  try { await plugin.register(); } catch (e) { /* silent: polling still works */ }
}

async function initPushNotifications() {
  var plugin = pushPlugin();
  if (!plugin) { return; }
  if (!pushState.listenersAdded) {
    pushState.listenersAdded = true;
    try {
      plugin.addListener('registration', function (t) {
        if (t && t.value) {
          pushState.token = t.value;
          try { window.localStorage.setItem(PUSH_TOKEN_KEY, t.value); } catch (e) {}
          sendPushTokenToServer();
        }
      });
      plugin.addListener('registrationError', function () { /* silent */ });
      plugin.addListener('pushNotificationReceived', function () {
        /* App is open: pull the new message now instead of waiting
         * for the next 2s poll tick. */
        if (chatState.code) { loadChatMessages(false); }
      });
      plugin.addListener('pushNotificationActionPerformed', function () {
        /* Tapping the notification opens the app; if signed in, go
         * straight to the chat lock screen. */
        openChatLock();
      });
    } catch (e) { /* listeners unavailable: polling still works */ }
    /* A token from an earlier run: the 'registration' event may not
     * fire again for an unchanged token, so restore + re-send it. */
    try {
      var saved = window.localStorage.getItem(PUSH_TOKEN_KEY);
      if (saved) { pushState.token = saved; }
    } catch (e) {}
  }
  await ensurePushRegistered();
}

/* Join (or create) the room for this code. The device id IS the member
 * identity, so make sure it is populated first. */
async function joinChat(code) {
  var info = await getDeviceInfo();
  window.MsStudySession.deviceId = info.deviceId;
  chatState.myDeviceId = info.deviceId;
  /* Fallback registration: if the boot-time attempt had no token yet
   * (permission granted later, first run), try again now — the token
   * is sent with this join when available, and re-sent via
   * /chat/push-token when the 'registration' event fires. */
  ensurePushRegistered();
  var data = await apiCall('/chat/join', { code: code, pushToken: pushState.token || undefined });
  if (!data || data.result === 'full') { return { ok: false, reason: 'full' }; }
  if (!data || data.result !== 'ok') { return { ok: false, reason: 'retry' }; }
  chatState.code = code;
  chatState.roomId = data.roomId || null;
  chatState.members = data.members || [];
  chatState.presence = data.presence || [];
  /* The token may have arrived while the join was in flight (the
   * 'registration' listener skips sending until a room is open). */
  sendPushTokenToServer();
  return { ok: true };
}

function stopChatPolling() {
  if (chatState.pollTimer) { clearInterval(chatState.pollTimer); chatState.pollTimer = null; }
}

function stopChat() {
  stopChatPolling();
  chatState.code = null;
  chatState.roomId = null;
  chatState.messages = [];
  chatState.byId = {};
  chatState.members = [];
  chatState.presence = [];
  chatState.replyTo = null;
  chatState.menuMsgId = null;
  chatState.sending = false;
  chatState.pollBusy = false;
  chatState.renderedMsgIds = {};
  chatState.renderedOnce = false;
}

function startChat() {
  chatState.messages = [];
  chatState.byId = {};
  chatState.replyTo = null;
  chatState.sending = false;
  chatState.pollBusy = false;
  hideReplyBar();
  $('chatStatus').textContent = '';
  $('chatInput').value = '';
  $('chatMenu').hidden = true;
  renderChatMessages('always');
  renderChatPresence();
  loadChatMessages(true);
  stopChatPolling();
  chatState.pollTimer = setInterval(function () { loadChatMessages(false); }, 2000);
  // v1.0.13 FIX (notification bug, user video 2026-11-24 22:54 IST):
  // the app never asked for notification permission, so no alert could
  // ever arrive. The boot-time request evidently never showed (silent
  // failure). Ask again now, while the user is looking at the chat —
  // and show the permission state under the chat, tappable to enable.
  ensurePushRegistered();
  updateChatNotifStatus();
}

/* v1.0.13: show the notification permission state under the chat so
 * the user can SEE it (and tap to enable). 'prompt' = not asked yet,
 * 'granted' = on, 'denied' = blocked — enable it in Settings. */
async function updateChatNotifStatus() {
  var el = $('chatNotifStatus');
  if (!el) { return; }
  var plugin = pushPlugin();
  if (!plugin) { el.textContent = 'Notifications: unavailable on this device.'; return; }
  var state = 'prompt';
  try {
    var perm = await plugin.checkPermissions();
    if (perm && perm.receive) { state = perm.receive; }
  } catch (e) { /* fall through: treat as prompt */ }
  if (state === 'granted') {
    el.textContent = 'Notifications: on.';
  } else if (state === 'denied') {
    el.textContent = 'Notifications: off — allow them in Settings to get message alerts.';
  } else {
    el.textContent = 'Notifications: off — tap here to turn on message alerts.';
  }
  el.setAttribute('data-notif-state', state);
}

function formatChatTime(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) { return ''; }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatLastSeen(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) { return 'Last seen recently'; }
  var now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return 'Last seen ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  return 'Last seen ' + d.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function chatListAtBottom() {
  var list = $('chatList');
  return (list.scrollHeight - list.scrollTop - list.clientHeight) < 60;
}

function renderChatMessages(scroll) {
  var list = $('chatList');
  var atBottom = chatListAtBottom();
  if (!chatState.messages.length) {
    list.innerHTML = '<p class="muted small" style="text-align:center;padding-top:24px;">No messages yet.</p>';
    return;
  }
  var html = '';
  // v1.0.13 FIX (pop-up bug, user video 2026-11-24 22:54 IST): the list
  // is fully rebuilt (innerHTML) on every poll, and the CSS animated
  // the LAST message every time — so the latest bubble kept popping
  // up again and again. Now only a message that is genuinely NEW in
  // this render gets the entry animation (class msg-new); a message
  // that was already rendered never animates again. The first render
  // of a chat open animates nothing (opening the chat must not pop
  // every old message).
  var firstRender = !chatState.renderedOnce;
  chatState.messages.forEach(function (m) {
    var mine = (m.sender_device === chatState.myDeviceId);
    var isNew = !firstRender && !chatState.renderedMsgIds[m.id];
    var quote = '';
    if (m.reply_to && chatState.byId[m.reply_to]) {
      quote = '<div class="msg-quote">' + esc(chatState.byId[m.reply_to].body || '') + '</div>';
    }
    // FIX 6 (v1.0.12): read receipt on MY messages only — double tick
    // when the other member's last_read_at is at or after this message's
    // time, otherwise a single tick. No ticks on their messages.
    var tick = '';
    if (mine) {
      var otherReadAt = chatOtherLastReadAt();
      var seen = otherReadAt && (new Date(otherReadAt).getTime() >= new Date(m.created_at).getTime());
      tick = '<span class="msg-tick' + (seen ? ' seen' : '') + '">' + (seen ? '✓✓' : '✓') + '</span>';
    }
    html += '<div class="msg ' + (mine ? 'msg-mine' : 'msg-theirs') + (isNew ? ' msg-new' : '') + '" data-msg="' + esc(m.id) + '">' +
      quote + '<div class="msg-body">' + esc(m.body || '') + '</div>' +
      '<span class="msg-time">' + esc(formatChatTime(m.created_at)) + tick + '</span></div>';
  });
  list.innerHTML = html;
  // Remember what was just rendered, so the next re-render (poll tick
  // or read-receipt change) does not re-animate anything.
  chatState.renderedMsgIds = {};
  chatState.messages.forEach(function (m) { chatState.renderedMsgIds[m.id] = true; });
  chatState.renderedOnce = true;
  if (scroll === 'always' || atBottom) { list.scrollTop = list.scrollHeight; }
}

function renderChatPresence() {
  var dot = $('chatPresenceDot');
  var text = $('chatPresenceText');
  var other = null;
  (chatState.members || []).forEach(function (m) {
    if (m !== chatState.myDeviceId) { other = m; }
  });
  if (!other) {
    dot.classList.remove('on');
    text.textContent = 'Waiting for the other person.';
    return;
  }
  var p = null;
  (chatState.presence || []).forEach(function (x) {
    if (x.deviceId === other) { p = x; }
  });
  if (p && p.online) {
    dot.classList.add('on');
    text.textContent = 'Online';
  } else {
    dot.classList.remove('on');
    text.textContent = (p && p.lastSeen) ? formatLastSeen(p.lastSeen) : 'Offline';
  }
}

/* FIX 6 (v1.0.12): the OTHER member's last_read_at, from the presence
 * the server already returns with /chat/messages. */
function chatOtherLastReadAt() {
  var other = null;
  (chatState.members || []).forEach(function (m) {
    if (m !== chatState.myDeviceId) { other = m; }
  });
  if (!other) { return null; }
  var found = null;
  (chatState.presence || []).forEach(function (x) {
    if (x.deviceId === other) { found = x; }
  });
  return (found && found.lastReadAt) || null;
}

/* FIX 6 (v1.0.12): tell the server I have read the chat, so the other side
 * sees double ticks. Throttled to once per poll cycle; a failure is silent
 * and must never break the chat. */
async function markChatRead() {
  if (!chatState.code || chatState.markReadBusy) { return; }
  chatState.markReadBusy = true;
  try {
    await apiCall('/chat/mark-read', { code: chatState.code });
  } catch (e) { /* silent */ } finally {
    chatState.markReadBusy = false;
  }
}

async function loadChatMessages(initial) {
  if (!chatState.code || chatState.pollBusy) { return; }
  chatState.pollBusy = true;
  try {
    var since = null;
    if (!initial && chatState.messages.length) {
      since = chatState.messages[chatState.messages.length - 1].created_at;
    }
    var data = await apiCall('/chat/messages', { code: chatState.code, since: since });
    if (data && data.result === 'not-joined') {
      stopChat();
      $('chatLockStatus').textContent = 'Open the chat again.';
      openChatLock();
      return;
    }
    if (data && data.result === 'ok') {
      if (data.members) { chatState.members = data.members; }
      if (data.presence) { chatState.presence = data.presence; }
      var added = 0;
      (data.messages || []).forEach(function (m) {
        if (m && m.id && !chatState.byId[m.id]) {
          chatState.byId[m.id] = m;
          chatState.messages.push(m);
          added++;
        }
      });
      if (added) {
        chatState.messages.sort(function (a, b) {
          return new Date(a.created_at) - new Date(b.created_at);
        });
        renderChatMessages(initial ? 'always' : true);
      }
      renderChatPresence();
      // FIX 6 (v1.0.12): re-render the ticks when the other member's read
      // time changes, even if no new message arrived (renderChatMessages
      // only runs on new messages above, so ticks would otherwise stay
      // single until the next message).
      var curRead = chatOtherLastReadAt();
      if (curRead !== chatState._otherReadAt) {
        chatState._otherReadAt = curRead;
        renderChatMessages();
      }
      // FIX 6 (v1.0.12): mark the chat as read when the other person has
      // sent messages — once per poll cycle, silent on failure.
      // v1.0.13 FIX (auto-seen bug, user video 2026-11-24 22:54 IST): the
      // 2s poll kept running while the app sat in the background (in
      // recents), so it marked messages READ even though the user had
      // never looked at them — the other side saw ✓✓ for a message
      // nobody read. Only mark read when the user is ACTUALLY looking:
      // the app must be in the foreground AND the chat screen must be
      // the active screen.
      var hasOtherMsg = false;
      (chatState.messages || []).forEach(function (m) {
        if (m.sender_device !== chatState.myDeviceId) { hasOtherMsg = true; }
      });
      if (hasOtherMsg && document.visibilityState === 'visible' && currentScreenId === 'screen-chat') { markChatRead(); }
    }
  } catch (e) {
    /* Transient poll failure — keep polling. apiCall already locks
     * out on an auth failure. */
  } finally {
    chatState.pollBusy = false;
  }
}

async function sendChatMessage() {
  if (!chatState.code || chatState.sending) { return; }
  var text = ($('chatInput').value || '').trim();
  if (!text) { return; }
  text = text.slice(0, 2000);
  var btn = $('chatSendBtn');
  chatState.sending = true;
  btn.disabled = true;
  $('chatStatus').textContent = '';
  try {
    var data = await apiCall('/chat/send', { code: chatState.code, text: text, replyTo: chatState.replyTo });
    if (data && data.result === 'not-joined') {
      stopChat();
      $('chatLockStatus').textContent = 'Open the chat again.';
      openChatLock();
      return;
    }
    if (data && data.result === 'ok' && data.message) {
      var m = data.message;
      if (!chatState.byId[m.id]) {
        chatState.byId[m.id] = m;
        chatState.messages.push(m);
        chatState.messages.sort(function (a, b) {
          return new Date(a.created_at) - new Date(b.created_at);
        });
      }
      $('chatInput').value = '';
      hideReplyBar();
      renderChatMessages('always');
      // v1.0.13 FIX (keyboard bug, user video 2026-11-24 22:54 IST):
      // tapping Send moved focus to the button and the keyboard closed,
      // so she had to tap the input again for every message. Keep the
      // keyboard open — refocus the input after sending.
      $('chatInput').focus();
    } else {
      $('chatStatus').textContent = 'Try again.';
    }
  } catch (e) {
    $('chatStatus').textContent = e.message || 'Try again.';
  } finally {
    chatState.sending = false;
    btn.disabled = false;
  }
}

function showReplyBar(msgId) {
  var m = chatState.byId[msgId];
  if (!m) { return; }
  chatState.replyTo = msgId;
  $('chatReplyText').textContent = 'Replying to: ' + (m.body || '').slice(0, 40);
  $('chatReplyBar').hidden = false;
  $('chatInput').focus();
}

function hideReplyBar() {
  chatState.replyTo = null;
  $('chatReplyBar').hidden = true;
}

async function deleteChatMessage(msgId) {
  if (!chatState.code || !msgId) { return; }
  try {
    var data = await apiCall('/chat/delete', { code: chatState.code, messageId: msgId });
    if (data && data.result === 'not-joined') {
      stopChat();
      $('chatLockStatus').textContent = 'Open the chat again.';
      openChatLock();
      return;
    }
    if (data && data.result === 'ok') {
      delete chatState.byId[msgId];
      chatState.messages = chatState.messages.filter(function (m) { return m.id !== msgId; });
      if (chatState.replyTo === msgId) { hideReplyBar(); }
      renderChatMessages();
    } else {
      $('chatStatus').textContent = 'Try again.';
    }
  } catch (e) {
    $('chatStatus').textContent = e.message || 'Try again.';
  }
}

function openChatMsgMenu(msgId) {
  chatState.menuMsgId = msgId;
  $('chatMsgMenu').hidden = false;
  pushBack({ kind: 'menu', undo: closeChatMsgMenu });
}

function closeChatMsgMenu() {
  removeBackEntry('menu');
  chatState.menuMsgId = null;
  $('chatMsgMenu').hidden = true;
}

/* Composer */
$('chatSendBtn').addEventListener('click', sendChatMessage);
// v1.0.13: tap the notification status line to enable notifications.
$('chatNotifStatus').addEventListener('click', async function () {
  await ensurePushRegistered();
  updateChatNotifStatus();
});
// v1.0.14: the row 3-dot menu option toggles Mark as complete.
$('rowMenuComplete').addEventListener('click', async function () {
  if (!rowMenuTarget) { return; }
  var t = rowMenuTarget;
  closeRowMenu();
  await toggleComplete(t.type, t.id);
});
// Tapping anywhere outside the row menu closes it.
document.addEventListener('click', function (ev) {
  var m = $('rowMenu');
  if (m && !m.hidden && !ev.target.closest('#rowMenu') && !ev.target.closest('[data-dot-type]')) { closeRowMenu(); }
});
$('chatInput').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { sendChatMessage(); }
});
$('chatReplyCancel').addEventListener('click', hideReplyBar);
$('chatBackBtn').addEventListener('click', function () { goBackOneStep(); });

/* Long-press a message: Reply / Delete menu (touch + mouse). */
var chatLpTimer = null;
function cancelChatLongPress() {
  if (chatLpTimer) { clearTimeout(chatLpTimer); chatLpTimer = null; }
}
function armChatLongPress(msgId) {
  cancelChatLongPress();
  chatLpTimer = setTimeout(function () {
    chatLpTimer = null;
    openChatMsgMenu(msgId);
  }, 500);
}
$('chatList').addEventListener('touchstart', function (ev) {
  var b = ev.target.closest('[data-msg]');
  if (b) { armChatLongPress(b.getAttribute('data-msg')); }
}, { passive: true });
$('chatList').addEventListener('touchend', cancelChatLongPress, { passive: true });
$('chatList').addEventListener('touchmove', cancelChatLongPress, { passive: true });
$('chatList').addEventListener('touchcancel', cancelChatLongPress, { passive: true });
$('chatList').addEventListener('mousedown', function (ev) {
  var b = ev.target.closest('[data-msg]');
  if (b) { armChatLongPress(b.getAttribute('data-msg')); }
});
$('chatList').addEventListener('mouseup', cancelChatLongPress);
$('chatList').addEventListener('mouseleave', cancelChatLongPress);
$('chatList').addEventListener('contextmenu', function (ev) {
  var b = ev.target.closest('[data-msg]');
  if (b) {
    ev.preventDefault();
    cancelChatLongPress();
    openChatMsgMenu(b.getAttribute('data-msg'));
  }
});

$('chatMsgReplyBtn').addEventListener('click', function () {
  var id = chatState.menuMsgId;
  closeChatMsgMenu();
  if (id) { showReplyBar(id); }
});
$('chatMsgDeleteBtn').addEventListener('click', function () {
  var id = chatState.menuMsgId;
  closeChatMsgMenu();
  if (id) { deleteChatMessage(id); }
});
$('chatMsgMenuCancel').addEventListener('click', closeChatMsgMenu);
$('chatMsgMenu').addEventListener('click', function (ev) {
  if (ev.target === $('chatMsgMenu')) { closeChatMsgMenu(); }
});

/* 3-dot menu: Change code */
$('chatMenuBtn').addEventListener('click', function (ev) {
  ev.stopPropagation();
  $('chatMenu').hidden = !$('chatMenu').hidden;
});
document.addEventListener('click', function (ev) {
  var menu = $('chatMenu');
  if (menu && !menu.hidden && !ev.target.closest('#chatMenu') && !ev.target.closest('#chatMenuBtn')) {
    menu.hidden = true;
  }
});
$('chatChangeCodeBtn').addEventListener('click', async function () {
  $('chatMenu').hidden = true;
  if (!chatState.code) { return; }
  if (!window.confirm('Change code? This deletes the chat for both people.')) { return; }
  try {
    await apiCall('/chat/change-code', { code: chatState.code });
  } catch (e) {
    $('chatStatus').textContent = e.message || 'Try again.';
    return;
  }
  var plugin = chatPlugin();
  if (plugin && plugin.clearChatCode) { try { await plugin.clearChatCode(); } catch (e) {} }
  try { window.localStorage.removeItem(CHAT_CODE_KEY); } catch (e) {}
  stopChat();
  openChatLock();
});

/* ================= In-app update ================= */
async function checkForUpdate() {
  try {
    var res = await fetch(UPDATE_URL, { cache: 'no-store' });
    if (!res.ok) { return; }
    var data = await res.json();
    if (data && data.versionCode > CURRENT_VERSION_CODE) {
      pendingUpdate = data;
      $('updateChangelog').textContent = data.changelog || ('Version ' + data.version + ' is available.');
      $('updateDialog').hidden = false;
    }
  } catch (e) { /* no update check offline — stay on current version */ }
}

$('updateLaterBtn').addEventListener('click', function () {
  $('updateDialog').hidden = true;
  pendingUpdate = null;
});

$('updateBtn').addEventListener('click', async function () {
  if (!pendingUpdate || !pendingUpdate.apkUrl) { return; }
  var btn = $('updateBtn');
  btn.disabled = true;
  $('updateStatus').textContent = 'Downloading update…';
  try {
    var installer = capPlugin('ApkInstaller');
    var fs = capPlugin('Filesystem');
    if (!installer || !installer.installApk || !fs) {
      throw new Error('Installer unavailable.');
    }
    var res = await fetch(pendingUpdate.apkUrl);
    if (!res.ok) { throw new Error('Download failed.'); }
    var buf = await res.arrayBuffer();
    var bytes = new Uint8Array(buf);
    var binary = '';
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    var base64 = btoa(binary);
    var fileName = 'ms-study-update-v' + pendingUpdate.versionCode + '.apk';
    await fs.writeFile({
      path: fileName,
      data: base64,
      directory: 'CACHE',
      recursive: true
    });
    $('updateStatus').textContent = 'Opening installer…';
    await installer.installApk({ fileName: fileName });
    $('updateDialog').hidden = true;
  } catch (e) {
    $('updateStatus').textContent = 'Update failed.';
  } finally {
    btn.disabled = false;
  }
});

/* ================= Boot (v1.0.23: no password) =================
 * No saved login to restore — the app opens straight to Notes.
 * The device id is generated lazily by getDeviceInfo() on the first
 * server call (see apiCall). */
enterApp();
/* Push notifications for the hidden chat (best-effort, silent if
 * unavailable — the chat keeps polling while open either way). */
initPushNotifications();
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar) {
  try {
    window.Capacitor.Plugins.StatusBar.setStyle({ style: 'LIGHT' });
    window.Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#f4f6f9' });
  } catch (e) { /* non-fatal on web */ }
}
