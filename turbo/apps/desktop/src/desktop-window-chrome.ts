type DesktopWindowChromeOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
>;

export function buildDesktopWindowChromeOptions(
  platform: NodeJS.Platform,
): DesktopWindowChromeOptions {
  if (platform !== "darwin") {
    return {};
  }

  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
  };
}
