const __filenameAsUrl = require('url').pathToFileURL(__filename).href;

// dist/watchdog/index.js
var import_node_child_process = require("node:child_process");
var import_node_url = require("node:url");
var import_node_path3 = require("node:path");

// dist/daemon/heartbeat.js
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");

// dist/daemon/paths.js
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function appDataDir() {
  if (process.env.FOCUSLOCK_DATA_DIR)
    return process.env.FOCUSLOCK_DATA_DIR;
  const plat = (0, import_node_os.platform)();
  if (plat === "win32") {
    return (0, import_node_path.join)(process.env.PROGRAMDATA ?? "C:/ProgramData", "Onest");
  }
  if (plat === "darwin") {
    return (0, import_node_path.join)((0, import_node_os.homedir)(), "Library", "Application Support", "Onest");
  }
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".onest");
}

// dist/daemon/heartbeat.js
var STALE_MS = 2e3;
function fileFor(name) {
  return (0, import_node_path2.join)(appDataDir(), `${name}.heartbeat`);
}
function writeHeartbeat(name) {
  try {
    (0, import_node_fs.writeFileSync)(fileFor(name), String(Date.now()), "utf8");
  } catch {
  }
}
function isStale(name) {
  try {
    const raw = (0, import_node_fs.readFileSync)(fileFor(name), "utf8");
    const ts = Number(raw);
    return !Number.isFinite(ts) || Date.now() - ts > STALE_MS;
  } catch {
    return true;
  }
}

// dist/watchdog/index.js
var __dirname = (0, import_node_path3.dirname)((0, import_node_url.fileURLToPath)(__filenameAsUrl));
var DAEMON_ENTRY = process.env.FOCUSLOCK_DAEMON_ENTRY ?? (0, import_node_path3.join)(__dirname, "..", "daemon", "index.js");
function spawnDaemon() {
  const child = (0, import_node_child_process.spawn)(process.execPath, [DAEMON_ENTRY, ...process.argv.slice(2)], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  writeHeartbeat("daemon");
}
function tick() {
  writeHeartbeat("watchdog");
  if (isStale("daemon")) {
    console.log("watchdog: daemon heartbeat stale, respawning");
    spawnDaemon();
  }
}
setInterval(tick, 1e3);
tick();
console.log("focus-lock watchdog running");
