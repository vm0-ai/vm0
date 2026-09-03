const BOOTSTRAP_CONTENT_CLASS = "app-bootstrap-skeleton__content";
const BOOTSTRAP_AVATAR_CLASS = "app-bootstrap-skeleton__avatar";
const BOOTSTRAP_AVATAR_SVG_CLASS = "app-bootstrap-skeleton__avatar-layers";
const BOOTSTRAP_AVATAR_ANIMATED_CLASS =
  "app-bootstrap-skeleton__avatar--animated";
const STARTUP_IMAGE_REL = "apple-touch-startup-image";
const LIGHT_BACKGROUND = "#fdfdfe";
const DARK_BACKGROUND = "#19191b";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

type StartupImageOrientation = "portrait" | "landscape";

interface StartupImageLayout {
  readonly avatar: DOMRect;
  readonly avatarLayers: DOMRect;
}

interface StartupImageRenderOptions {
  readonly background: string;
  readonly height: number;
  readonly layout: StartupImageLayout;
  readonly pixelRatio: number;
  readonly width: number;
}

function isAppleTouchDevice(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function measureStartupImageLayout(): StartupImageLayout {
  const content = document.createElement("div");
  content.className = BOOTSTRAP_CONTENT_CLASS;
  content.setAttribute("aria-hidden", "true");
  content.inert = true;
  content.style.pointerEvents = "none";
  content.style.visibility = "hidden";

  const avatar = document.createElement("div");
  avatar.className = BOOTSTRAP_AVATAR_CLASS;
  avatar.setAttribute("aria-hidden", "true");

  const avatarLayers = document.createElementNS(SVG_NAMESPACE, "svg");
  avatarLayers.classList.add(BOOTSTRAP_AVATAR_SVG_CLASS);
  avatar.append(avatarLayers);
  content.append(avatar);
  document.body.append(content);

  const layout = {
    avatar: avatar.getBoundingClientRect(),
    avatarLayers: avatarLayers.getBoundingClientRect(),
  };
  content.remove();

  if (
    layout.avatar.width <= 0 ||
    layout.avatar.height <= 0 ||
    layout.avatarLayers.width <= 0 ||
    layout.avatarLayers.height <= 0
  ) {
    throw new Error("Failed to measure the bootstrap avatar layout");
  }
  return layout;
}

function renderStartupImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  options: StartupImageRenderOptions,
): string {
  const { background, height, layout, pixelRatio, width } = options;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const centerX = (layout.avatar.left + layout.avatar.width / 2) * pixelRatio;
  const centerY = (layout.avatar.top + layout.avatar.height / 2) * pixelRatio;
  const clipRadius =
    (Math.min(layout.avatar.width, layout.avatar.height) * pixelRatio) / 2;

  context.save();
  context.beginPath();
  context.arc(centerX, centerY, clipRadius, 0, Math.PI * 2);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    layout.avatarLayers.left * pixelRatio,
    layout.avatarLayers.top * pixelRatio,
    layout.avatarLayers.width * pixelRatio,
    layout.avatarLayers.height * pixelRatio,
  );
  context.restore();

  return canvas.toDataURL("image/png");
}

function updateStartupImage(
  links: Map<StartupImageOrientation, HTMLLinkElement>,
  orientation: StartupImageOrientation,
  href: string,
): void {
  const existingLink = links.get(orientation);
  if (existingLink) {
    existingLink.href = href;
    return;
  }

  const link = document.createElement("link");
  link.rel = STARTUP_IMAGE_REL;
  link.media = `screen and (orientation: ${orientation})`;
  link.href = href;
  links.set(orientation, link);
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
  let avatarUrl: string | null = URL.createObjectURL(avatarBlob);
  const image = new Image();
  const canvas = document.createElement("canvas");
  const orientationQuery = window.matchMedia("(orientation: portrait)");
  const startupImageLinks = new Map<StartupImageOrientation, HTMLLinkElement>();
  let pendingFrameId: number | null = null;
  let cleanedUp = false;

  const releaseAvatarUrl = () => {
    if (avatarUrl === null) {
      return;
    }
    URL.revokeObjectURL(avatarUrl);
    avatarUrl = null;
  };

  function cleanup(): void {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (pendingFrameId !== null) {
      window.cancelAnimationFrame(pendingFrameId);
      pendingFrameId = null;
    }
    releaseAvatarUrl();
    orientationQuery.removeEventListener("change", scheduleCurrentOrientation);
    window.removeEventListener("pagehide", handlePageHide);
    image.removeEventListener("load", handleImageLoad);
    image.removeEventListener("error", handleImageError);
  }

  const renderCurrentOrientation = () => {
    const orientation: StartupImageOrientation = orientationQuery.matches
      ? "portrait"
      : "landscape";
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
    const layout = measureStartupImageLayout();
    const width = orientation === "portrait" ? portraitWidth : portraitHeight;
    const height = orientation === "portrait" ? portraitHeight : portraitWidth;

    updateStartupImage(
      startupImageLinks,
      orientation,
      renderStartupImage(canvas, image, {
        background,
        height,
        layout,
        pixelRatio,
        width,
      }),
    );
    canvas.width = 0;
    canvas.height = 0;
  };

  const scheduleCurrentOrientation = () => {
    if (pendingFrameId !== null) {
      window.cancelAnimationFrame(pendingFrameId);
    }
    pendingFrameId = window.requestAnimationFrame(() => {
      pendingFrameId = null;
      renderCurrentOrientation();
    });
  };

  function handlePageHide(event: PageTransitionEvent): void {
    if (!event.persisted) {
      cleanup();
    }
  }

  function handleImageLoad(): void {
    releaseAvatarUrl();
    orientationQuery.addEventListener("change", scheduleCurrentOrientation);
    renderCurrentOrientation();
  }

  function handleImageError(): void {
    cleanup();
    throw new Error("Failed to decode the bootstrap avatar SVG");
  }

  window.addEventListener("pagehide", handlePageHide);
  image.addEventListener("load", handleImageLoad, { once: true });
  image.addEventListener("error", handleImageError, { once: true });
  image.decoding = "async";
  image.src = avatarUrl;
}

export function scheduleIOSPWAStartupImages(enabled: boolean): void {
  const avatar = document.querySelector(`.${BOOTSTRAP_AVATAR_CLASS}`);
  const avatarSvg = document.querySelector(`.${BOOTSTRAP_AVATAR_SVG_CLASS}`);
  if (
    !(avatar instanceof HTMLElement) ||
    !(avatarSvg instanceof SVGSVGElement)
  ) {
    throw new Error("Bootstrap skeleton is unavailable");
  }

  const useStartupImages = enabled && isAppleTouchDevice();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      avatar.classList.add(BOOTSTRAP_AVATAR_ANIMATED_CLASS);
      if (useStartupImages) {
        generateIOSPWAStartupImages(avatarSvg);
      }
    });
  });
}
