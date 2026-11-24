/* MS Study — Phase 1 app shell (Capacitor 6, single-page app).
 *
 * Mirrors the PW app's Capacitor pattern (pw-apk/app):
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
 *   - The entered password lives in MEMORY ONLY (MsStudySession.password,
 *     a JS variable). It is NEVER written to localStorage, sessionStorage,
 *     the native session store, or any file. The native store holds only
 *     {deviceId, role} — no password, no expiry.
 *   - Fresh launch always asks for the password again (there is nothing
 *     stored to revalidate with). Within one run, revalidation uses the
 *     in-memory password every 15s + on resume.
 *   - NO download option for any content anywhere in the UI.
 *   - NO Google Sign-In / Drive key in the client (see drive.js).
 */

'use strict';

/* ================= Config ================= */
var SERVER_URL = 'https://ms-study-server.onrender.com';
/* ^^^ PLANNED Render URL — UPDATE THIS once the real Render service is
 * live if its URL differs. The app will not log in until this points
 * at the real MS Study server. */
var UPDATE_URL = 'https://mohitsaini921837-bot.github.io/ms-study-app/version.json';
var CURRENT_VERSION_CODE = 1;

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
var ALL_SCREENS = MAIN_SCREENS.concat(['screen-lock', 'screen-chat-lock', 'screen-chat']);

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
}

document.querySelectorAll('.nav-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    if (!authed) { return; }
    showScreen(btn.getAttribute('data-screen'));
  }, { passive: true });
});

