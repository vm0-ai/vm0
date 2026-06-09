import {
  DesktopQuitConfirmationController,
  buildDesktopQuitConfirmationOptions,
  isDesktopQuitConfirmed,
} from "./desktop-quit-confirmation";

interface DeferredQuitConfirmation {
  readonly promise: Promise<boolean>;
  readonly resolve: (confirmed: boolean) => void;
}

function createDeferredQuitConfirmation(): DeferredQuitConfirmation {
  let resolveConfirmation: (confirmed: boolean) => void = () => {
    throw new Error("Quit confirmation resolved before initialization");
  };
  const promise = new Promise<boolean>((resolve) => {
    resolveConfirmation = resolve;
  });
  return { promise, resolve: resolveConfirmation };
}

describe("desktop quit confirmation", () => {
  it("builds a cancel-default quit confirmation dialog", () => {
    expect(
      buildDesktopQuitConfirmationOptions("Zero Computer Use"),
    ).toStrictEqual({
      type: "question",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Quit Zero Computer Use?",
      message: "Quit Zero Computer Use?",
      detail: "Computer Use will stop running until you reopen the app.",
    });
  });

  it("maps the quit button response to confirmed", () => {
    expect(isDesktopQuitConfirmed(0)).toBe(true);
    expect(isDesktopQuitConfirmed(1)).toBe(false);
  });

  it("keeps the app running when the user cancels", async () => {
    const quit = vi.fn();
    const controller = new DesktopQuitConfirmationController({
      confirmQuit: async () => {
        return false;
      },
      quit,
    });

    await controller.requestQuit();

    expect(controller.isQuitAllowed()).toBe(false);
    expect(quit).not.toHaveBeenCalled();
  });

  it("allows quit and calls app quit after confirmation", async () => {
    const quit = vi.fn();
    const controller = new DesktopQuitConfirmationController({
      confirmQuit: async () => {
        return true;
      },
      quit,
    });

    await controller.requestQuit();

    expect(controller.isQuitAllowed()).toBe(true);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent quit confirmations", async () => {
    const confirmation = createDeferredQuitConfirmation();
    const confirmQuit = vi.fn(() => {
      return confirmation.promise;
    });
    const quit = vi.fn();
    const controller = new DesktopQuitConfirmationController({
      confirmQuit,
      quit,
    });

    const firstRequest = controller.requestQuit();
    const secondRequest = controller.requestQuit();

    expect(firstRequest).toBe(secondRequest);
    expect(confirmQuit).toHaveBeenCalledOnce();
    confirmation.resolve(true);
    await firstRequest;

    expect(controller.isQuitAllowed()).toBe(true);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("allows programmatic quit without prompting", async () => {
    const confirmQuit = vi.fn(async () => {
      return true;
    });
    const quit = vi.fn();
    const controller = new DesktopQuitConfirmationController({
      confirmQuit,
      quit,
    });

    controller.allowQuitWithoutConfirmation();
    await controller.requestQuit();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });
});
