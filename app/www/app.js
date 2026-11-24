/* MS Study — app shell (Capacitor 6, single-page app).
 *
 *   - Native MsAccess plugin (android/.../MsAccessPlugin.java) does the
 *     /validate POST and holds the encrypted session, exactly like
 *     PW's PwAccessPlugin + PwSessionStore (AES-256/GCM key in the
 *     Android Keystore, ciphertext only in SharedPreferences).
 *   - Difference from PW: the device identity is a UUID generated ONCE
 *     and stored AES-encrypted (MsSessionStore), NOT the Android ID;
 *     and there is NO expiry anywhere — a valid password stays valid
 *     until the server says "kicked"/"incorrect".
 *   - Plain-browser fallback (headless testing only): direct fetch POST
 *     with a UUID kept in localStorage. On a real device the plugin
 *     always exists, so the fallback never runs there.
 *
 * SECURITY RULES (do not weaken):
 *   - The entered password lives in MEMORY (MsStudySession.password, a JS
 *     variable) AND encrypted natively (MsSessionStore, AES-256/GCM key
 *     in the Android Keystore) since v1.0.3, so a fresh launch — including
 *     after an app update — silently revalidates and skips the lock
 *     screen. It is NEVER written to localStorage, sessionStorage, or
 *     any file in plain text. The stored password is cleared on logout,
 *     kick, or "incorrect".
 *   - Within one run, revalidation uses the in-memory password every
 *     15s + on resume.
 *   - NO download option for any content anywhere in the UI.
 *   - NO Google Sign-In / Drive key in the client (see drive.js).
 */

'use strict';

/* ================= Config ================= */
var SERVER_URL = 'https://byulsopangzovpwywgzf.supabase.co/functions/v1/ms-api';
var UPDATE_URL = 'https://mohitsaini921837-bot.github.io/ms-study-app/update/version.json';
var CURRENT_VERSION_CODE = 9;

/* Exposed read-only for drive.js (it reads SERVER_URL from here). */
window.MsStudyConfig = { SERVER_URL: SERVER_URL, UPDATE_URL: UPDATE_URL, CURRENT_VERSION_CODE: CURRENT_VERSION_CODE };

/* In-memory session ONLY. Never persisted. */
window.MsStudySession = { password: '', deviceId: '', deviceLabel: 'MS Study App', role: '' };

var authed = false;
var revalTimer = null;
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
var MAIN_SCREENS = ['screen-home', 'screen-notes', 'screen-tests', 'screen-practice', 'screen-classes', 'screen-admin'];
var ALL_SCREENS = MAIN_SCREENS.concat(['screen-lock', 'screen-chat-lock', 'screen-chat', 'screen-take']);

function showScreen(id) {
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
  // Lazy-load the screen's data when it is shown.
  if (id === 'screen-notes') { notesBrowser.load(); }
  else if (id === 'screen-practice') { practiceBrowser.load(); }
  else if (id === 'screen-classes') { classesBrowser.load(); }
  else if (id === 'screen-tests') { refreshTestsScreen(); }
}

document.querySelectorAll('.nav-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    if (!authed) { return; }
    showScreen(btn.getAttribute('data-screen'));
  }, { passive: true });
});

/* ================= Password gate ================= */
var GATE_MSGS = {
  incorrect: ['Incorrect password', 'Check and try again.'],
  kicked: ['Signed in on another device', 'Sign in again to continue.'],
  unavailable: ['Unable to connect', 'Check your connection and try again.'],
  rate_limited: ['Please wait', 'Try again shortly.'],
  empty: ['Enter your password', '']
};

function showLockError(key) {
  var err = $('lockError');
  if (key && GATE_MSGS[key]) {
    $('lockErrorTitle').textContent = GATE_MSGS[key][0];
    $('lockErrorText').textContent = GATE_MSGS[key][1];
    err.hidden = false;
  } else {
    err.hidden = true;
  }
}

function showLockChecking(on) {
  $('lockCard').hidden = on;
  $('lockChecking').hidden = !on;
  $('lockBtn').disabled = on;
}

/* One validate call. Prefers the native plugin (mirrors PW); falls back
 * to a direct fetch POST in a plain browser. Returns the server result:
 * {result: "valid"|"incorrect"|"kicked"|"unavailable"|"rate_limited", role?}
 * mode: "login" (explicit password entry, may rebind — last login wins)
 * or "revalidate" (background check, never rebinds). */
