routerAdd("GET", "/api/calorie-logger/v5/{path...}", (e) => require(`${__hooks}/calorie-logger.js`).dispatch(e));
routerAdd("POST", "/api/calorie-logger/v5/{path...}", (e) => require(`${__hooks}/calorie-logger.js`).dispatch(e));

// The published macOS application archive. Served as plain static files rather than through the
// versioned dispatcher so the download streams instead of passing through the JavaScript runtime,
// and kept out of pb_public so the installed web app's service worker never precaches it.
// Unversioned because a desktop archive is not part of the API contract: the manifest at
// /api/calorie-logger/v5/mac-release is what names the current file.
//
// A server with no downloads directory -- a test run, or a deployment made from a machine that
// cannot build a macOS application -- simply does not offer the route. Registering it must never
// be the thing that stops the rest of the API from loading.
try {
  const downloads = $os.getenv("CALORIE_LOGGER_DOWNLOADS_PATH") || "/pb/downloads";
  routerAdd("GET", "/api/calorie-logger/downloads/{path...}", $apis.static($os.dirFS(downloads), false));
} catch (error) {
  console.log("Calorie Logger: no macOS download directory; the desktop application is not offered.");
}