/* ================= Password gate ================= */
var GATE_MSGS = {
  incorrect: ['Galat password', 'Ye password server par save nahi hai. Dobara check karke daalo.'],
  kicked: ['Dusre device pe login hai', 'Is password se ab dusre device pe login hai.'],
  unavailable: ['Server jag raha hai', 'Thoda wait karke dobara try karo. Free server ko jaagne me time lagta hai.'],
  rate_limited: ['Thoda ruko', 'Bahut zyada try ho gaye. Thodi der baad try karo.'],
  empty: ['Password daalo', 'Apna access password daalo.']
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
      // Password -> memory ONLY. Session store keeps {deviceId, role}.
      window.MsStudySession.password = pw;
      window.MsStudySession.role = r.role || 'user';
      enterApp();
    } else if (r.result === 'kicked') {
      showLockChecking(false);
      showToast('Is password se ab dusre device pe login hai');
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
  $('activeChip').hidden = true;
  $('adminBtn').hidden = true;
  var plugin = capPlugin('MsAccess');
  if (plugin && plugin.clearSession) { try { plugin.clearSession(); } catch (e) {} }
  showScreen('screen-lock');
  showLockChecking(false);
  if (reason === 'kicked') {
    showToast('Is password se ab dusre device pe login hai');
    showLockError('kicked');
  } else if (reason === 'incorrect') {
    showLockError('incorrect');
  } else {
    showLockError(null);
  }
}

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
  if (!res.ok) { throw new Error((data && (data.error || data.message)) || ('Server error ' + res.status)); }
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
    if (!code) { throw new Error('Server ne koi code nahi diya'); }
    $('adminNewCodeText').textContent = code;
    $('adminCreateResult').hidden = false;
    showToast('Naya password ban gaya — abhi copy kar lo');
  } catch (e) {
    showToast('Password ban nahi paya: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

$('adminCopyBtn').addEventListener('click', async function () {
  try {
    await navigator.clipboard.writeText($('adminNewCodeText').textContent);
    showToast('Copy ho gaya');
  } catch (e) { showToast('Copy nahi ho paya — code ko haath se likh lo'); }
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

$('adminRefreshBtn').addEventListener('click', async function () {
  var btn = $('adminRefreshBtn');
  btn.disabled = true;
  try {
    var data = await adminPost('/admin/passwords', {});
    var rows = data.passwords || data.items || data || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      $('adminPasswordsBody').innerHTML = '<tr><td colspan="6" class="muted">Koi password nahi mila.</td></tr>';
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
    showToast('List load nahi hui: ' + e.message);
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
    showToast('Password deactivate kar diya');
    $('adminRefreshBtn').click();
  } catch (e) {
    showToast('Deactivate nahi ho paya: ' + e.message);
    btn.disabled = false;
  }
});

/* Drive upload (admin only) — via drive.js, server-side Drive. */
$('adminUploadBtn').addEventListener('click', async function () {
  var file = $('adminUploadFile').files && $('adminUploadFile').files[0];
  var title = ($('adminUploadTitle').value || '').trim();
  if (!file) { showToast('Pehle koi file chuno'); return; }
  var btn = $('adminUploadBtn');
  btn.disabled = true;
  $('adminUploadResult').hidden = true;
  try {
    var data = await window.MsDrive.upload(file, title, 'note');
    var link = data.directLink || data.url || data.link || '';
    $('adminUploadMsg').textContent = 'Upload ho gaya ✅';
    $('adminUploadLink').value = link;
    $('adminUploadResult').hidden = false;
    showToast('Upload ho gaya');
  } catch (e) {
    showToast('Upload nahi ho paya: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

$('adminUploadCopyBtn').addEventListener('click', async function () {
  try {
    await navigator.clipboard.writeText($('adminUploadLink').value);
    showToast('Link copy ho gaya');
  } catch (e) { showToast('Copy nahi ho paya'); }
});

/* ================= Hidden chat entry (lock only — real chat = Phase 5) ================= */
var CHAT_CODE_KEY = 'ms_chat_code';
var LONG_PRESS_MS = 3000;
var longPressTimer = null;

function openChatLock() {
  var hasCode = null;
  try { hasCode = window.localStorage.getItem(CHAT_CODE_KEY); } catch (e) {}
  $('chatLockError').hidden = true;
  $('chatCodeInput').value = '';
  $('chatCodeConfirm').value = '';
  if (hasCode) {
    $('chatLockTitle').textContent = 'Chat code daalo';
    $('chatLockSub').textContent = 'Hidden chat kholne ke liye code daalo.';
    $('chatCodeConfirmWrap').hidden = true;
    $('chatLockBtn').textContent = 'Khol lo';
  } else {
    $('chatLockTitle').textContent = 'Chat code set karo';
    $('chatLockSub').textContent = 'Pehli baar ek code set karo. Wahi code dono taraf use hoga.';
    $('chatCodeConfirmWrap').hidden = false;
    $('chatLockBtn').textContent = 'Set karo';
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

$('chatLockBtn').addEventListener('click', function () {
  var code = ($('chatCodeInput').value || '').trim();
  var stored = null;
  try { stored = window.localStorage.getItem(CHAT_CODE_KEY); } catch (e) {}
  if (!code) { return; }
  if (!stored) {
    var confirmCode = ($('chatCodeConfirm').value || '').trim();
    if (code !== confirmCode) {
      $('chatLockError').hidden = false;
      $('chatLockCard').classList.remove('shake');
      void $('chatLockCard').offsetWidth;
      $('chatLockCard').classList.add('shake');
      return;
    }
    try { window.localStorage.setItem(CHAT_CODE_KEY, code); } catch (e) {}
    showScreen('screen-chat');
    return;
  }
  if (code === stored) {
    showScreen('screen-chat');
  } else {
    $('chatLockError').hidden = false;
    $('chatLockCard').classList.remove('shake');
    void $('chatLockCard').offsetWidth;
    $('chatLockCard').classList.add('shake');
  }
});
$('chatCodeInput').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { $('chatLockBtn').click(); }
});
$('chatLockBackBtn').addEventListener('click', function () { showScreen('screen-home'); });
$('chatBackBtn').addEventListener('click', function () { showScreen('screen-home'); });

/* ================= In-app update ================= */
async function checkForUpdate() {
  try {
    var res = await fetch(UPDATE_URL, { cache: 'no-store' });
    if (!res.ok) { return; }
    var data = await res.json();
    if (data && data.versionCode > CURRENT_VERSION_CODE) {
      pendingUpdate = data;
      $('updateChangelog').textContent = data.changelog || ('Version ' + data.version + ' available hai.');
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
  $('updateStatus').textContent = 'APK download ho raha hai…';
  try {
    var installer = capPlugin('ApkInstaller');
    var fs = capPlugin('Filesystem');
    if (!installer || !installer.installApk || !fs) {
      throw new Error('Installer is app version me available nahi hai');
    }
    var res = await fetch(pendingUpdate.apkUrl);
    if (!res.ok) { throw new Error('APK download nahi ho paya (' + res.status + ')'); }
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
    $('updateStatus').textContent = 'Installer khul raha hai…';
    await installer.installApk({ fileName: fileName });
    $('updateDialog').hidden = true;
  } catch (e) {
    $('updateStatus').textContent = 'Update nahi ho paya: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

/* ================= Boot ================= */
/* Fresh launch always shows the password gate: the password lives in
 * memory only, so there is nothing stored to silently revalidate with.
 * (Unlike PW, which stores the password encrypted natively.) */
showScreen('screen-lock');
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar) {
  try {
    window.Capacitor.Plugins.StatusBar.setStyle({ style: 'LIGHT' });
    window.Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#f4f6f9' });
  } catch (e) { /* non-fatal on web */ }
}