async function validatePassword(password, mode) {
  var m = (mode === 'revalidate') ? 'revalidate' : 'login';
  var info = await getDeviceInfo();
  window.MsStudySession.deviceId = info.deviceId;
  window.MsStudySession.deviceLabel = info.deviceLabel;

  var plugin = capPlugin('MsAccess');
  if (plugin && plugin.validate) {
    var r = await plugin.validate({ password: password, mode: m });
    return r || { result: 'unavailable' };
  }
  var res = await fetch(SERVER_URL + '/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ password: password, deviceId: info.deviceId, deviceLabel: info.deviceLabel, mode: m })
  });
  if (res.status === 429) { return { result: 'rate_limited' }; }
  var data = await res.json().catch(function () { return {}; });
  return data || { result: 'unavailable' };
}

async function submitLogin() {
  var pw = ($('lockPassword').value || '').trim();
  if (!pw) { showLockError('empty'); return; }
  showLockError(null);
  showLockChecking(true);
  try {
    var r = await validatePassword(pw);
    if (r.result === 'valid') {
      // Password -> memory, and encrypted natively (plugin saves it),
      // so the next launch stays signed in, even after an update.
      window.MsStudySession.password = pw;
      window.MsStudySession.role = r.role || 'user';
      enterApp();
    } else if (r.result === 'kicked') {
      showLockChecking(false);
      showToast('Signed in on another device.');
      showLockError('kicked');
    } else if (r.result && GATE_MSGS[r.result]) {
      showLockChecking(false);
      showLockError(r.result);
    } else {
      showLockChecking(false);
      showLockError('unavailable');
    }
  } catch (e) {
    showLockChecking(false);
    showLockError('unavailable');
  }
}

function enterApp() {
  authed = true;
  showLockChecking(false);
  $('lockPassword').value = '';
  $('activeChip').hidden = false;
  $('adminBtn').hidden = (window.MsStudySession.role !== 'admin');
  showScreen('screen-home');
  startRevalidation();
  checkForUpdate();
}

function lockout(reason) {
  authed = false;
  window.MsStudySession.password = '';
  window.MsStudySession.role = '';
  stopRevalidation();
  stopChat();
  $('activeChip').hidden = true;
  $('adminBtn').hidden = true;
  var plugin = capPlugin('MsAccess');
  if (plugin && plugin.clearSession) { try { plugin.clearSession(); } catch (e) {} }
  showScreen('screen-lock');
  showLockChecking(false);
  if (reason === 'kicked') {
    showToast('Signed in on another device.');
    showLockError('kicked');
  } else if (reason === 'incorrect') {
    showLockError('incorrect');
  } else {
    showLockError(null);
  }
}
/* drive.js calls this on an auth failure from a Drive request. */
window.MsStudyLockout = lockout;

/* Silent revalidation every 15s + on resume, with the in-memory password.
 * "kicked"/"incorrect" locks immediately; "unavailable"/"rate_limited"
 * keep the session and retry on the next cycle (mirrors PW). */
async function revalidateSilent() {
  if (!authed || !window.MsStudySession.password) { return; }
  try {
    var r;
    var plugin = capPlugin('MsAccess');
    if (plugin && plugin.revalidate) {
      // Native silent check (silent=true): "unavailable" keeps the
      // session, only a definite rejection clears it (mirrors PW).
      r = await plugin.revalidate({ password: window.MsStudySession.password, silent: true });
    } else {
      r = await validatePassword(window.MsStudySession.password, 'revalidate');
    }
    if (r.result === 'kicked') { lockout('kicked'); }
    else if (r.result === 'incorrect') { lockout('incorrect'); }
    else if (r.result === 'valid' && r.role) { window.MsStudySession.role = r.role; }
    /* unavailable / rate_limited / no_session: keep current state, retry later. */
  } catch (e) { /* transient: keep session, retry on next cycle */ }
}

function startRevalidation() {
  stopRevalidation();
  revalTimer = setInterval(revalidateSilent, 15000);
}

function stopRevalidation() {
  if (revalTimer) { clearInterval(revalTimer); revalTimer = null; }
}

