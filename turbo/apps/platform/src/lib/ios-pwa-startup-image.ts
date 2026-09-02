const BOOTSTRAP_AVATAR_SELECTOR = ".app-bootstrap-skeleton__avatar";
const BOOTSTRAP_AVATAR_SVG_SELECTOR = ".app-bootstrap-skeleton__avatar-layers";
const BOOTSTRAP_AVATAR_ANIMATED_CLASS =
  "app-bootstrap-skeleton__avatar--animated";
const STARTUP_IMAGE_REL = "apple-touch-startup-image";
const LIGHT_BACKGROUND = "#fdfdfe";
const DARK_BACKGROUND = "#19191b";
const AVATAR_SIZE_CSS_PX = 64;
const AVATAR_SCALE = 1.25;

interface StartupImageRenderOptions {
  readonly background: string;
  readonly height: number;
  readonly pixelRatio: number;
  readonly width: number;
}

function isAppleTouchDevice(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function renderStartupImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  options: StartupImageRenderOptions,
): string {
  const { background, height, pixelRatio, width } = options;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const avatarSize = AVATAR_SIZE_CSS_PX * pixelRatio;
  const renderedSize = avatarSize * AVATAR_SCALE;
  const centerX = width / 2;
  const centerY = height / 2;

  context.save();
  context.beginPath();
  context.arc(centerX, centerY, avatarSize / 2, 0, Math.PI * 2);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    centerX - renderedSize / 2,
    centerY - renderedSize / 2,
    renderedSize,
    renderedSize,
  );
  context.restore();

  return canvas.toDataURL("image/png");
}

function appendStartupImage(
  orientation: "portrait" | "landscape",
  href: string,
): void {
  const link = document.createElement("link");
  link.rel = STARTUP_IMAGE_REL;
  link.media = `screen and (orientation: ${orientation})`;
  link.href = href;
  document.head.append(link);
}

function generateIOSPWAStartupImages(avatar: SVGSVGElement): void {
  const avatarClone = avatar.cloneNode(true);
  if (!(avatarClone instanceof SVGSVGElement)) {
    throw new Error("Failed to clone the bootstrap avatar SVG");
  }
  avatarClone.setAttribute("width", "480");
  avatarClone.setAttribute("height", "480");
  const serializedAvatar = new XMLSerializer().serializeToString(avatarClone);
  const avatarBlob = new Blob([serializedAvatar], {
    type: "image/svg+xml;charset=utf-8",
  });
  const avatarUrl = URL.createObjectURL(avatarBlob);
  const image = new Image();
  image.decoding = "async";
  image.addEventListener(
    "load",
    () => {
      URL.revokeObjectURL(avatarUrl);

      const pixelRatio = window.devicePixelRatio;
      const portraitWidth = Math.round(
        Math.min(screen.width, screen.height) * pixelRatio,
      );
      const portraitHeight = Math.round(
        Math.max(screen.width, screen.height) * pixelRatio,
      );
      const background =
        document.documentElement.dataset.theme === "dark"
          ? DARK_BACKGROUND
          : LIGHT_BACKGROUND;
      const canvas = document.createElement("canvas");

      appendStartupImage(
        "portrait",
        renderStartupImage(canvas, image, {
          background,
          height: portraitHeight,
          pixelRatio,
          width: portraitWidth,
        }),
      );
      appendStartupImage(
        "landscape",
        renderStartupImage(canvas, image, {
          background,
          height: portraitWidth,
          pixelRatio,
          width: portraitHeight,
        }),
      );

      canvas.width = 0;
      canvas.height = 0;
    },
    { once: true },
  );
  image.addEventListener(
    "error",
    () => {
      URL.revokeObjectURL(avatarUrl);
      throw new Error("Failed to decode the bootstrap avatar SVG");
    },
    { once: true },
  );
  image.src = avatarUrl;
}

export function scheduleIOSPWAStartupImages(): void {
  const avatar = document.querySelector(BOOTSTRAP_AVATAR_SELECTOR);
  const avatarSvg = document.querySelector(BOOTSTRAP_AVATAR_SVG_SELECTOR);
  if (
    !(avatar instanceof HTMLElement) ||
    !(avatarSvg instanceof SVGSVGElement)
  ) {
    throw new Error("Bootstrap avatar is unavailable");
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      avatar.classList.add(BOOTSTRAP_AVATAR_ANIMATED_CLASS);
      if (isAppleTouchDevice()) {
        generateIOSPWAStartupImages(avatarSvg);
      }
    });
  });
}
