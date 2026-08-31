import { BlurManager } from "./blur-manager.ts";
import { OVERLAY_STYLES } from "./overlay-styles.ts";
import type { RecorderStateSnapshot } from "./messages.ts";

export const OVERLAY_HOST_ID = "okou-recorder-overlay";
const COUNTDOWN_SECONDS = 3;
const COUNTDOWN_STEP_MS = 800;

type OverlayMode = "blur" | "countdown" | "hidden" | "ready" | "recording";

interface OverlayCallbacks {
  readonly onCancel: () => void;
  readonly onFinish: () => void;
  readonly onMicrophone: (enabled: boolean) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStart: () => void;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "capture-ended": "Screen sharing stopped, so the recording was finished.",
  "capture-failed": "Chrome could not produce a recording for this tab.",
  "microphone-permission":
    "Chrome blocked microphone access. Allow it in site settings, then try again.",
};

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  node.className = className;
  if (textContent !== undefined) {
    node.textContent = textContent;
  }
  return node;
}

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Renders the recorder controls inside the page being recorded.
 *
 * Everything lives in a closed-styled shadow root so page CSS cannot reach it,
 * and the root layer is `pointer-events: none` so element picking can read the
 * page through it with `document.elementFromPoint`.
 */
export class RecorderOverlay {
  readonly #blur: BlurManager;
  readonly #callbacks: OverlayCallbacks;
  readonly #host: HTMLElement;
  readonly #layer: HTMLElement;
  readonly #root: ShadowRoot;

  readonly #panel: HTMLElement;
  readonly #sourceTitle: HTMLElement;
  readonly #sourceOrigin: HTMLElement;
  readonly #microphoneOption: HTMLButtonElement;
  readonly #microphoneValue: HTMLElement;
  readonly #tabAudioOption: HTMLElement;
  readonly #tabAudioValue: HTMLElement;
  readonly #blurOption: HTMLButtonElement;
  readonly #blurOptionValue: HTMLElement;
  readonly #notice: HTMLElement;

  readonly #blurBar: HTMLElement;
  readonly #blurCount: HTMLElement;
  readonly #blurUndo: HTMLButtonElement;
  readonly #blurNavigate: HTMLButtonElement;
  readonly #highlight: HTMLElement;

  readonly #countdown: HTMLElement;
  readonly #countdownValue: HTMLElement;

  readonly #controller: HTMLElement;
  readonly #elapsed: HTMLElement;
  readonly #pauseResume: HTMLButtonElement;

  #mode: OverlayMode = "hidden";
  #microphone = false;
  #picking = false;
  #countdownTimer: number | null = null;
  #tickTimer: number | null = null;
  #elapsedSeconds = 0;