$('lockBtn').addEventListener('click', submitLogin);
$('lockPassword').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { submitLogin(); }
});
$('lockPassword').addEventListener('focus', function () { showLockError(null); });

document.addEventListener('visibilitychange', function () {
  if (!document.hidden && authed) { revalidateSilent(); }
});
(function watchResume() {
  var app = capPlugin('App');
  if (app && app.addListener) {
    app.addListener('resume', function () { if (authed) { revalidateSilent(); } });
  }
})();

/* ================= API helper ================= */
/* POST JSON to the server with the in-memory session. On an auth
 * failure the user goes back to the lock screen (lockout). Other
 * failures surface as one short line: "Not allowed." / "Try again." */
async function apiCall(path, extra) {
  // Device id must always be set before any server call. The saved-login
  // path (trySavedLogin) used to skip it, so the first calls after an
  // auto-login sent an empty deviceId and the server answered
  // "incorrect" — folders/sections looked unmade and invisible.
  if (!window.MsStudySession.deviceId) {
    var dinfo = await getDeviceInfo();
    window.MsStudySession.deviceId = dinfo.deviceId;
    window.MsStudySession.deviceLabel = dinfo.deviceLabel;
  }
  var body = { password: window.MsStudySession.password, deviceId: window.MsStudySession.deviceId };
  Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
  var res = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  var data = await res.json().catch(function () { return {}; });
  if (data && data.result === 'incorrect') { lockout('incorrect'); throw new Error('Try again.'); }
  if (data && data.result === 'kicked') { lockout('kicked'); throw new Error('Try again.'); }
  if (data && data.result === 'unauthorized') { throw new Error('Not allowed.'); }
  if (data && data.result === 'unavailable') { throw new Error('Try again.'); }
  if (!res.ok) { throw new Error('Try again.'); }
  return data;
}

/* ================= Folder browser (Notes / Tests / Practice / Classes) ================= */
/* Each browser keeps its own folder + path. Folders open on tap
 * (breadcrumb to go back), sections expand to show their items,
 * items open their Drive link on tap.
 * Admin only, inside a folder: "New folder" / "New section" create row.
 * Admin only, inside an open section: Note / Practice sheet / Class
 * video upload cards — all three kinds, on every browser screen. */
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

  /* Admin-only create row, inside the CURRENT folder ("All" = top level).
   * New folder works at any level; New section needs a folder open. */
  function renderCreate() {
    var box = $(opts.create);
    if (!box) { return; }
    if (window.MsStudySession.role !== 'admin') { box.hidden = true; box.innerHTML = ''; return; }
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
      await apiCall('/folders/create', { name: name, parentId: state.folderId });
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

  /* Upload cards inside an open section — all three kinds, every screen,
   * admin only. data-section carries the section id for the upload. */
  function uploadCardsHtml(sectionId) {
    if (window.MsStudySession.role !== 'admin') { return ''; }
    var kinds = [['note', 'Note'], ['sheet', 'Practice sheet'], ['video', 'Class video']];
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

  async function loadSectionItems(sectionId, box) {
    box.innerHTML = '<p class="muted">Loading…</p>';
    box.hidden = false;
    try {
      var data = await apiCall('/items/list', { folderId: state.folderId, sectionId: sectionId });
      var items = (data && data.items) || [];
      if (opts.kind) { items = items.filter(function (it) { return it.kind === opts.kind; }); }
      var html = '';
      if (items.length === 0) { html = '<p class="muted">Empty.</p>'; }
      items.forEach(function (it) {
        html += '<button type="button" class="row-item" data-link="' + esc(it.drive_link || '') + '">' +
          esc(it.title || '') + '</button>';
      });
      html += uploadCardsHtml(sectionId);
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
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

  async function load() {
    var list = $(opts.list);
    if (!list) { return; }
    renderCrumb();
    renderCreate();
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      var fdata = await apiCall('/folders/list', { parentId: state.folderId });
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
        html += '<button type="button" class="row-item" data-folder="' + esc(f.id) + '">📁 ' + esc(f.name) + '</button>';
      });
      sections.forEach(function (s) {
        html += '<button type="button" class="row-item" data-section="' + esc(s.id) + '">▸ ' + esc(s.name) + '</button>';
        html += '<div class="section-items" id="' + opts.list + '-sec-' + esc(s.id) + '" hidden></div>';
      });
      items.forEach(function (it) {
        html += '<button type="button" class="row-item" data-link="' + esc(it.drive_link || '') + '">' +
          esc(it.title || '') + '</button>';
      });
      if (!html) { html = '<p class="muted">Empty.</p>'; }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
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
        var up = ev.target.closest('[data-up-btn]');
        if (up) { uploadIntoSection(up); return; }
        var f = ev.target.closest('[data-folder]');
        if (f) { openFolder(f.getAttribute('data-folder'), state.foldersById[f.getAttribute('data-folder')] || ''); return; }
        var s = ev.target.closest('[data-section]');
        if (s) {
          var box = $(opts.list + '-sec-' + s.getAttribute('data-section'));
          if (box) { toggleSection(s.getAttribute('data-section'), box); }
          return;
        }
        var l = ev.target.closest('[data-link]');
        if (l) {
          var link = l.getAttribute('data-link');
          if (link) { window.open(link, '_blank'); }
        }
      });
    }
  }

  bind();
  return { load: load };
}

