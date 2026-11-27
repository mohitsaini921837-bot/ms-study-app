# MS Study — web-bundle (www) releases (v1.0.23+)

Silent auto-update for **web-only** changes. No button, no tap: the user
reopens the app and the new www is live. Native changes (new plugin,
permission, icon, AndroidManifest, versionCode bump) still need an APK
install — Android cannot silently install an APK; the in-app APK updater
(dialog + Notes banner, see `app.js` `checkForUpdate`) opens the system
installer, which always needs one tap.

## How it works (one paragraph)

On every launch the app fetches `update/version.json` once (same fetch
the APK check uses). If `wwwBuild` is newer than the running bundle, the
app downloads the www ZIP in the background, saves it to cache, and the
native `MsAccess.installWebBundle()` verifies its SHA-256, unzips it to
internal storage, validates `index.html` / `app.js` / `styles.css` /
`drive.js` exist, and only then records the path in the SharedPreferences
the Capacitor Bridge reads at startup (`CapWebViewSettings` /
`serverBasePath`). The downloaded bundle is served from the **next cold
launch**. Any failure leaves the stored path untouched — the app keeps
running its current bundle and retries next launch. Installing a new APK
clears the stored path automatically (Capacitor `Bridge.isNewBinary()`),
so a new APK always starts from its own bundled www.

## Versioning

- `wwwBuild` is a plain **integer**, strictly increasing. Never reuse or
  decrease one.
- The v1.0.23 APK's bundled www **is build 24** (= its `versionCode`).
  `BUNDLED_WWW_BUILD` in `app/www/web-update.js` is 24.
- Web-only releases: 25, 26, 27, …
- A future APK **must** set its `BUNDLED_WWW_BUILD` to
  `max(its versionCode, latest published wwwBuild)` — otherwise the new
  APK's older bundled www would be treated as a downgrade and the
  already-published newer web bundle would be re-downloaded (harmless
  but wasteful), and worse, a web fix published after the APK was built
  could be lost if the numbers collide. When in doubt, set the APK's
  bundled build to the latest published `wwwBuild`.

## Release steps (web-only fix)

Run from the repo root (`~/workspace/ms-study`):

```sh
# 1. Make the www change in app/www/ (index.html / app.js / styles.css /
#    drive.js / web-update.js). Bump NOTHING else.
# 2. Pick the next build number N (previous wwwBuild + 1).
N=25

# 3. Build the ZIP — exactly these files, paths relative to app/www/:
cd app/www
zip -qr /tmp/ms-study-www-$N.zip index.html app.js styles.css drive.js web-update.js icon.png vendor
cd ../..

# 4. Hash it:
sha256sum /tmp/ms-study-www-$N.zip
#    -> <SHA256>

# 5. Upload the ZIP to GitHub Pages next to the APK, so it is served at:
#    https://mohitsaini921837-bot.github.io/ms-study-app/update/MS-Study-www-$N.zip
#    (same repo/folder the APKs live in: the ms-study-app Pages site,
#    update/ folder.)

# 6. Update update/version.json — change ONLY these three fields:
#      "wwwBuild": N,
#      "wwwUrl":   "https://mohitsaini921837-bot.github.io/ms-study-app/update/MS-Study-www-$N.zip",
#      "wwwSha256": "<SHA256 from step 4>"
#    Leave version / versionCode / apkUrl / changelog alone (they drive
#    the APK path). If the ZIP is rebuilt for any reason, recompute the
#    SHA-256 in step 4 and update wwwSha256 — a stale hash means every
#    phone rejects the bundle and stays on the old www (safe, but no update).
```

That is the whole release. No APK build, no install tap. The next time
each phone opens the app it stages the bundle in the background and uses
it from the following launch.

## Rollback

- Web rollback = publish a **new, higher** `wwwBuild` whose ZIP contains
  the old (good) www contents, following the steps above. There is no
  "go back to build N" — the loader only ever moves forward.
- Emergency per-phone rollback: clearing the app's stored bundle is not
  exposed in the UI; reinstalling the APK (or clearing app data) restores
  the bundled www, because a new APK clears the stored path.

## What does NOT auto-update

Anything native: new Capacitor plugin, new permission, app icon, splash,
`AndroidManifest.xml`, `build.gradle` `versionCode`, or a change to
`MsAccessPlugin.java` / `ApkInstallerPlugin.java` / `MainActivity.java`
themselves. Those ship in the next APK via the normal APK update path.

## Files

- Loader JS: `app/www/web-update.js` (`window.MsWebUpdate`)
- Wiring: `app/www/app.js` `checkForUpdate()` (one manifest fetch feeds
  both the APK dialog/banner and this loader)
- Native install/verify/unzip: `app/android/app/src/main/java/com/kiara/msstudy/MsAccessPlugin.java`
  (`installWebBundle` / `getWebBundleInfo` / `clearWebBundle`)
- Manifest: `update/version.json` (`wwwBuild`, `wwwUrl`, `wwwSha256`)
