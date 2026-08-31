import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecorderNativeBackend } from "./desktop-recorder-native";

const temporaryDirectories: string[] = [];

/**
 * Stands in for the Swift helper's `serve` mode: reads one JSON request per
 * line and answers with a canned result for that command kind, so the real line
 * protocol and id correlation are exercised without a macOS binary.
 */
async function createServeHelper(
  responsesByKind: Record<string, unknown>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "screen-recorder-helper-"));
  temporaryDirectories.push(dir);
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const responses = ${JSON.stringify(responsesByKind)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      const request = JSON.parse(line);
      const response = responses[request.kind] ?? {
        status: "failed",
        error: { code: "capture_failed", message: "unsupported " + request.kind },
      };
      process.stdout.write(JSON.stringify({ ...response, id: request.id }) + "\\n");
    }
    index = buffer.indexOf("\\n");
  }
});
`,
  );
  await chmod(helperPath, 0o755);
  return helperPath;
}

afterEach(async () => {
  for (const dir of temporaryDirectories.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createRecorderNativeBackend", () => {
  it("lists displays and windows the helper reports", async () => {
    const helperPath = await createServeHelper({
      "recorder.sources": {
        status: "succeeded",
        result: {
          sources: [
            { id: "display:1", kind: "display", title: "Display 1" },
            {
              id: "window:42",
              kind: "window",
              title: "Quarterly planning",
              appName: "Safari",
              bundleId: "com.apple.Safari",
            },
          ],
        },
      },
    });
    const backend = createRecorderNativeBackend({ helperPath });

    await expect(backend.listSources()).resolves.toEqual([
      { id: "display:1", kind: "display", title: "Display 1" },
      {
        id: "window:42",
        kind: "window",
        title: "Quarterly planning",
        appName: "Safari",
        bundleId: "com.apple.Safari",
      },
    ]);
    backend.dispose();
  });

  it("carries the capture geometry through prepare", async () => {
    const helperPath = await createServeHelper({
      "recorder.prepare": {
        status: "succeeded",
        result: {
          sessionId: "recorder-session-1",
          width: 1920,
          height: 1200,
          geometry: {
            originX: 0,
            originY: 0,
            widthPoints: 1512,
            heightPoints: 945,
            scale: 2,
          },
        },
      },
    });
    const backend = createRecorderNativeBackend({ helperPath });

    await expect(
      backend.prepare({
        sourceId: "display:1",
        sourceKind: "display",
        systemAudio: true,
      }),
    ).resolves.toEqual({
      sessionId: "recorder-session-1",
      width: 1920,
      height: 1200,
      geometry: {
        originX: 0,
        originY: 0,
        widthPoints: 1512,
        heightPoints: 945,
        scale: 2,
      },
    });
    backend.dispose();
  });

  it("returns the click track alongside the finished video", async () => {
    const helperPath = await createServeHelper({
      "recorder.stop": {
        status: "succeeded",
        result: {
          videoPath: "/tmp/screen-recording-1.mp4",
          clickTrackPath: "/tmp/screen-recording-1.clicks.json",
          durationMs: 42130,
          sizeBytes: 8_912_345,
          width: 1920,
          height: 1200,
        },
      },
    });
    const backend = createRecorderNativeBackend({ helperPath });

    await expect(backend.stop("recorder-session-1")).resolves.toEqual({
      videoPath: "/tmp/screen-recording-1.mp4",
      clickTrackPath: "/tmp/screen-recording-1.clicks.json",
      durationMs: 42130,
      sizeBytes: 8_912_345,
      width: 1920,
      height: 1200,
    });
    backend.dispose();
  });

  it("reports a capture that lost its source", async () => {
    const helperPath = await createServeHelper({
      "recorder.state": {
        status: "succeeded",
        result: {
          status: "failed",
          elapsedMs: 12_000,
          error: { code: "source_lost", message: "Display disconnected" },
        },
      },
    });
    const backend = createRecorderNativeBackend({ helperPath });

    await expect(backend.getStatus("recorder-session-1")).resolves.toEqual({
      status: "failed",
      elapsedMs: 12_000,
      error: { code: "source_lost", message: "Display disconnected" },
    });
    backend.dispose();
  });

  it("surfaces a refused screen recording permission", async () => {
    const helperPath = await createServeHelper({
      "recorder.sources": {
        status: "failed",
        error: {
          code: "permission_denied",
          message: "Screen recording permission is not granted",
        },
      },
    });
    const backend = createRecorderNativeBackend({ helperPath });

    await expect(backend.listSources()).rejects.toThrow(
      "Screen recording permission is not granted",
    );
    backend.dispose();
  });

  it("rejects an unsupported command instead of resolving it", async () => {
    const helperPath = await createServeHelper({});
    const backend = createRecorderNativeBackend({ helperPath });

    await expect(backend.listSources()).rejects.toThrow(
      "unsupported recorder.sources",
    );
    backend.dispose();
  });

  it("times out a silent helper without killing the in-flight capture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "screen-recorder-helper-"));
    temporaryDirectories.push(dir);
    const helperPath = path.join(dir, "helper");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
`,
    );
    await chmod(helperPath, 0o755);
    const backend = createRecorderNativeBackend({
      helperPath,
      requestTimeoutMs: 50,
    });

    await expect(backend.getStatus("recorder-session-1")).rejects.toThrow(
      "timed out running recorder.state",
    );
    backend.dispose();
  });
});