var notesBrowser = createBrowser({ crumb: 'notesCrumb', list: 'notesList', kind: 'note', create: 'notesCreate' });
var practiceBrowser = createBrowser({ crumb: 'practiceCrumb', list: 'practiceList', kind: 'sheet', create: 'practiceCreate' });
var classesBrowser = createBrowser({ crumb: 'classesCrumb', list: 'classesList', kind: 'video', create: 'classesCreate' });
var testsBrowser = createBrowser({ crumb: 'testsCrumb', list: 'testsList', kind: null, create: 'testsCreate' });

/* ================= Tests screen: AI test form + saved tests ================= */
function refreshTestsScreen() {
  $('aiTestForm').hidden = (window.MsStudySession.role !== 'admin');
  testsBrowser.load();
  refreshSavedTests();
}

async function refreshSavedTests() {
  var list = $('savedTestsList');
  if (!list) { return; }
  list.innerHTML = '<p class="muted">Loading…</p>';
  $('testDetail').textContent = '';
  try {
    var data = await apiCall('/tests/list', {});
    var tests = (data && data.tests) || [];
    if (tests.length === 0) { list.innerHTML = '<p class="muted">No tests.</p>'; return; }
    var html = '';
    tests.forEach(function (t) {
      html += '<button type="button" class="row-item" data-test="' + esc(t.id) + '" data-title="' + esc(t.title || '') +
        '" data-q="' + (t.question_count || '') + '" data-m="' + (t.duration_min || '') + '">' +
        esc(t.title || '') + ' · ' + esc(t.question_count || '') + ' questions · ' + esc(t.duration_min || '') + ' min</button>';
    });
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = '<p class="muted">' + esc(e.message || 'Try again.') + '</p>';
  }
}

$('savedTestsList').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-test]');
  if (!b) { return; }
  openTest(b.getAttribute('data-test'));
});

$('testType').addEventListener('change', function () {
  $('testSheetWrap').hidden = ($('testType').value !== 'sheet');
});

$('testQuestions').addEventListener('input', function () {
  var n = parseInt($('testQuestions').value, 10);
  if (isFinite(n)) { $('testMinutes').value = Math.max(10, Math.min(50, n)); }
});

function clampQuestions(v) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) { n = 10; }
  n = Math.round(n / 5) * 5;
  return Math.max(10, Math.min(50, n));
}

function clampMinutes(v) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) { n = 10; }
  return Math.max(10, Math.min(50, n));
}

$('testGenerateBtn').addEventListener('click', async function () {
  var topic = ($('testTopic').value || '').trim();
  if (!topic) { $('testGenStatus').textContent = 'Enter a topic.'; return; }
  var btn = $('testGenerateBtn');
  btn.disabled = true;
  $('testGenStatus').textContent = 'Generating…';
  try {
    var type = $('testType').value;
    var data = await apiCall('/tests/generate', {
      type: type,
      topic: topic,
      subject: ($('testSubject').value || '').trim(),
      numQuestions: clampQuestions($('testQuestions').value),
      minutes: clampMinutes($('testMinutes').value),
      language: $('testLang').value,
      sheetText: (type === 'sheet') ? ($('testSheetText').value || '') : ''
    });
    if (data && data.result === 'ok') {
      $('testGenStatus').textContent = 'Test ready.';
      refreshSavedTests();
    } else {
      $('testGenStatus').textContent = 'Try again.';
    }
  } catch (e) {
    $('testGenStatus').textContent = e.message || 'Try again.';
  } finally {
    btn.disabled = false;
  }
});

