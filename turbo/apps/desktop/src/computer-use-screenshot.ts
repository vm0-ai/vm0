import { desktopCapturer } from "electron";
import type {
  ComputerUseScreenshotCaptureRequest,
  ComputerUseScreenshotCaptureResult,
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
  return {
    dataUrl: selected.source.thumbnail.toDataURL(),
    source: selected.kind,
    sourceName: selected.source.name,
    width: size.width,
    height: size.height,
  };
}
