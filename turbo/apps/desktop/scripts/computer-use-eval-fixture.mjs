import { app, BrowserWindow } from "electron";

const fixtureUrl = process.argv[2];

if (!fixtureUrl) {
  throw new Error("Fixture URL is required");
}

app.setName("VM0 Computer Use Eval");

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    title: "VM0 Computer Use Eval",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadURL(fixtureUrl);
});

app.on("window-all-closed", () => {
  app.quit();
});