/* ================= Take a test ================= */
/* One question at a time, countdown from duration_min, score computed
 * locally, full review after submit. The result is sent to the server
 * fire-and-forget — a failed submit never blocks the result screen. */
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
  el.textContent = 'Time left: ' + takeFormatTime(Math.max(0, takeState.remainingSec));
  el.classList.toggle('take-timer-low', takeState.remainingSec <= 60);
}

function takeRenderQuestion() {
  var st = takeState;
  if (!st) { return; }
  var q = st.questions[st.idx];
  $('takeProgress').textContent = 'Question ' + (st.idx + 1) + ' of ' + st.questions.length;
  $('takeQuestion').textContent = q.question || '';
  var letters = ['A', 'B', 'C', 'D'];
  var html = '';
  (q.options || []).forEach(function (opt, i) {
    html += '<button type="button" class="take-option' + (st.answers[st.idx] === i ? ' selected' : '') +
      '" data-opt="' + i + '">' + esc(letters[i] + '. ' + (opt || '')) + '</button>';
  });
  $('takeOptions').innerHTML = html;
  $('takePrevBtn').disabled = (st.idx === 0);
  var last = (st.idx === st.questions.length - 1);
  $('takeNextBtn').textContent = last ? 'Submit' : 'Next';
}

async function openTest(testId) {
  $('testDetail').textContent = 'Loading…';
  try {
    var data = await apiCall('/tests/questions', { testId: testId });
    var questions = (data && data.questions) || [];
    var test = (data && data.test) || {};
    if (!questions.length) { $('testDetail').textContent = 'Try again.'; return; }
    stopTakeTimer();
    takeState = {
      test: test,
      questions: questions,
      idx: 0,
      answers: questions.map(function () { return -1; }),
      remainingSec: Math.max(1, (parseInt(test.duration_min, 10) || 10) * 60),
      timer: null,
      submitted: false
    };
    $('takeTitle').textContent = test.title || 'Test';
    $('takeBody').hidden = false;
    $('takeResult').hidden = true;
    $('testDetail').textContent = '';
    showScreen('screen-take');
    takeRenderTimer();
    takeRenderQuestion();
    takeState.timer = setInterval(function () {
      if (!takeState || takeState.submitted) { return; }
      takeState.remainingSec -= 1;
      takeRenderTimer();
      if (takeState.remainingSec <= 0) { submitTake(); }
    }, 1000);
  } catch (e) {
    $('testDetail').textContent = e.message || 'Try again.';
  }
}

function submitTakeResult(score, total) {
  // Same body as apiCall, but a plain fetch: a failed submit must never
  // lock the user out of the result screen or show an error.
  if (!takeState) { return; }
  var payload = {
    testId: takeState.test.id,
    score: score,
    total: total,
    answers: takeState.answers.slice()
  };
  (async function () {
    try {
      if (!window.MsStudySession.deviceId) {
        var dinfo = await getDeviceInfo();
        window.MsStudySession.deviceId = dinfo.deviceId;
        window.MsStudySession.deviceLabel = dinfo.deviceLabel;
      }
      var body = { password: window.MsStudySession.password, deviceId: window.MsStudySession.deviceId };
      Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });
      await fetch(SERVER_URL + '/tests/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { /* fire-and-forget: ignore */ }
  })();
}

