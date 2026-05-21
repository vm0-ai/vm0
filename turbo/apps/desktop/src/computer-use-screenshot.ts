import { desktopCapturer, screen } from "electron";
import type {
  ComputerUseCoordinateBounds,
  ComputerUseScreenshotCaptureRequest,
  ComputerUseScreenshotCaptureResult,
  ComputerUseWindowCaptureCandidate,
} from "./computer-use-accessibility";

const SCREENSHOT_THUMBNAIL_SIZE = Object.freeze({ width: 1600, height: 1200 });

type DesktopCaptureSource = Awaited<
  ReturnType<typeof desktopCapturer.getSources>
>[number];

function normalizeSourceName(value: string): string {
  return value.trim().toLowerCase();
}

function sourceMatchesCandidate(
  sourceName: string,
  candidate: string,
): boolean {
  const normalizedSource = normalizeSourceName(sourceName);
  const normalizedCandidate = normalizeSourceName(candidate);
  return (
    normalizedSource === normalizedCandidate ||
    normalizedSource.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedSource)
  );
}

function sourceIsWindow(sourceId: string): boolean {
  return sourceId.startsWith("window:");
}

function sourceIsScreen(sourceId: string): boolean {
  return sourceId.startsWith("screen:");
}

function electronBoundsToComputerUseBounds(bounds: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): ComputerUseCoordinateBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function screenSourceBounds(
  source: DesktopCaptureSource,
): ComputerUseCoordinateBounds | undefined {
  const displayId = Number(source.display_id);
  if (!Number.isInteger(displayId)) {
    return undefined;
  }
  const display = screen.getAllDisplays().find((candidate) => {
    return candidate.id === displayId;
  });
  return display
    ? electronBoundsToComputerUseBounds(display.bounds)
    : undefined;
}

function matchingWindowBounds(
  sourceName: string,
  candidates: readonly ComputerUseWindowCaptureCandidate[],
): ComputerUseCoordinateBounds | undefined {
  const matchingCandidate = candidates.find((candidate) => {
    return (
      candidate.bounds !== undefined &&
      sourceMatchesCandidate(sourceName, candidate.name)
    );
  });
  if (matchingCandidate?.bounds) {
    return matchingCandidate.bounds;
  }

  const boundedCandidates = candidates.filter((candidate) => {
    return candidate.bounds !== undefined;
  });
  if (boundedCandidates.length === 1) {
    return boundedCandidates[0]?.bounds;
  }
  return undefined;
}

function sourceBounds(
  selected: {
    readonly source: DesktopCaptureSource;
    readonly kind: "window" | "screen";
  },
  request: ComputerUseScreenshotCaptureRequest,
): ComputerUseCoordinateBounds | undefined {
  if (selected.kind === "screen") {
    return screenSourceBounds(selected.source);
  }
  return matchingWindowBounds(selected.source.name, request.windowBounds);
}

function selectScreenshotSource(
  sources: readonly DesktopCaptureSource[],
  request: ComputerUseScreenshotCaptureRequest,
): {
  readonly source: DesktopCaptureSource;
  readonly kind: "window" | "screen";
} {
  const candidates = [request.app, ...request.windowNames].filter(
    (candidate) => {
      return candidate.trim().length > 0;
    },
  );
  const matchingWindow = sources.find((source) => {
    return (
      sourceIsWindow(source.id) &&
      candidates.some((candidate) => {
        return sourceMatchesCandidate(source.name, candidate);
      })
    );
  });
  if (matchingWindow) {
    return { source: matchingWindow, kind: "window" };
  }

  const firstScreen = sources.find((source) => {
    return sourceIsScreen(source.id);
  });
  if (firstScreen) {
    return { source: firstScreen, kind: "screen" };
  }

  const [firstSource] = sources;
  if (!firstSource) {
    throw new Error("No screenshot sources are available");
  }
  return {
    source: firstSource,
    kind: sourceIsWindow(firstSource.id) ? "window" : "screen",
  };
}

export async function captureComputerUseScreenshot(
  request: ComputerUseScreenshotCaptureRequest,
): Promise<ComputerUseScreenshotCaptureResult> {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: SCREENSHOT_THUMBNAIL_SIZE,
    fetchWindowIcons: false,
  });
  const selected = selectScreenshotSource(sources, request);
  const size = selected.source.thumbnail.getSize();
  const bounds = sourceBounds(selected, request);
  return {
    dataUrl: selected.source.thumbnail.toDataURL(),
    source: selected.kind,
    sourceName: selected.source.name,
    width: size.width,
    height: size.height,
    ...(bounds ? { sourceBounds: bounds } : {}),
  };
}
