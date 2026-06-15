interface FocusableWindow {
  readonly isMinimized: () => boolean;
  readonly isVisible: () => boolean;
  readonly restore: () => void;
  readonly show: () => void;
  readonly focus: () => void;
}

interface DockController {
  readonly hide: () => void;
  readonly show: () => Promise<void>;
}

export function shouldHideMainWindowOnClose(params: {
  readonly platform: NodeJS.Platform;
  readonly isQuitting: boolean;
}): boolean {
  return params.platform === "darwin" && !params.isQuitting;
}

export function hideDockForHiddenMainWindow(params: {
  readonly platform: NodeJS.Platform;
  readonly dock: DockController | null | undefined;
}): void {
  if (params.platform !== "darwin") {
    return;
  }
  params.dock?.hide();
}

export async function showDockForVisibleMainWindow(params: {
  readonly platform: NodeJS.Platform;
  readonly dock: DockController | null | undefined;
}): Promise<void> {
  if (params.platform !== "darwin") {
    return;
  }
  await params.dock?.show();
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
