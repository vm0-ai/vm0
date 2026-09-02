import { describe, expect, it, vi } from "vitest";

import { scheduleIOSPWAStartupImages } from "../ios-pwa-startup-image.ts";

interface RenderedCanvas {
  readonly background: string;
  readonly height: number;
  readonly width: number;
}

function setupBootstrapAvatar(): HTMLElement {
  document.body.innerHTML = `
    <div class="app-bootstrap-skeleton__avatar">
      <svg
        class="app-bootstrap-skeleton__avatar-layers"
        viewBox="0 0 480 480"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="240" cy="240" r="200" fill="#e88033" />
      </svg>
    </div>
  `;
  for (const link of document.querySelectorAll(
    'link[rel="apple-touch-startup-image"]',
  )) {
    link.remove();
  }
  const avatar = document.querySelector(".app-bootstrap-skeleton__avatar");
  if (!(avatar instanceof HTMLElement)) {
    throw new Error("Test bootstrap avatar is unavailable");
  }
  return avatar;
}

function stubAnimationFrames(): FrameRequestCallback[] {
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return callbacks;
}

function runNextAnimationFrame(callbacks: FrameRequestCallback[]): void {
  const callback = callbacks.shift();
  if (!callback) {
    throw new Error("Expected a pending animation frame");
  }
  callback(performance.now());
}

function stubLoadedImage(): void {
  class LoadedImage {
    decoding = "auto";
    private readonly listeners = new Map<string, () => void>();

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    set src(_value: string) {
      this.listeners.get("load")?.();
    }
  }

  vi.stubGlobal("Image", LoadedImage);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bootstrap-avatar");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
    return undefined;
  });
}

function stubCanvas(): RenderedCanvas[] {
  const rendered: RenderedCanvas[] = [];
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    arc() {},
    beginPath() {},
    clip() {},
    drawImage() {},
    fillRect() {},
    restore() {},
    save() {},
  } as unknown as CanvasRenderingContext2D;

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function getContext(contextId: string) {
      return contextId === "2d" ? context : null;
    } as typeof HTMLCanvasElement.prototype.getContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function toDataURL(this: HTMLCanvasElement) {
      rendered.push({
        background: String(context.fillStyle),
        height: this.height,
        width: this.width,
      });
      return "data:image/png;base64,AAAA";
    },
  );
  return rendered;
}

describe("iOS PWA startup images", () => {
  it("leaves non-Apple browsers free of generated startup images", () => {
    const avatar = setupBootstrapAvatar();
    const frames = stubAnimationFrames();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);

    scheduleIOSPWAStartupImages();

    expect(avatar).not.toHaveClass("app-bootstrap-skeleton__avatar--animated");
    runNextAnimationFrame(frames);
    expect(avatar).not.toHaveClass("app-bootstrap-skeleton__avatar--animated");
    runNextAnimationFrame(frames);

    expect(avatar).toHaveClass("app-bootstrap-skeleton__avatar--animated");
    expect(
      document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
    ).toHaveLength(0);
  });

  it("generates portrait and landscape data URLs for the current iPhone", () => {
    setupBootstrapAvatar();
    const frames = stubAnimationFrames();
    const rendered = stubCanvas();
    stubLoadedImage();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    );
    vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
    vi.spyOn(screen, "width", "get").mockReturnValue(393);
    vi.spyOn(screen, "height", "get").mockReturnValue(852);
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
    document.documentElement.dataset.theme = "dark";

    scheduleIOSPWAStartupImages();
    runNextAnimationFrame(frames);
    runNextAnimationFrame(frames);

    const links = [
      ...document.querySelectorAll<HTMLLinkElement>(
        'link[rel="apple-touch-startup-image"]',
      ),
    ];
    expect(rendered).toStrictEqual([
      { background: "#19191b", height: 2556, width: 1179 },
      { background: "#19191b", height: 1179, width: 2556 },
    ]);
    expect(
      links.map((link) => {
        return { href: link.getAttribute("href"), media: link.media };
      }),
    ).toStrictEqual([
      {
        href: "data:image/png;base64,AAAA",
        media: "screen and (orientation: portrait)",
      },
      {
        href: "data:image/png;base64,AAAA",
        media: "screen and (orientation: landscape)",
      },
    ]);
  });
});
