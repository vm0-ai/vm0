import { command, computed, state } from "ccstate";
import { localStorageSignals } from "./external/local-storage.ts";
import { isStandaloneMode } from "./zero-page/settings/connectors.ts";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

function detectIOSSafari(): boolean {
  const ua = navigator.userAgent;
  const iosDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iosDevice) {
    return false;
  }
  return /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);
}

const deferredPrompt$ = state<BeforeInstallPromptEvent | null>(null);
const iosModalOpen$ = state(false);

const { get$: dismissedRaw$, set$: setDismissed$ } = localStorageSignals(
  "zero-install-banner-dismissed",
);

export const installBannerVisible$ = computed((get) => {
  if (isStandaloneMode()) {
    return false;
  }
  if (get(dismissedRaw$) !== null) {
    return false;
  }
  if (get(deferredPrompt$)) {
    return true;
  }
  return detectIOSSafari();
});

export const iosInstallModalOpen$ = computed((get) => {
  return get(iosModalOpen$);
});

export const setupInstallPrompt$ = command(({ set }, signal: AbortSignal) => {
  const onPrompt = (e: Event) => {
    e.preventDefault();
    set(deferredPrompt$, e as BeforeInstallPromptEvent);
  };
  const onInstalled = () => {
    set(deferredPrompt$, null);
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  signal.addEventListener("abort", () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  });
});

export const triggerInstall$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const prompt = get(deferredPrompt$);
    if (prompt) {
      await prompt.prompt();
      signal.throwIfAborted();
      await prompt.userChoice;
      signal.throwIfAborted();
      set(deferredPrompt$, null);
      return;
    }
    if (detectIOSSafari()) {
      set(iosModalOpen$, true);
    }
  },
);

export const closeIosInstallModal$ = command(({ set }) => {
  set(iosModalOpen$, false);
});

export const dismissInstallBanner$ = command(({ set }) => {
  set(setDismissed$, "1");
});
