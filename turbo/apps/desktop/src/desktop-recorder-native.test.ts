import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecorderNativeBackend } from "./desktop-recorder-native";
import type { RecorderNativeBackend } from "./desktop-recorder-types";

/**
 * How the fake helper answers one request kind.
 *
 * `prelude` is written to stdout before the response, `silent` never answers,
 * and `exit` kills the helper mid-request.
 */
interface HelperBehavior {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
  readonly prelude?: string;
  readonly silent?: boolean;
  readonly exit?: boolean;
  /** Written to stderr first, the way a crashing helper leaves its report. */
  readonly stderr?: string;
  /** Answers only after this long, the way a finalize of a long movie does. */
  readonly delayMs?: number;
}

const SOURCES: HelperBehavior = {
  result: {
    sources: [
      { id: "display:1", kind: "display", title: "Built-in Display" },
      {
        id: "window:42",
        kind: "window",
        title: "Okou",
        appName: "Okou",
        bundleId: "ai.vm0.okou",
      },
    ],
  },
};

const CAPABILITIES: HelperBehavior = {
  result: { supportsMicrophone: true },
};

const PREPARE: HelperBehavior = {
  result: {
    sessionId: "session-1",
    width: 1920,
    height: 1080,
    geometry: {
      originX: 0,
      originY: 25,
      widthPoints: 1512,
      heightPoints: 982,
      scale: 2,
    },
  },
};

const STOP: HelperBehavior = {
  result: {
    videoPath: "/tmp/screen-recording.mp4",
    clickTrackPath: "/tmp/screen-recording.clicks.json",
    durationMs: 4200,
    sizeBytes: 8192,
    width: 1920,
    height: 1080,
  },
};

const createdDirs: string[] = [];
const openBackends: RecorderNativeBackend[] = [];

afterEach(async () => {
  for (const backend of openBackends.splice(0)) {
    backend.dispose();
  }
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createHelper(
  behaviors: Readonly<Record<string, HelperBehavior>>,
): Promise<{ readonly helperPath: string; readonly requestLogPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "screen-recorder-helper-"));
  createdDirs.push(dir);
  const helperPath = path.join(dir, "helper");
  const requestLogPath = path.join(dir, "requests.ndjson");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const behaviors = ${JSON.stringify(behaviors)};
const requestLogPath = ${JSON.stringify(requestLogPath)};
let buffer = "";

function handleLine(line) {
  if (line.trim().length === 0) return;
  const request = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify(request) + "\\n");
  const behavior = behaviors[request.kind];
  if (!behavior) {
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        status: "failed",
        error: { code: "capture_failed", message: "Unsupported " + request.kind }
      }) + "\\n"
    );
    return;
  }
  if (behavior.prelude) process.stdout.write(behavior.prelude);
  if (behavior.stderr) process.stderr.write(behavior.stderr);
  if (behavior.exit) process.exit(1);
  if (behavior.silent) return;
  if (behavior.delayMs) {
    const delayed = { ...behavior, delayMs: 0 };
    setTimeout(() => respond(request, delayed), behavior.delayMs);
    return;
  }
  respond(request, behavior);
}

