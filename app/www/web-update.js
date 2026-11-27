/* MS Study — silent web-bundle auto-update (v1.0.23).
 *
 * MECHANISM (verified against Capacitor 6 source in this project):
 *   node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/
 *   - Bridge.java:278-285 — on EVERY launch the Bridge reads the
 *     SharedPreferences "CapWebViewSettings" key "serverBasePath"; if the
 *     path exists it calls setServerBasePath(path), which makes the
 *     WebView's local server serve files from that folder instead of the
 *     APK's bundled assets.
 *   - Bridge.java:1381-1383 — setServerBasePath() = localServer.hostFiles(path)
 *     + reload; WebViewLocalServer.java:626-633 hostFiles() serves any folder
 *     under the app's data dir on the same https://localhost origin, so the
 *     downloaded bundle behaves exactly like the bundled www (same origin,
 *     same injected Capacitor bridge JS).
 *   - Bridge.java:414-441 — isNewBinary(): when the APK versionCode or
 *     versionName changes, the stored serverBasePath is CLEARED, so a new
 *     APK always starts from its own bundled www. A downloaded bundle can
 *     therefore never override a newer APK.
 *   - Bridge.java:643 — the core WebView plugin is registered by the Bridge
 *     itself; this file does NOT depend on it — the pref is written by the
 *     native MsAccess.installWebBundle() method instead (one atomic step:
 *     verify + extract + validate + persist), so a bad bundle can never
 *     leave a half-written path behind.
 *
 * FLOW (background, never blocks launch, never bricks the app):
 *   launch -> fetch update/version.json (same fetch as the APK check in
 *   app.js) -> if manifest.wwwBuild > effective build, download the zip
 *   in the background -> save to cache -> native installWebBundle() verifies
 *   SHA-256, unzips to internal storage, validates index.html/app.js/
 *   styles.css/drive.js exist, and ONLY then persists the path -> the
 *   downloaded bundle is served from the NEXT cold launch. ANY failure
 *   (no internet, bad download, hash mismatch, corrupt zip, missing file)
 *   leaves the stored path untouched: the app keeps running the bundled
 *   (or previously installed) www and retries on the next launch.
 *
 * VERSIONING: wwwBuild is a plain integer, monotonic. The APK's bundled
 * www IS build 24 (= v1.0.23, versionCode 24). Web-only releases are
 * 25, 26, 27... A future APK must set its BUNDLED_WWW_BUILD below to
 * max(its versionCode, latest published wwwBuild) — see
 * update/WWW-RELEASE.md. Never reuse or decrease a wwwBuild.
 *
 * BROWSER FALLBACK: in a plain browser (no Capacitor) there is no native
 * installer, so checkForWebUpdate() is a silent no-op.
 */

(function () {
  'use strict';

  /* The APK's bundled www IS this build. Must match the APK's
   * versionCode for v1.0.23; a future APK bumps it (see header). */
  var BUNDLED_WWW_BUILD = 24;

  var LS_KEY = 'ms_www_build';
  var ZIP_PREFIX = 'ms-study-www-';

  function capPlugin(name) {
    try {
      return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
    } catch (e) { return null; }
  }

  function isNewerBuild(remote, current) {
    var r = Number(remote);
    var c = Number(current);
    if (!isFinite(r) || !isFinite(c)) { return false; }
    return Math.floor(r) > Math.floor(c);
  }

  function readStoredBuild() {
    try {
      var v = window.localStorage.getItem(LS_KEY);
      var n = v == null ? NaN : Number(v);
      return isFinite(n) ? Math.floor(n) : BUNDLED_WWW_BUILD;
    } catch (e) { return BUNDLED_WWW_BUILD; }
  }

  function saveStoredBuild(build) {
    try { window.localStorage.setItem(LS_KEY, String(build)); } catch (e) {}
  }

  /* Effective build = downloaded bundle if one is installed, else the
   * bundled www. The native pref is the source of truth; localStorage
   * is only a mirror for the plain-browser fallback. */
  async function getEffectiveBuild() {
    var plugin = capPlugin('MsAccess');
    if (plugin && plugin.getWebBundleInfo) {
      try {
        var info = await plugin.getWebBundleInfo();
        if (info && isFinite(Number(info.wwwBuild)) && Number(info.wwwBuild) > 0) {
          return Math.floor(Number(info.wwwBuild));
        }
      } catch (e) { /* fall through to the mirror */ }
    }
    return readStoredBuild();
  }

  function arrayBufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var binary = '';
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /* Silent background check+download+stage. `manifest` is the already
   * fetched version.json object (app.js fetches it once for the APK
   * check and passes it here — no second network call). `env` is an
   * injectable seam for the node test harness; browsers omit it.
   * Never throws; returns { status } where status is one of:
   * 'staged' | 'up-to-date' | 'no-update' | 'failed' | 'unavailable'. */
  async function checkForWebUpdate(manifest, env) {
    env = env || {};
    var fetchFn = env.fetchFn || window.fetch.bind(window);
    var fs = env.fs || capPlugin('Filesystem');
    var plugin = env.plugin || capPlugin('MsAccess');
    var getBuild = env.getEffectiveBuild || getEffectiveBuild;
    try {
      if (!manifest || typeof manifest.wwwBuild !== 'number' ||
          !manifest.wwwUrl || !manifest.wwwSha256) {
        return { status: 'no-update' }; // no web bundle published
      }
      if (!fs || !fs.writeFile || !plugin || !plugin.installWebBundle) {
        return { status: 'unavailable' }; // plain browser / old native
      }
      var current = await getBuild();
      if (!isNewerBuild(manifest.wwwBuild, current)) {
        return { status: 'up-to-date' };
      }
      var res = await fetchFn(manifest.wwwUrl, { cache: 'no-store' });
      if (!res.ok) { return { status: 'failed' }; }
      var buf = await res.arrayBuffer();
      if (!buf || buf.byteLength === 0) { return { status: 'failed' }; }
      var fileName = ZIP_PREFIX + Math.floor(manifest.wwwBuild) + '.zip';
      await fs.writeFile({ path: fileName, data: arrayBufferToBase64(buf), directory: 'CACHE', recursive: true });
      try {
        var installed = await plugin.installWebBundle({
          fileName: fileName,
          wwwBuild: Math.floor(manifest.wwwBuild),
          sha256: String(manifest.wwwSha256)
        });
        var applied = (installed && installed.wwwBuild) ? Math.floor(installed.wwwBuild) : Math.floor(manifest.wwwBuild);
        saveStoredBuild(applied);
        return { status: 'staged', wwwBuild: applied };
      } catch (installErr) {
        // Hash mismatch / corrupt zip / bad contents: the native side
        // never persisted the path, so the current bundle keeps running.
        // Best-effort cleanup of the bad zip; failure to delete is fine.
        try {
          if (fs.deleteFile) { await fs.deleteFile({ path: fileName, directory: 'CACHE' }); }
        } catch (e) {}
        return { status: 'failed' };
      }
    } catch (e) {
      return { status: 'failed' };
    }
  }

  var api = {
    BUNDLED_WWW_BUILD: BUNDLED_WWW_BUILD,
    isNewerBuild: isNewerBuild,
    getEffectiveBuild: getEffectiveBuild,
    checkForWebUpdate: checkForWebUpdate
  };

  window.MsWebUpdate = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