  constructor(callbacks: OverlayCallbacks) {
    this.#callbacks = callbacks;
    this.#blur = new BlurManager((count) => {
      this.#renderBlurCount(count);
    });

    this.#host = document.createElement("div");
    this.#host.id = OVERLAY_HOST_ID;
    this.#root = this.#host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(OVERLAY_STYLES);
    this.#root.adoptedStyleSheets = [sheet];

    this.#layer = element("div", "layer");
    this.#layer.dataset.mode = "hidden";
    this.#root.append(this.#layer);

    this.#sourceTitle = element("div", "source-title");
    this.#sourceOrigin = element("div", "source-origin");
    this.#microphoneValue = element("span", "option-value", "Off");
    this.#microphoneOption = element("button", "option");
    this.#tabAudioValue = element("span", "option-value", "Off");
    this.#tabAudioOption = element("div", "option");
    this.#blurOptionValue = element("span", "option-value", "None");
    this.#blurOption = element("button", "option");
    this.#notice = element("div", "notice");
    this.#panel = this.#buildPanel();

    this.#blurCount = element("span", "blur-count", "0 blurred");
    this.#blurUndo = element("button", "pill-button", "Undo");
    this.#blurNavigate = element("button", "pill-button", "Navigate");
    this.#blurBar = this.#buildBlurBar();
    this.#highlight = element("div", "highlight");

    this.#countdownValue = element("div", "countdown-value");
    this.#countdown = element("div", "countdown");
    this.#countdown.append(this.#countdownValue);

    this.#elapsed = element("span", "elapsed", "00:00");
    this.#pauseResume = element("button", "pill-button", "Pause");
    this.#controller = this.#buildController();

    this.#layer.append(
      this.#highlight,
      this.#panel,
      this.#blurBar,
      this.#countdown,
      this.#controller,
    );
  }

  get mode(): OverlayMode {
    return this.#mode;
  }

  get blurCount(): number {
    return this.#blur.count;
  }

  mount(): void {
    if (!this.#host.isConnected) {
      document.documentElement.append(this.#host);
    }
  }

  prepare(state: RecorderStateSnapshot): void {
    this.mount();
    this.#microphone = state.microphone;
    this.#sourceTitle.textContent = document.title || location.hostname;
    this.#sourceOrigin.textContent = location.hostname;
    this.#renderOptions(state);
    this.#renderState(state);
  }

  update(state: RecorderStateSnapshot): void {
    this.#microphone = state.microphone;
    this.#renderOptions(state);
    this.#renderState(state);
  }

  showError(code: string): void {
    this.#notice.textContent = ERROR_MESSAGES[code] ?? code;
    this.#notice.hidden = false;
  }

  destroy(): void {
    this.#stopCountdown();
    this.#stopTicking();
    this.#stopPicking();
    this.#blur.destroy();
    this.#host.remove();
    this.#mode = "hidden";
  }

  #buildPanel(): HTMLElement {
    const panel = element("div", "panel");
    const brand = element("div", "brand");
    brand.append(element("span", "brand-dot"), document.createTextNode("Okou"));

    const source = element("div", "source");
    source.append(this.#sourceTitle, this.#sourceOrigin);

    this.#microphoneOption.dataset.option = "microphone";
    this.#microphoneOption.append(
      document.createTextNode("Microphone"),
      this.#microphoneValue,
    );
    this.#microphoneOption.addEventListener("click", () => {
      this.#callbacks.onMicrophone(!this.#microphone);
    });

    this.#tabAudioOption.dataset.interactive = "false";
    this.#tabAudioOption.dataset.option = "tab-audio";
    this.#tabAudioOption.append(
      document.createTextNode("Tab audio"),
      this.#tabAudioValue,
    );

    this.#blurOption.dataset.option = "blur";
    this.#blurOption.append(
      document.createTextNode("Blur elements"),
      this.#blurOptionValue,
    );
    this.#blurOption.addEventListener("click", () => {
      this.#enterBlurMode();
    });

    const options = element("div", "options");
    options.append(
      this.#microphoneOption,
      this.#tabAudioOption,
      this.#blurOption,
    );

    const start = element("button", "primary", "Start recording");
    start.addEventListener("click", () => {
      this.#startCountdown();
    });
    const cancel = element("button", "secondary", "Cancel");
    cancel.addEventListener("click", () => {
      this.#callbacks.onCancel();
    });
    const actions = element("div", "actions");
    actions.append(start, cancel);

    this.#notice.hidden = true;
    panel.append(brand, source, options, this.#notice, actions);
    return panel;
  }

  #buildBlurBar(): HTMLElement {
    const bar = element("div", "blur-bar");
    const hint = element("span", "blur-hint", "Click an element to blur it");

    this.#blurUndo.addEventListener("click", () => {
      this.#blur.undo();
    });
    this.#blurNavigate.dataset.active = "false";
    this.#blurNavigate.addEventListener("click", () => {
      if (this.#picking) {
        this.#stopPicking();
        this.#blurNavigate.dataset.active = "true";
      } else {
        this.#startPicking();
        this.#blurNavigate.dataset.active = "false";
      }
    });
    const done = element("button", "pill-button confirm", "Done");
    done.addEventListener("click", () => {
      this.#exitBlurMode();
    });

    bar.append(hint, this.#blurCount, this.#blurUndo, this.#blurNavigate, done);
    return bar;
  }

  #buildController(): HTMLElement {
    const controller = element("div", "controller");
    controller.dataset.status = "recording";

    this.#pauseResume.addEventListener("click", () => {
      if (this.#pauseResume.textContent === "Pause") {
        this.#callbacks.onPause();
      } else {
        this.#callbacks.onResume();
      }
    });
    const finish = element("button", "pill-button confirm", "Finish");
    finish.addEventListener("click", () => {
      this.#callbacks.onFinish();
    });
    const discard = element("button", "pill-button", "Discard");
    discard.addEventListener("click", () => {
      this.#callbacks.onCancel();
    });

    controller.append(
      element("span", "recording-dot"),
      this.#elapsed,
      this.#pauseResume,
      finish,
      discard,
    );
    return controller;
  }

  #setMode(mode: OverlayMode): void {
    this.#mode = mode;
    this.#layer.dataset.mode = mode;
    this.#panel.hidden = mode !== "ready";
    this.#blurBar.hidden = mode !== "blur";
    this.#countdown.hidden = mode !== "countdown";
    this.#controller.hidden = mode !== "recording";
    if (mode !== "blur") {
      this.#stopPicking();
    }
  }

  #renderOptions(state: RecorderStateSnapshot): void {
    this.#microphoneOption.dataset.active = String(state.microphone);
    this.#microphoneValue.textContent = state.microphone ? "On" : "Off";
    this.#tabAudioOption.dataset.active = String(state.tabAudio);
    this.#tabAudioValue.textContent = state.tabAudio ? "On" : "Off";
    this.#renderBlurCount(this.#blur.count);
  }

  #renderBlurCount(count: number): void {
    this.#blurOptionValue.textContent =
      count === 0 ? "None" : `${count} blurred`;
    this.#blurCount.textContent = `${count} blurred`;
    this.#blurUndo.disabled = count === 0;
    this.#blurOption.dataset.active = String(count > 0);
  }

  #renderState(state: RecorderStateSnapshot): void {
    this.#elapsedSeconds = state.elapsedSeconds;
    this.#elapsed.textContent = formatElapsed(state.elapsedSeconds);
    this.#controller.dataset.status = state.status;
    this.#pauseResume.textContent =
      state.status === "paused" ? "Resume" : "Pause";
    this.#pauseResume.disabled = state.status === "finalizing";

    if (state.status === "ready") {
      if (this.#mode !== "blur" && this.#mode !== "countdown") {
        this.#setMode("ready");
      }
      this.#stopTicking();
      return;
    }
    this.#setMode("recording");
    if (state.status === "recording") {
      this.#startTicking();
    } else {
      this.#stopTicking();
    }
  }

  #startTicking(): void {
    if (this.#tickTimer !== null) {
      return;
    }
    this.#tickTimer = window.setInterval(() => {
      this.#elapsedSeconds += 1;
      this.#elapsed.textContent = formatElapsed(this.#elapsedSeconds);
    }, 1000);
  }

  #stopTicking(): void {
    if (this.#tickTimer !== null) {
      window.clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
  }

  #enterBlurMode(): void {
    this.#setMode("blur");
    this.#startPicking();
  }

  #exitBlurMode(): void {
    this.#setMode("ready");
  }

  #startCountdown(): void {
    this.#setMode("countdown");
    let remaining = COUNTDOWN_SECONDS;
    this.#countdownValue.textContent = String(remaining);
    this.#countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        this.#countdownValue.textContent = String(remaining);
        return;
      }
      this.#stopCountdown();
      this.#setMode("recording");
      this.#callbacks.onStart();
    }, COUNTDOWN_STEP_MS);
  }

  #stopCountdown(): void {
    if (this.#countdownTimer !== null) {
      window.clearInterval(this.#countdownTimer);
      this.#countdownTimer = null;
    }
  }

  readonly #onPointerMove = (event: MouseEvent): void => {
    const target = this.#elementUnderPointer(event);
    if (!target) {
      this.#highlight.dataset.visible = "false";
      return;
    }
    const box = target.getBoundingClientRect();
    this.#highlight.dataset.visible = "true";
    this.#highlight.style.left = `${box.left}px`;
    this.#highlight.style.top = `${box.top}px`;
    this.#highlight.style.width = `${box.width}px`;
    this.#highlight.style.height = `${box.height}px`;
  };

  readonly #onPointerDown = (event: MouseEvent): void => {
    const target = this.#elementUnderPointer(event);
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#blur.add(target);
    this.#highlight.dataset.visible = "false";
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.#exitBlurMode();
    }
  };

  #elementUnderPointer(event: MouseEvent): HTMLElement | null {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (
      !(target instanceof HTMLElement) ||
      target === this.#host ||
      target === document.body ||
      target === document.documentElement ||
      this.#blur.has(target)
    ) {
      return null;
    }
    return target;
  }

  #startPicking(): void {
    if (this.#picking) {
      return;
    }
    this.#picking = true;
    document.addEventListener("mousemove", this.#onPointerMove, true);
    document.addEventListener("click", this.#onPointerDown, true);
    document.addEventListener("keydown", this.#onKeyDown, true);
  }

  #stopPicking(): void {
    if (!this.#picking) {
      return;
    }
    this.#picking = false;
    this.#highlight.dataset.visible = "false";
    document.removeEventListener("mousemove", this.#onPointerMove, true);
    document.removeEventListener("click", this.#onPointerDown, true);
    document.removeEventListener("keydown", this.#onKeyDown, true);
  }
}