function respond(request, behavior) {
  if (behavior.error) {
    process.stdout.write(
      JSON.stringify({ id: request.id, status: "failed", error: behavior.error }) + "\\n"
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      id: request.id,
      status: "succeeded",
      result: behavior.result ?? {}
    }) + "\\n"
  );
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    handleLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
  }
});
process.stdin.resume();
`,
  );
  await chmod(helperPath, 0o755);
  return { helperPath, requestLogPath };
}

function createBackend(
  helperPath: string,
  requestTimeoutMs = 5_000,
  stopTimeoutMs?: number,
): RecorderNativeBackend {
  const backend = createRecorderNativeBackend({
    helperPath,
    requestTimeoutMs,
    ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
  });
  openBackends.push(backend);
  return backend;
}

async function readRequests(
  requestLogPath: string,
): Promise<readonly Record<string, unknown>[]> {
  const contents = await readFile(requestLogPath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("area capture", () => {
  it("sends the selected region and reports the cropped geometry", async () => {
    const { helperPath, requestLogPath } = await createHelper({
      "recorder.prepare": {
        result: {
          sessionId: "session-1",
          width: 800,
          height: 400,
          geometry: {
            originX: 1600,
            originY: -100,
            widthPoints: 400,
            heightPoints: 200,
            scale: 2,
          },
        },
      },
    });
    const backend = createBackend(helperPath);

    const prepared = await backend.prepare({
      sourceId: "display:1",
      sourceKind: "area",
      systemAudio: false,
      microphone: false,
      area: { x: 1600, y: -100, width: 400, height: 200 },
    });

    const requests = await readRequests(requestLogPath);
    expect(requests[0]?.payload).toEqual({
      sourceId: "display:1",
      sourceKind: "area",
      systemAudio: false,
      microphone: false,
      area: { x: 1600, y: -100, width: 400, height: 200 },
    });
    // The geometry describes the crop, not the display, so a click track built
    // from it lands in the cropped frame.
    expect(prepared.geometry).toEqual({
      originX: 1600,
      originY: -100,
      widthPoints: 400,
      heightPoints: 200,
      scale: 2,
    });
  });

  it("leaves the area out of a whole-display capture", async () => {
    const { helperPath, requestLogPath } = await createHelper({
      "recorder.prepare": PREPARE,
    });
    const backend = createBackend(helperPath);

    await backend.prepare({
      sourceId: "display:1",
      sourceKind: "display",
      systemAudio: true,
      microphone: false,
    });

    const requests = await readRequests(requestLogPath);
    expect(requests[0]?.payload).not.toHaveProperty("area");
  });
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the request to reject");
}

describe("createRecorderNativeBackend", () => {
  it("carries a full capture session over the helper protocol", async () => {
    const { helperPath, requestLogPath } = await createHelper({
      "recorder.sources": SOURCES,
      "recorder.prepare": PREPARE,
      "recorder.start": {},
      "recorder.stop": STOP,
    });
    const backend = createBackend(helperPath);

    await expect(backend.listSources()).resolves.toMatchObject([
      { id: "display:1", kind: "display", title: "Built-in Display" },
      {
        id: "window:42",
        kind: "window",
        title: "Okou",
        appName: "Okou",
        bundleId: "ai.vm0.okou",
      },
    ]);

    await expect(
      backend.prepare({
        sourceId: "display:1",
        sourceKind: "display",
        systemAudio: true,
        microphone: false,
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      width: 1920,
      height: 1080,
      geometry: {
        originX: 0,
        originY: 25,
        widthPoints: 1512,
        heightPoints: 982,
        scale: 2,
      },
    });

    await backend.start("session-1", "/tmp/screen-recording.mp4");
    await expect(backend.stop("session-1")).resolves.toEqual({
      videoPath: "/tmp/screen-recording.mp4",
      clickTrackPath: "/tmp/screen-recording.clicks.json",
      durationMs: 4200,
      sizeBytes: 8192,
      width: 1920,
      height: 1080,
    });

    const requests = await readRequests(requestLogPath);
    expect(requests.map((request) => request.kind)).toEqual([
      "recorder.sources",
      "recorder.prepare",
      "recorder.start",
      "recorder.stop",
    ]);
    expect(requests[1]?.payload).toEqual({
      sourceId: "display:1",
      sourceKind: "display",
      systemAudio: true,
      microphone: false,
    });
    expect(requests[2]?.payload).toEqual({
      sessionId: "session-1",
      outputPath: "/tmp/screen-recording.mp4",
    });
  });

  it("preserves the helper's failure code and message", async () => {
    const { helperPath } = await createHelper({
      "recorder.prepare": {
        error: {
          code: "permission_denied",
          message: "Screen Recording permission is required",
        },
      },
    });
    const backend = createBackend(helperPath);

    const error = await rejection(
      backend.prepare({
        sourceId: "display:1",
        sourceKind: "display",
        systemAudio: false,
        microphone: false,
      }),
    );

    expect(error).toMatchObject({
      code: "permission_denied",
      message: "Screen Recording permission is required",
    });
  });

  it("falls back to capture_failed for a code the client does not know", async () => {
    const { helperPath } = await createHelper({
      "recorder.sources": {
        error: { code: "moon_phase_wrong", message: "Something went wrong" },
      },
    });
    const backend = createBackend(helperPath);

    expect(await rejection(backend.listSources())).toMatchObject({
      code: "capture_failed",
      message: "Something went wrong",
    });
  });

  it("ignores stdout the helper writes outside the protocol", async () => {
    const { helperPath } = await createHelper({
      "recorder.sources": {
        ...SOURCES,
        prelude: 'ScreenCaptureKit: display reconfigured\n{"truncated":\n',
      },
    });
    const backend = createBackend(helperPath);

    await expect(backend.listSources()).resolves.toHaveLength(2);
  });

  it("rejects a response that is missing a required field", async () => {
    const { helperPath } = await createHelper({
      "recorder.stop": { result: { durationMs: 4200, sizeBytes: 8192 } },
    });
    const backend = createBackend(helperPath);

    expect(await rejection(backend.stop("session-1"))).toMatchObject({
      code: "capture_failed",
      message: "Screen recorder helper returned an invalid videoPath",
    });
  });

  it("rejects capabilities that omit the microphone answer", async () => {
    const { helperPath } = await createHelper({
      "recorder.capabilities": { result: {} },
    });
    const backend = createBackend(helperPath);

    // The helper ships in the same bundle as this code, so a response without
    // the field is a broken helper rather than an older one. Failing here beats
    // silently recording without the narration the user asked for.
    expect(await rejection(backend.getCapabilities())).toMatchObject({
      code: "capture_failed",
      message: "Screen recorder helper returned an invalid supportsMicrophone",
    });
  });

  it("answers what the system can record without reading the screen", async () => {
    const { helperPath, requestLogPath } = await createHelper({
      "recorder.capabilities": CAPABILITIES,
    });
    const backend = createBackend(helperPath);

    await expect(backend.getCapabilities()).resolves.toEqual({
      supportsMicrophone: true,
    });
    // Enumerating sources is what makes the system demand the recording grant,
    // so the bar must be able to open without it.
    const requested = await readFile(requestLogPath, "utf8");
    expect(requested).not.toContain("recorder.sources");
  });

  it("reports a capture that lost its source", async () => {
    const { helperPath } = await createHelper({
      "recorder.state": {
        result: {
          status: "failed",
          elapsedMs: 12_000,
          error: { code: "source_lost", message: "Display disconnected" },
        },
      },
    });
    const backend = createBackend(helperPath);

    await expect(backend.getStatus("session-1")).resolves.toEqual({
      status: "failed",
      elapsedMs: 12_000,
      error: { code: "source_lost", message: "Display disconnected" },
    });
  });

  it("rejects an unknown session status instead of reporting it", async () => {
    const { helperPath } = await createHelper({
      "recorder.state": { result: { status: "wedged", elapsedMs: 1000 } },
    });
    const backend = createBackend(helperPath);

    expect(await rejection(backend.getStatus("session-1"))).toMatchObject({
      code: "capture_failed",
      message: "Screen recorder helper returned an invalid status",
    });
  });

  it("gives stop its own budget so a long finalize is not abandoned", async () => {
    // The helper drains the stream and finalizes the movie inside `stop`,
    // which for a long recording runs well past the ordinary request budget.
    // Timing it out at that budget put the controller back to "recording"
    // while the helper had already stopped, and the session was lost.
    const { helperPath } = await createHelper({
      "recorder.state": {
        delayMs: 800,
        result: { status: "recording", elapsedMs: 1 },
      },
      "recorder.stop": { ...STOP, delayMs: 800 },
    });
    const backend = createBackend(helperPath, 300, 3_000);

    expect(await rejection(backend.getStatus("session-1"))).toMatchObject({
      message: "Screen recorder helper timed out running recorder.state",
    });
    await expect(backend.stop("session-1")).resolves.toMatchObject({
      videoPath: "/tmp/screen-recording.mp4",
    });
  });

  it("carries the writer failure the helper reports on a stopped recording", async () => {
    const { helperPath } = await createHelper({
      "recorder.stop": {
        result: {
          ...STOP.result,
          failure: {
            code: "capture_failed",
            message: "Cannot append sample buffer",
          },
        },
      },
    });
    const backend = createBackend(helperPath);

    await expect(backend.stop("session-1")).resolves.toEqual({
      videoPath: "/tmp/screen-recording.mp4",
      clickTrackPath: "/tmp/screen-recording.clicks.json",
      durationMs: 4200,
      sizeBytes: 8192,
      width: 1920,
      height: 1080,
      failure: {
        code: "capture_failed",
        message: "Cannot append sample buffer",
      },
    });
  });

  it("times out a stalled request but leaves the capture process alive", async () => {
    const { helperPath } = await createHelper({
      "recorder.state": { silent: true },
      "recorder.stop": STOP,
    });
    // Matches the runtime-timeout budget `computer-use-native.test.ts` uses: a
    // tighter one would race the follow-up round trip on a contended runner.
    const backend = createBackend(helperPath, 2_000);

    expect(await rejection(backend.getStatus("session-1"))).toMatchObject({
      code: "capture_failed",
      message: "Screen recorder helper timed out running recorder.state",
    });

    // The helper is deliberately never killed on timeout: it owns the in-flight
    // capture, so the recording must survive one slow command.
    await expect(backend.stop("session-1")).resolves.toMatchObject({
      videoPath: "/tmp/screen-recording.mp4",
    });
  });

  it("rejects in-flight requests when the helper exits", async () => {
    const { helperPath } = await createHelper({
      "recorder.start": { exit: true },
    });
    const backend = createBackend(helperPath);

    expect(
      await rejection(backend.start("session-1", "/tmp/screen-recording.mp4")),
    ).toMatchObject({
      code: "helper_unavailable",
      message: "Screen recorder helper exited with code 1",
    });
  });

  it("carries what the helper wrote to stderr when it dies mid-request", async () => {
    // A helper that crashes leaves its report on stderr. Unread, an exit
    // during a stop was indistinguishable from one that was closed on purpose.
    const { helperPath } = await createHelper({
      "recorder.stop": {
        stderr: "Fatal error: Index out of range\n",
        exit: true,
      },
    });
    const backend = createBackend(helperPath);

    expect(await rejection(backend.stop("session-1"))).toMatchObject({
      code: "helper_unavailable",
      message:
        "Screen recorder helper exited with code 1: Fatal error: Index out of range",
    });
  });

  it("rejects every request once the backend is disposed", async () => {
    const { helperPath } = await createHelper({ "recorder.sources": SOURCES });
    const backend = createBackend(helperPath);
    await backend.listSources();

    backend.dispose();

    expect(await rejection(backend.listSources())).toMatchObject({
      code: "helper_unavailable",
      message: "Screen recorder helper is closed",
    });
  });

  it("reports a missing helper executable as unavailable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "screen-recorder-helper-"));
    createdDirs.push(dir);
    const backend = createBackend(path.join(dir, "absent-helper"));

    expect(await rejection(backend.listSources())).toMatchObject({
      code: "helper_unavailable",
    });
  });
});
