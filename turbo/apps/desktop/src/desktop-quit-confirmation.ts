import type { MessageBoxOptions } from "electron";

const QUIT_BUTTON_INDEX = 0;
const CANCEL_BUTTON_INDEX = 1;

interface DesktopQuitConfirmationControllerOptions {
  readonly confirmQuit: () => Promise<boolean>;
  readonly quit: () => void;
}

export class DesktopQuitConfirmationController {
  private quitAllowed = false;
  private pendingConfirmation: Promise<void> | null = null;

  constructor(
    private readonly options: DesktopQuitConfirmationControllerOptions,
  ) {}

  isQuitAllowed(): boolean {
    return this.quitAllowed;
  }

  allowQuitWithoutConfirmation(): void {
    this.quitAllowed = true;
  }

  requestQuit(): Promise<void> {
    if (this.quitAllowed) {
      this.options.quit();
      return Promise.resolve();
    }

    if (this.pendingConfirmation) {
      return this.pendingConfirmation;
    }

    const confirmation = this.options
      .confirmQuit()
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }

        this.quitAllowed = true;
        this.options.quit();
      })
      .finally(() => {
        if (this.pendingConfirmation === confirmation) {
          this.pendingConfirmation = null;
        }
      });
    this.pendingConfirmation = confirmation;
    return confirmation;
  }
}

export function buildDesktopQuitConfirmationOptions(
  displayName: string,
): MessageBoxOptions {
  return {
    type: "question",
    buttons: ["Quit", "Cancel"],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    title: `Quit ${displayName}?`,
    message: `Quit ${displayName}?`,
    detail: "Computer Use will stop running until you reopen the app.",
  };
}

export function isDesktopQuitConfirmed(response: number): boolean {
  return response === QUIT_BUTTON_INDEX;
}