function submitTake() {
  var st = takeState;
  if (!st || st.submitted) { return; }
  st.submitted = true;
  stopTakeTimer();
  var letters = ['A', 'B', 'C', 'D'];
  var score = 0;
  var html = '';
  st.questions.forEach(function (q, i) {
    var chosen = st.answers[i];
    var correct = (typeof q.answer_index === 'number') ? q.answer_index : -1;
    var ok = (chosen !== -1 && chosen === correct);
    if (ok) { score += 1; }
    html += '<div class="take-review-item">' +
      '<p class="take-review-q">' + esc((i + 1) + '. ' + (q.question || '')) + '</p>' +
      '<p class="take-review-line ' + (ok ? 'take-correct' : 'take-wrong') + '">' +
      (ok ? '✓ Correct' : '✗ Wrong') + '</p>' +
      '<p class="take-review-line">Your answer: ' + esc(chosen === -1 ? 'Not answered' : (letters[chosen] + '. ' + ((q.options || [])[chosen] || ''))) + '</p>' +
      '<p class="take-review-line">Correct answer: ' + esc(correct === -1 ? '—' : (letters[correct] + '. ' + ((q.options || [])[correct] || ''))) + '</p>' +
      (q.explanation ? '<p class="take-review-line take-explain">' + esc(q.explanation) + '</p>' : '') +
      '</div>';
  });
  $('takeScore').textContent = 'You scored ' + score + ' out of ' + st.questions.length + '.';
  $('takeReview').innerHTML = html;
  $('takeBody').hidden = true;
  $('takeResult').hidden = false;
  submitTakeResult(score, st.questions.length);
}

$('takeOptions').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-opt]');
  if (!b || !takeState || takeState.submitted) { return; }
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

$('takeBackBtn').addEventListener('click', function () {
  stopTakeTimer();
  takeState = null;
  showScreen('screen-tests');
});

$('takeDoneBtn').addEventListener('click', function () {
  takeState = null;
  showScreen('screen-tests');
});

/* ================= Admin ================= */
function adminHeaders() {
  return { 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

function adminBody(extra) {
  var body = {
    adminPassword: window.MsStudySession.password,
    deviceId: window.MsStudySession.deviceId
  };
  Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
  return body;
}

async function adminPost(path, extra) {
  var res = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(adminBody(extra))
  });
  var data = await res.json().catch(function () { return {}; });
  if (data && (data.result === 'incorrect' || data.result === 'kicked')) {
    lockout(data.result);
    throw new Error('Try again.');
  }
  if (data && data.result === 'unauthorized') { throw new Error('Not allowed.'); }
  if (data && data.result === 'unavailable') { throw new Error('Try again.'); }
  if (!res.ok) { throw new Error((data && (data.error || data.message)) || 'Try again.'); }
  return data;
}

$('adminBtn').addEventListener('click', function () {
  if (window.MsStudySession.role !== 'admin') { return; }
  showScreen('screen-admin');
});
$('adminBackBtn').addEventListener('click', function () { showScreen('screen-home'); });

$('adminCreateBtn').addEventListener('click', async function () {
  var btn = $('adminCreateBtn');
  btn.disabled = true;
  try {
    var data = await adminPost('/admin/create-password', {});
    var code = data.code || data.password || '';
    if (!code) { throw new Error('Try again.'); }
    $('adminNewCodeText').textContent = code;
    $('adminCreateResult').hidden = false;
    showToast('Password created.');
  } catch (e) {
    showToast('Could not create password.');
  } finally {
    btn.disabled = false;
  }
});

$('adminCopyBtn').addEventListener('click', async function () {
  try {
    await navigator.clipboard.writeText($('adminNewCodeText').textContent);
    showToast('Copied.');
  } catch (e) { showToast('Could not copy.'); }
});

$('adminRefreshBtn').addEventListener('click', async function () {
  var btn = $('adminRefreshBtn');
  btn.disabled = true;
  try {
    var data = await adminPost('/admin/passwords', {});
    var rows = data.passwords || data.items || data || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      $('adminPasswordsBody').innerHTML = '<tr><td colspan="6" class="muted">No passwords.</td></tr>';
      return;
    }
    // Batched render: one innerHTML write for the whole table.
    var html = '';
    rows.forEach(function (row) {
      var id = row.id || row.passwordId || '';
      var active = (row.active !== false);
      html += '<tr><td>' + esc(row.role || 'user') + '</td><td>' + esc(row.deviceId || row.device || '—') +
        '</td><td>' + esc(row.deviceLabel || row.label || '—') + '</td><td>' + esc(row.lastUsed || row.last_used || '—') +
        '</td><td>' + (active ? '✅' : '❌') + '</td><td>' +
        (active ? '<button class="row-btn" type="button" data-deactivate="' + esc(id) + '">Deactivate</button>' : '') +
        '</td></tr>';
    });
    $('adminPasswordsBody').innerHTML = html;
  } catch (e) {
    showToast('Could not load the list.');
  } finally {
    btn.disabled = false;
  }
});

