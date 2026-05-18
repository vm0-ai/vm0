import path from "node:path";
import { app, BrowserWindow, shell, type WebContents } from "electron";
import { resolveDesktopConfig } from "./config";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

const APP_NAME = "Zero";
const config = resolveDesktopConfig();

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function openExternal(url: string): void {
  void shell.openExternal(url);
}

function browserWindowOptions() {
  return {
    title: APP_NAME,
    backgroundColor: "#19191b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
      partition: config.sessionPartition,
    },
  } satisfies Electron.BrowserWindowConstructorOptions;
}

function installChildWindowPolicy(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, config.allowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });
}

function installMainWindowPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, config.allowedAppOrigins)) {
      return;
    }
    event.preventDefault();
    const decision = decideWindowOpen(url, config.allowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, config.allowedAppOrigins);
    if (decision.action === "allow-in-app") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: browserWindowOptions(),
      };
    }
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });

  window.webContents.on("did-create-window", (childWindow) => {
    installChildWindowPolicy(childWindow.webContents);
  });
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    ...browserWindowOptions(),
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
  });

  installMainWindowPolicy(window);
  await window.loadURL(config.platformUrl.toString());
}

if (process.platform !== "darwin") {
  console.warn("Zero Desktop POC is macOS-first and only packages for darwin.");
}

app.name = APP_NAME;

void app.whenReady().then(async () => {
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
