// Resona Mac app: runs the backend in a utility process and shows the UI it serves.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isNewer } from "./version.ts";

const PORT = Number(process.env.RESONA_PORT || 4317); // fixed: localStorage is per origin, a new port would reset it
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(32).toString("hex"); // new every launch; only this app's window sends it
// Newest published GitHub release; the env override exists only to test against a fake feed.
const RELEASES_URL = process.env.RESONA_RELEASES_URL || "https://api.github.com/repos/Sonicnik/resona/releases/latest";

// Same folder as the backend's data (backend/src/config.ts), with Chromium's files kept in a subfolder.
const dataDir = process.env.RESONA_DATA_DIR ? path.resolve(process.env.RESONA_DATA_DIR) : path.join(app.getPath("appData"), "Resona");
app.setPath("userData", path.join(dataDir, "Electron"));

const here = import.meta.dirname;
const backendFile = app.isPackaged ? path.join(process.resourcesPath, "backend.mjs") : path.join(here, "backend.mjs");
const uiDir = app.isPackaged ? path.join(process.resourcesPath, "app-dist") : path.join(here, "../../app/dist");
const assetsDir = app.isPackaged ? process.resourcesPath : path.join(here, "../assets");
const boundsFile = path.join(app.getPath("userData"), "window.json");

let win: BrowserWindow | null = null;
let backend: UtilityProcess | null = null;
let quitting = false;
let lastErrors: string[] = [];
let tray: Tray | null = null;
let status: any = null; // last GET /api/status, null while the backend is unreachable
let seenOpportunities: number | null = null;
let update: { version: string; url: string } | null = null; // a newer release, once found

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(start);
}

async function start() {
  // Every request from the window to the backend carries the token; other local programs don't have it.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, done) => {
    done({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${TOKEN}` } });
  });
  ipcMain.handle("login-item:get", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("login-item:set", (_e, on: boolean) => setLoginItem(on === true));

  Menu.setApplicationMenu(buildMenu());
  createTray();
  if (await startBackend()) createWindow();
  refreshStatus();
  setInterval(refreshStatus, 30_000);
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 60 * 60_000);
}

/** Unsigned builds can't install updates themselves, so this only points to the download. */
async function checkForUpdate() {
  try {
    const res = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": `Resona/${app.getVersion()}` } });
    if (!res.ok) return; // 404 until the first release is published
    const release = await res.json();
    const version = String(release.tag_name ?? "").replace(/^v/, "");
    if (!isNewer(version, app.getVersion()) || update?.version === version) return;
    update = { version, url: String(release.html_url) };
    updateTray();
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: "Resona update available", body: `Version ${version} is ready to download.` });
    note.on("click", () => openExternal(update!.url));
    note.show();
  } catch {
    /* offline: try again at the next check */
  }
}

/** Sends a menu id to the UI (`onNativeMenu` in app/src/App.tsx), showing the window first. */
function sendToUi(id: string) {
  showWindow();
  win?.webContents.send("menu", id);
}

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ORIGIN}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p} failed: ${res.status}`);
  return res.json();
}

function setLoginItem(on: boolean) {
  app.setLoginItemSettings({ openAtLogin: on });
  updateTray();
}

// ---------- Menu bar icon: the agent keeps working after the window closes ----------

function createTray() {
  const icon = nativeImage.createFromPath(path.join(assetsDir, "trayTemplate.png")); // @2x is picked up automatically
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Resona");
  updateTray();
}

const STATE_TEXT: Record<string, string> = { running: "Agent running", paused: "Agent paused", catching_up: "Catching up" };

function updateTray() {
  if (!tray) return;
  const live = status !== null;
  const paused = status?.agent?.state === "paused";
  const open: number = status?.counts?.openOpportunities ?? 0;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: live ? (STATE_TEXT[status.agent?.state] ?? "Agent running") : "Backend not running", enabled: false },
      ...(update ? ([{ label: `Download Resona ${update.version}…`, click: () => openExternal(update!.url) }] as MenuItemConstructorOptions[]) : []),
      { type: "separator" },
      { label: "Open Resona", click: showWindow },
      { label: `Review ${open} ${open === 1 ? "Opportunity" : "Opportunities"}`, enabled: live, click: () => sendToUi("screen:opps") },
      { label: "Scan for Opportunities Now", enabled: live, click: () => sendToUi("scan") },
      { label: paused ? "Resume Agent" : "Pause Agent", enabled: live, click: () => void setPaused(!paused) },
      { type: "separator" },
      { label: "Open at Login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (item) => setLoginItem(item.checked) },
      { type: "separator" },
      { label: "Quit Resona", click: () => app.quit() },
    ]),
  );
}

async function setPaused(paused: boolean) {
  await api("PATCH", "/settings", { "agent.paused": paused }).catch(() => {});
  win?.webContents.send("menu", "refresh");
  await refreshStatus();
}

