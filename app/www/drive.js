/* MS Study — Drive client.
 *
 * NO Google Sign-In in the app. NO Drive API key / JSON / service-account
 * credential in any client file. Every Drive operation goes through the
 * MS Study server (SERVER_URL), which holds the service-account key
 * server-side only. The app only ever sends {deviceId} plus
 * the folder it is listing (v1.0.23: no password anywhere —
 * deviceId is the only identity).
 *
 * Endpoints (server contract):
 *   POST {SERVER_URL}/drive/list   {deviceId, folderId?}
 *
 * This file only defines window.MsDrive; app.js owns SERVER_URL and
 * the device id. Nothing here stores a password. */

(function () {
  'use strict';

  function serverUrl() {
    if (typeof window.MsStudyConfig === 'undefined' || !window.MsStudyConfig.SERVER_URL) {
      throw new Error('MsStudyConfig.SERVER_URL not set');
    }
    return window.MsStudyConfig.SERVER_URL.replace(/\/$/, '');
  }

  function authHeaders() {
    // Device id only (v1.0.23: no password). Never persisted here
    // beyond what app.js already holds in memory.
    return {
      deviceId: window.MsStudySession ? window.MsStudySession.deviceId : ''
    };
  }

  /* Normalize a server result code into a short error.
   * (v1.0.23: no lock screen exists any more — an auth failure is
   * just a plain error.) Returns an Error or null. */
  function resultError(data) {
    if (!data || typeof data.result !== 'string') { return null; }
    if (data.result === 'incorrect' || data.result === 'kicked') {
      return new Error('Try again.');
    }
    if (data.result === 'unauthorized') { return new Error('Not allowed.'); }
    if (data.result === 'unavailable') { return new Error('Try again.'); }
    return null;
  }

  async function postJson(path, body) {
    var res = await fetch(serverUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await res.json().catch(function () { return {}; });
    var err = resultError(data);
    if (err) { throw err; }
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || 'Try again.');
    }
    return data;
  }

  /* List Drive items in a folder (folderId optional = Drive root). */
  async function driveList(folderId) {
    var auth = authHeaders();
    var body = { deviceId: auth.deviceId };
    if (folderId) { body.folderId = folderId; }
    return postJson('/drive/list', body);
  }

  window.MsDrive = { list: driveList };
})();
