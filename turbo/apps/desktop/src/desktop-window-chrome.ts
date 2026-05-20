type DesktopWindowChromeOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowTrafficLightLayout = "expanded" | "collapsed";

const EXPANDED_TRAFFIC_LIGHT_POSITION: Electron.Point = { x: 16, y: 18 };
const COLLAPSED_TRAFFIC_LIGHT_POSITION: Electron.Point = { x: 8, y: 18 };

export function desktopWindowTrafficLightPosition(
  layout: DesktopWindowTrafficLightLayout,
): Electron.Point {
  if (layout === "collapsed") {
    return COLLAPSED_TRAFFIC_LIGHT_POSITION;
  }
  return EXPANDED_TRAFFIC_LIGHT_POSITION;
}

export function applyDesktopWindowTrafficLightLayout(
  window: Pick<Electron.BrowserWindow, "setWindowButtonPosition">,
  platform: NodeJS.Platform,
  layout: DesktopWindowTrafficLightLayout,
): void {
  if (platform !== "darwin") {
    return;
  }
  window.setWindowButtonPosition(desktopWindowTrafficLightPosition(layout));
}

export function buildDesktopWindowChromeOptions(
  platform: NodeJS.Platform,
): DesktopWindowChromeOptions {
  if (platform !== "darwin") {
    return {};
  }

  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: desktopWindowTrafficLightPosition("expanded"),
  };
}
