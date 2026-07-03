type DesktopWindowChromeOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
>;

const TRAFFIC_LIGHT_POSITION: Electron.Point = { x: 16, y: 18 };

export function buildDesktopWindowChromeOptions(
  platform: NodeJS.Platform,
): DesktopWindowChromeOptions {
  if (platform !== "darwin") {
    return {};
  }

  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
  };
}
