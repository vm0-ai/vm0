import {
  shouldHideMainWindowOnClose,
  showAndFocusWindow,
} from "./desktop-window-lifecycle";
import {
  applyDesktopWindowTrafficLightLayout,
  buildDesktopWindowChromeOptions,
  desktopWindowTrafficLightPosition,
} from "./desktop-window-chrome";

describe("desktop window lifecycle", () => {
  it("uses integrated macOS window chrome", () => {
    expect(buildDesktopWindowChromeOptions("darwin")).toStrictEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    });
  });

  it("keeps non-macOS window chrome default", () => {
    expect(buildDesktopWindowChromeOptions("linux")).toStrictEqual({});
  });

  it("uses a left-aligned traffic light position for the collapsed sidebar", () => {
    expect(desktopWindowTrafficLightPosition("collapsed")).toStrictEqual({
      x: 8,
      y: 18,
    });
  });

  it("updates traffic lights on macOS only", () => {
    const window = {
      setWindowButtonPosition: vi.fn(),
    };

    applyDesktopWindowTrafficLightLayout(window, "darwin", "collapsed");
    expect(window.setWindowButtonPosition).toHaveBeenCalledWith({
      x: 8,
      y: 18,
    });

    applyDesktopWindowTrafficLightLayout(window, "linux", "expanded");
    expect(window.setWindowButtonPosition).toHaveBeenCalledOnce();
  });

  it("hides the main window on macOS close unless the app is quitting", () => {
    expect(
      shouldHideMainWindowOnClose({ platform: "darwin", isQuitting: false }),
    ).toBe(true);
    expect(
      shouldHideMainWindowOnClose({ platform: "darwin", isQuitting: true }),
    ).toBe(false);
    expect(
      shouldHideMainWindowOnClose({ platform: "linux", isQuitting: false }),
    ).toBe(false);
  });

  it("restores, shows, and focuses a hidden minimized window", () => {
    const window = {
      isMinimized: vi.fn(() => {
        return true;
      }),
      isVisible: vi.fn(() => {
        return false;
      }),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    showAndFocusWindow(window);

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("focuses an already visible window without changing visibility", () => {
    const window = {
      isMinimized: vi.fn(() => {
        return false;
      }),
      isVisible: vi.fn(() => {
        return true;
      }),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    showAndFocusWindow(window);

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