/* Deactivate buttons are rendered in a batch, so one delegated listener. */
$('adminPasswordsBody').addEventListener('click', async function (ev) {
  var btn = ev.target.closest('[data-deactivate]');
  if (!btn) { return; }
  var id = btn.getAttribute('data-deactivate');
  btn.disabled = true;
  try {
    await adminPost('/admin/deactivate', { id: id });
    showToast('Password deactivated.');
    $('adminRefreshBtn').click();
  } catch (e) {
    showToast('Could not deactivate.');
    btn.disabled = false;
  }
});

/* ================= Hidden chat entry + real chat ================= */
/* The chat code is the pairing key, so it must survive app updates.
 * It lives in the native encrypted store (like the password), NOT in
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
    if (authed) { openChatLock(); }
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
$('chatLockBackBtn').addEventListener('click', function () { showScreen('screen-home'); });

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
  sending: false,
  replyTo: null,
  menuMsgId: null
};

/* Join (or create) the room for this code. The device id IS the member
 * identity, so make sure it is populated first. */
async function joinChat(code) {
  var info = await getDeviceInfo();
  window.MsStudySession.deviceId = info.deviceId;
  chatState.myDeviceId = info.deviceId;
  var data = await apiCall('/chat/join', { code: code });
  if (!data || data.result === 'full') { return { ok: false, reason: 'full' }; }
  if (!data || data.result !== 'ok') { return { ok: false, reason: 'retry' }; }
  chatState.code = code;
  chatState.roomId = data.roomId || null;
  chatState.members = data.members || [];
  chatState.presence = data.presence || [];
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
}

function formatChatTime(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) { return ''; }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) { return 'Last seen recently'; }
  var now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return 'Last seen ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return 'Last seen ' + d.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  chatState.messages.forEach(function (m) {
    var mine = (m.sender_device === chatState.myDeviceId);
    var quote = '';
    if (m.reply_to && chatState.byId[m.reply_to]) {
      quote = '<div class="msg-quote">' + esc(chatState.byId[m.reply_to].body || '') + '</div>';
    }
    html += '<div class="msg ' + (mine ? 'msg-mine' : 'msg-theirs') + '" data-msg="' + esc(m.id) + '">' +
      quote + '<div class="msg-body">' + esc(m.body || '') + '</div>' +
      '<span class="msg-time">' + esc(formatChatTime(m.created_at)) + '</span></div>';
  });
  list.innerHTML = html;
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
}

function closeChatMsgMenu() {
  chatState.menuMsgId = null;
  $('chatMsgMenu').hidden = true;
}

/* Composer */
$('chatSendBtn').addEventListener('click', sendChatMessage);
$('chatInput').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { sendChatMessage(); }
});
$('chatReplyCancel').addEventListener('click', hideReplyBar);
$('chatBackBtn').addEventListener('click', function () {
  stopChat();
  showScreen('screen-home');
});

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

/* ================= Boot ================= */
/* Stay signed in across launches and updates: the password is stored
 * AES-encrypted natively (like PW), so boot silently revalidates it.
 * Only if there is no stored password (or it was kicked/incorrect)
 * does the lock screen show. */
async function trySavedLogin() {
  var plugin = capPlugin('MsAccess');
  if (plugin && plugin.revalidateSaved) {
    try {
      var r = await plugin.revalidateSaved();
      if (r && r.result === 'valid' && r.password) {
        window.MsStudySession.password = r.password;
        window.MsStudySession.role = r.role || 'user';
        // Populate the device id now, not 15s later at the first
        // revalidation — every server call needs it (see apiCall).
        var dinfo = await getDeviceInfo();
        window.MsStudySession.deviceId = dinfo.deviceId;
        window.MsStudySession.deviceLabel = dinfo.deviceLabel;
        enterApp();
        return;
      }
    } catch (e) { /* fall through to the lock screen */ }
  }
  showScreen('screen-lock');
}
trySavedLogin();
/* Check for an update on launch too (not only after login), so the app
 * can update itself even before signing in. */
checkForUpdate();
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar) {
  try {
    window.Capacitor.Plugins.StatusBar.setStyle({ style: 'LIGHT' });
    window.Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#f4f6f9' });
  } catch (e) { /* non-fatal on web */ }
}