async function refreshStatus() {
  status = await api("GET", "/status").catch(() => null);
  const open = status?.counts?.openOpportunities;
  if (typeof open === "number") {
    // shortcut: compares counts, so dismissals and new arrivals within one 30 s poll can cancel out; upgrade to a "since" query if that matters.
    if (seenOpportunities !== null && open > seenOpportunities && !win?.isFocused()) notifyNew(open - seenOpportunities);
    seenOpportunities = open;
  }
  updateTray();
}

function notifyNew(n: number) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: "Resona", body: n === 1 ? "1 new opportunity is ready to review." : `${n} new opportunities are ready to review.` });
  note.on("click", () => sendToUi("screen:opps"));
  note.show();
}

/** Standard Mac menus; app items send an id to the UI (`onNativeMenu` in app/src/App.tsx). */
function buildMenu(): Menu {
  // The UI already handles these shortcuts in its keydown listener, so the menu shows them without capturing the keys.
  const ui = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => sendToUi(id),
  });
  const screens = ["Home", "Opportunities", "Posts", "Network", "Projects", "Privacy"];
  const ids = ["home", "opps", "posts", "network", "projects", "privacy"];
  return Menu.buildFromTemplate([
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        ui("Settings…", "settings", "Cmd+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [ui("Add Project Folder…", "add-folder", "Cmd+O"), ui("Import LinkedIn Archive…", "import-linkedin"), { type: "separator" }, { role: "close" }],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...screens.map((name, i) => ui(name, `screen:${ids[i]}`, `Cmd+${i + 1}`)),
        { type: "separator" },
        ui("Back", "back", "Cmd+["),
        ui("Forward", "forward", "Cmd+]"),
        ui("Search…", "search", "Cmd+K"),
        ui("Free Flight", "free-flight", "F"),
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : ([{ role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Resona Help", click: () => shell.openExternal("https://github.com/Sonicnik/resona#readme") }] },
  ]);
}

function startBackend(): Promise<boolean> {
  lastErrors = [];
  backend = utilityProcess.fork(backendFile, [], {
    serviceName: "Resona Backend",
    stdio: "pipe",
    env: {
      ...process.env,
      RESONA_PORT: String(PORT),
      RESONA_STATIC_DIR: uiDir,
      RESONA_API_TOKEN: TOKEN,
      RESONA_ALLOWED_ORIGINS: ORIGIN,
      NODE_NO_WARNINGS: "1",
    },
  });
  backend.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  backend.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    lastErrors = [...lastErrors, ...d.toString().trim().split("\n")].slice(-5);
  });
  backend.once("exit", (code) => {
    console.log(`[resona-desktop] backend exited with code ${code}${quitting ? " (quitting)" : ""}`);
    backend = null;
    if (quitting) return void app.quit();
    backendFailed(`The Resona backend stopped (exit code ${code}).`);
  });
  return waitForHealth();
}

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 100 && backend; i++) {
    try {
      const res = await fetch(`${ORIGIN}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (res.ok) return true; // a 401 here means another program owns the port
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (backend) {
    lastErrors.push(`Nothing answered on port ${PORT}, or another program is using it.`);
    backend.kill(); // its exit handler shows the error
  }
  return false;
}

async function backendFailed(message: string) {
  const { response } = await dialog.showMessageBox({
    type: "error",
    message,
    detail: lastErrors.join("\n") || "No error output.",
    buttons: ["Restart", "Quit"],
    defaultId: 0,
  });
  if (response !== 0) return app.quit();
  if ((await startBackend()) && !win) createWindow();
  else win?.reload();
}

function createWindow() {
  win = new BrowserWindow({
    ...readBounds(),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Resona",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 22 }, // where the UI's drawn buttons were (.app + .sidebar + .traffic padding)
    backgroundColor: "#0a0814", // matches the body background in app/src/styles.css, no white flash
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Opened at login: stay in the menu bar until the user asks for the window.
  win.once("ready-to-show", () => app.getLoginItemSettings().wasOpenedAtLogin || win?.show());
  // Closing only hides the window; the agent keeps running. Quit comes from ⌘Q or the menu bar icon.
  win.on("close", (e) => {
    if (!win) return;
    fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
    if (quitting) return;
    e.preventDefault();
    if (!win.isFullScreen()) return win.hide();
    win.once("leave-full-screen", () => win?.hide()); // hiding a full-screen window leaves an empty Space behind
    win.setFullScreen(false);
  });
  win.on("closed", () => (win = null));

  // Links leave the app for the default browser; the window itself never navigates away from the UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin === ORIGIN) return;
    e.preventDefault();
    openExternal(url);
  });

  win.loadURL(`${ORIGIN}/`);
}

function openExternal(url: string) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function readBounds(): Partial<Electron.Rectangle> {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, "utf8"));
  } catch {
    return { width: 1280, height: 820 };
  }
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on("activate", showWindow);
app.on("window-all-closed", () => {
  /* keep running in the menu bar (without this listener Electron would quit) */
});

// Let the backend shut down cleanly (it closes the database on SIGTERM) before the app exits.
app.on("before-quit", (e) => {
  quitting = true;
  if (!backend) return;
  e.preventDefault();
  console.log("[resona-desktop] stopping the backend");
  backend.kill();
  setTimeout(() => app.exit(0), 5000).unref();
});
