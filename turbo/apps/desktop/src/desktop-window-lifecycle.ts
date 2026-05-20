interface FocusableWindow {
  readonly isMinimized: () => boolean;
  readonly isVisible: () => boolean;
  readonly restore: () => void;
  readonly show: () => void;
  readonly focus: () => void;
}

export function shouldHideMainWindowOnClose(params: {
  readonly platform: NodeJS.Platform;
  readonly isQuitting: boolean;
}): boolean {
  return params.platform === "darwin" && !params.isQuitting;
}

export function showAndFocusWindow(window: FocusableWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
}
