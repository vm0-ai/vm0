import { iosVersionFromUserAgent } from "./browser-support.ts";
import { isStandalonePwa } from "./keyboard-dismiss-gesture.ts";
import {
  captureKeyboardViewportSession,
  type KeyboardViewportCloseSample,
  type KeyboardViewportPage,
} from "./posthog.ts";
import { now } from "./time.ts";

const CLOSE_WINDOW_MS = 1500;
const CLOSE_SAMPLE_INTERVAL_MS = 100;
const CLOSE_SAMPLE_LIMIT = 40;
const RESIDUE_MIN_PX = 24;
const CHAT_COMPOSER_SELECTOR = "[data-chat-composer]";

type KeyboardViewportRecorder = {
  /** The visual viewport settled on an open software keyboard. */
  opened(): void;
  /** The keyboard session ended; sample the visual viewport for a short window. */
  closed(focused: boolean): void;
  /** Drop the current session, for example on orientation change or teardown. */
  clear(): void;
};

interface OpenSession {
  readonly innerHeight: number;
  readonly offsetTop: number;
  readonly openedAt: number;
  readonly viewportHeight: number;
}

interface CloseSession {
  readonly closedAt: number;
  readonly focused: boolean;
  readonly opened: OpenSession;
  readonly scaleAtClose: number;
}

function readPage(): KeyboardViewportPage {
  const path = window.location.pathname;
  if (path.startsWith("/chats/")) {
    return "thread";
  }
  if (/^\/agents\/[^/]+\/chat$/.test(path)) {
    return "home";
  }
  return "other";
}

function readRootPixels(name: string): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function readCloseSample(
  viewport: VisualViewport,
  t: number,
): KeyboardViewportCloseSample {
  const root = document.getElementById("root");
  const composer = document.querySelector(CHAT_COMPOSER_SELECTOR);
  return {
    gap:
      composer instanceof HTMLElement
        ? Math.round(viewport.height - composer.getBoundingClientRect().bottom)
        : null,
    height: Math.round(viewport.height),
    offset: Math.round(viewport.offsetTop),
    root_top: root ? Math.round(root.getBoundingClientRect().top) : null,
    scroll_y: Math.round(window.scrollY),
    t,
  };
}

function sampleChanged(
  sample: KeyboardViewportCloseSample,
  previous: KeyboardViewportCloseSample,
): boolean {
  return (
    sample.offset !== previous.offset ||
    sample.height !== previous.height ||
    sample.scroll_y !== previous.scroll_y ||
    sample.root_top !== previous.root_top
  );
}

/**
 * Records one software-keyboard session on iOS and reports the visual viewport
 * geometry sampled for 1.5s after the keyboard closed. A viewport that stays
 * panned after the close (#32420) shows up as a non-zero offset that never
 * settles inside the window, together with the iOS version, surface, and page
 * it happened on. Sampling runs on animation frames because some builds keep
 * panning the visual viewport after the close without publishing any event.
 */
export function createKeyboardViewportRecorder(
  viewport: VisualViewport,
): KeyboardViewportRecorder {
  let session: OpenSession | null = null;
  let frameId: number | null = null;

  const cancelClose = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  const report = (
    close: CloseSession,
    samples: KeyboardViewportCloseSample[],
    last: KeyboardViewportCloseSample,
  ) => {
    const { closedAt, focused, opened, scaleAtClose } = close;
    const settled = samples.find((sample) => {
      return sample.offset < RESIDUE_MIN_PX;
    });
    captureKeyboardViewportSession({
      close_samples: samples,
      composer_gap_after_close: last.gap,
      focused_at_close: focused,
      inner_height: window.innerHeight,
      ios_version: iosVersionFromUserAgent(navigator.userAgent) ?? "unknown",
      keyboard_occlusion: opened.innerHeight - opened.viewportHeight,
      max_offset_top_after_close: Math.max(
        ...samples.map((sample) => {
          return sample.offset;
        }),
      ),
      offset_top_after_close: last.offset,
      offset_top_at_close: samples[0]?.offset ?? 0,
      offset_top_open: opened.offsetTop,
      page: readPage(),
      referrer_origin: document.referrer
        ? new URL(document.referrer).origin
        : "",
      residue_ms: settled ? settled.t : null,
      root_top_after_close: last.root_top,
      safe_area_bottom: readRootPixels("--sab"),
      safe_area_top: readRootPixels("--sat"),
      scale_at_close: Number(scaleAtClose.toFixed(2)),
      screen_height: window.screen.height,
      session_ms: Math.max(0, Math.round(closedAt - opened.openedAt)),
      standalone: isStandalonePwa(),
      viewport_height_after_close: last.height,
      viewport_height_open: opened.viewportHeight,
    });
  };

  const sampleClose = (opened: OpenSession, focused: boolean) => {
    const close: CloseSession = {
      closedAt: now(),
      focused,
      opened,
      scaleAtClose: viewport.scale,
    };
    let last = readCloseSample(viewport, 0);
    let lastRecordedAt = 0;
    const samples = [last];
    const scheduleSample = () => {
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const t = Math.max(0, Math.round(now() - close.closedAt));
        const sample = readCloseSample(viewport, t);
        if (
          samples.length < CLOSE_SAMPLE_LIMIT &&
          (sampleChanged(sample, last) ||
            t - lastRecordedAt >= CLOSE_SAMPLE_INTERVAL_MS)
        ) {
          samples.push(sample);
          lastRecordedAt = t;
        }
        last = sample;
        if (t >= CLOSE_WINDOW_MS) {
          report(close, samples, last);
          return;
        }
        scheduleSample();
      });
    };
    scheduleSample();
  };

  return {
    opened() {
      cancelClose();
      session = {
        innerHeight: window.innerHeight,
        offsetTop: Math.round(viewport.offsetTop),
        openedAt: now(),
        viewportHeight: Math.round(viewport.height),
      };
    },
    closed(focused) {
      if (!session) {
        return;
      }
      const opened = session;
      session = null;
      cancelClose();
      sampleClose(opened, focused);
    },
    clear() {
      session = null;
      cancelClose();
    },
  };
}
