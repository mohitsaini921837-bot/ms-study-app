/* MS Study — Drive client (Phase 1).
 *
 * NO Google Sign-In in the app. NO Drive API key / JSON / service-account
 * credential in any client file. Every Drive operation goes through the
 * MS Study server (SERVER_URL), which holds the service-account key
 * server-side only. The app only ever sends {password, deviceId} plus
 * the file/title/kind the admin chose.
 *
 * Endpoints (server contract, same auth shape as /validate):
 *   POST {SERVER_URL}/drive/list   {password, deviceId, folderId?}
 *   POST {SERVER_URL}/drive/upload multipart FormData
 *        {password, deviceId, file, title, kind}
 *        -> {ok: true, directLink: "https://..."} (or {error: "..."})
 *
 * This file only defines window.MsDrive; app.js owns SERVER_URL and
 * the in-memory password. Nothing here stores a password. */

(function () {
  'use strict';

  function serverUrl() {
    if (typeof window.MsStudyConfig === 'undefined' || !window.MsStudyConfig.SERVER_URL) {
      throw new Error('MsStudyConfig.SERVER_URL not set');
    }
    return window.MsStudyConfig.SERVER_URL.replace(/\/$/, '');
  }

  function authHeaders() {
    // Password lives in memory only (app.js). Never persisted here.
    return {
      password: window.MsStudySession ? window.MsStudySession.password : '',
      deviceId: window.MsStudySession ? window.MsStudySession.deviceId : ''
    };
  }

  async function postJson(path, body) {
    var res = await fetch(serverUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || ('Server error ' + res.status));
    }
    return data;
  }

  /* List Drive items in a folder (folderId optional = Drive root). */
  async function driveList(folderId) {
    var auth = authHeaders();
    var body = { password: auth.password, deviceId: auth.deviceId };
    if (folderId) { body.folderId = folderId; }
    return postJson('/drive/list', body);
  }

  /* Upload one file. kind: "note" | "sheet" | "video" (Phase 1: "note").
   * Returns the server response, which includes the direct link. */
  async function driveUpload(file, title, kind) {
    if (!file) { throw new Error('Koi file select nahi ki'); }
    var auth = authHeaders();
    var form = new FormData();
    form.append('password', auth.password);
    form.append('deviceId', auth.deviceId);
    form.append('file', file);
    form.append('title', title || file.name);
    form.append('kind', kind || 'note');
    var res = await fetch(serverUrl() + '/drive/upload', { method: 'POST', body: form });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || ('Upload failed ' + res.status));
    }
    return data;
  }

  window.MsDrive = { list: driveList, upload: driveUpload };
})();
