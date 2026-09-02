import { z } from "zod";

const DEFAULT_ZOOM = 2;
const EDGE_SNAP_RATIO = 0.25;
const LEAD_IN_MS = 300;
const HOLD_AFTER_CLICK_MS = 2_500;
const TAIL_PADDING_MS = 800;
const LAST_CLICK_PADDING_MS = 1_000;
const MERGE_GAP_MS = 500;
const MAX_GROUP_WIDTH = 0.25;
const MAX_GROUP_HEIGHT = 0.35;
const SPRING_MASS = 2.25;
const SPRING_STIFFNESS = 200;
const SPRING_DAMPING = 40;
const SPRING_PRECISION = 0.002;

const normalizedPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const trackedPointerEventSchema = z
  .object({
    tMs: z.number().int().nonnegative(),
    kind: z.enum(["click", "move"]),
    normalized: normalizedPointSchema,
  })
  .passthrough();

const trackedClickSchema = z
  .object({
    tMs: z.number().int().nonnegative(),
    normalized: normalizedPointSchema,
  })
  .passthrough();

const desktopInputTrackSchema = z
  .object({
    version: z.literal(1),
    recording: z
      .object({
        durationMs: z.number().int().positive(),
        video: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            frameRate: z.number().positive(),
          })
          .passthrough(),
      })
      .passthrough(),
    clicks: z.array(trackedClickSchema).default([]),
    pointerEvents: z.array(trackedPointerEventSchema).optional(),
  })
  .passthrough();

const demoCaptureTrackSchema = z
  .object({
    schemaVersion: z.literal(1),
    session: z
      .object({
        recording: z
          .object({
            durationMs: z.number().positive(),
            goOffsetMs: z.number().default(0),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            frameRate: z.number().positive(),
          })
          .passthrough(),
      })
      .passthrough(),
    events: z.array(z.unknown()),
  })
  .passthrough();

export const inputTrackSchema = z.union([
  desktopInputTrackSchema,
  demoCaptureTrackSchema,
]);

const demoPointerSampleSchema = z
  .object({
    type: z.enum(["pointermove", "pointerdown", "click"]),
    t: z.number().nonnegative(),
    nx: z.number().min(0).max(1),
    ny: z.number().min(0).max(1),
  })
  .passthrough();

const cameraFocusSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const cameraRangeSchema = z
  .object({
    id: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    scale: z.number().min(1).max(4),
    focuses: z.array(cameraFocusSchema).min(1),
  })
  .refine(
    (range) => {
      return range.endMs > range.startMs;
    },
    {
      message: "Camera range endMs must be greater than startMs",
    },
  );

export const cameraPlanSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("screen-studio-compatible-v1"),
    source: z.object({
      durationMs: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      frameRate: z.number().positive().max(240),
    }),
    ranges: z.array(cameraRangeSchema),
  })
  .superRefine((plan, context) => {
    let previousEndMs = 0;
    for (const [rangeIndex, range] of plan.ranges.entries()) {
      if (range.startMs < previousEndMs) {
        context.addIssue({
          code: "custom",
          path: ["ranges", rangeIndex, "startMs"],
          message: "Camera ranges must be ordered and must not overlap",
        });
      }
      if (range.endMs > plan.source.durationMs) {
        context.addIssue({
          code: "custom",
          path: ["ranges", rangeIndex, "endMs"],
          message: "Camera range exceeds the source duration",
        });
      }
      let previousFocusMs = range.startMs;
      for (const [focusIndex, focus] of range.focuses.entries()) {
        if (
          focus.startMs < range.startMs ||
          focus.startMs >= range.endMs ||
          focus.startMs < previousFocusMs
        ) {
          context.addIssue({
            code: "custom",
            path: ["ranges", rangeIndex, "focuses", focusIndex, "startMs"],
            message: "Camera focuses must be ordered and inside their range",
          });
        }
        previousFocusMs = focus.startMs;
      }
      previousEndMs = range.endMs;
    }
  });

type DesktopInputTrack = z.infer<typeof desktopInputTrackSchema>;
type DemoCaptureTrack = z.infer<typeof demoCaptureTrackSchema>;
type InputTrack = z.infer<typeof inputTrackSchema>;
export type CameraPlan = z.infer<typeof cameraPlanSchema>;

export interface VideoSource {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

export interface CameraFrameState {
  readonly timeMs: number;
  readonly scale: number;
  readonly cropWidth: number;
  readonly cropHeight: number;
  readonly cropX: number;
  readonly cropY: number;
}

interface PointerSample {
  readonly tMs: number;
  readonly kind: "click" | "move";
  readonly x: number;
  readonly y: number;
}

interface CameraWindow {
  readonly startMs: number;
  readonly endMs: number;
}

interface PointerGroup {
  count: number;
  firstMs: number;
  maximumX: number;
  maximumY: number;
  minimumX: number;
  minimumY: number;
  totalX: number;
  totalY: number;
}

interface CameraTarget {
  readonly key: string;
  readonly scale: number;
  readonly translationX: number;
  readonly translationY: number;
}

interface CameraTransform {
  readonly scale: number;
  readonly translationX: number;
  readonly translationY: number;
}

function isDemoCaptureTrack(track: InputTrack): track is DemoCaptureTrack {
  return "schemaVersion" in track;
}

function desktopSamples(track: DesktopInputTrack): readonly PointerSample[] {
  const pointerEvents = track.pointerEvents ?? [];
  const samples =
    pointerEvents.length > 0
      ? pointerEvents.map((event) => {
          return {
            tMs: event.tMs,
            kind: event.kind,
            x: event.normalized.x,
            y: event.normalized.y,
          };
        })
      : track.clicks.map((click) => {
          return {
            tMs: click.tMs,
            kind: "click" as const,
            x: click.normalized.x,
            y: click.normalized.y,
          };
        });
  return samples.slice().sort((left, right) => {
    return left.tMs - right.tMs;
  });
}

function demoCaptureSamples(track: DemoCaptureTrack): readonly PointerSample[] {
  const events = track.events.flatMap((rawEvent) => {
    const parsed = demoPointerSampleSchema.safeParse(rawEvent);
    return parsed.success ? [parsed.data] : [];
  });
  const clickType = events.some((event) => {
    return event.type === "pointerdown";
  })
    ? "pointerdown"
    : "click";
  const goOffsetMs = track.session.recording.goOffsetMs;

  return events
    .filter((event) => {
      return event.type === "pointermove" || event.type === clickType;
    })
    .flatMap((event) => {
      const tMs = Math.round(event.t - goOffsetMs);
      if (tMs < 0) {
        return [];
      }
      const kind: PointerSample["kind"] =
        event.type === clickType ? "click" : "move";
      return [{ tMs, kind, x: event.nx, y: event.ny }];
    })
    .sort((left, right) => {
      return left.tMs - right.tMs;
    });
}

function samplesFromTrack(track: InputTrack): readonly PointerSample[] {
  return isDemoCaptureTrack(track)
    ? demoCaptureSamples(track)
    : desktopSamples(track);
}

export function inputTrackClickTimes(track: InputTrack): readonly number[] {
  return samplesFromTrack(track)
    .filter((sample) => {
      return sample.kind === "click";
    })
    .map((sample) => {
      return sample.tMs;
    });
}

export function inputTrackVideoSource(track: InputTrack): VideoSource {
  if (isDemoCaptureTrack(track)) {
    return {
      durationMs: Math.round(track.session.recording.durationMs),
      width: track.session.recording.width,
      height: track.session.recording.height,
      frameRate: track.session.recording.frameRate,
    };
  }
  return {
    durationMs: track.recording.durationMs,
    width: track.recording.video.width,
    height: track.recording.video.height,
    frameRate: track.recording.video.frameRate,
  };
}

function cameraWindows(
  samples: readonly PointerSample[],
  durationMs: number,
): readonly CameraWindow[] {
  const candidates = samples
    .filter((sample) => {
      return (
        sample.kind === "click" &&
        sample.tMs < durationMs - LAST_CLICK_PADDING_MS
      );
    })
    .map((sample) => {
      return {
        startMs: Math.max(1, sample.tMs - LEAD_IN_MS),
        endMs: Math.min(
          durationMs - TAIL_PADDING_MS,
          sample.tMs + HOLD_AFTER_CLICK_MS,
        ),
      };
    })
    .filter((window) => {
      return window.endMs > window.startMs;
    });

  const merged: CameraWindow[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous && candidate.startMs - previous.endMs <= MERGE_GAP_MS) {
      merged[merged.length - 1] = {
        startMs: previous.startMs,
        endMs: Math.max(previous.endMs, candidate.endMs),
      };
    } else {
      merged.push(candidate);
    }
  }
  return merged;
}

function pointerGroup(sample: PointerSample): PointerGroup {
  return {
    count: 1,
    firstMs: sample.tMs,
    maximumX: sample.x,
    maximumY: sample.y,
    minimumX: sample.x,
    minimumY: sample.y,
    totalX: sample.x,
    totalY: sample.y,
  };
}

function focusGroups(
  samples: readonly PointerSample[],
  window: CameraWindow,
  rangeIndex: number,
): CameraPlan["ranges"][number]["focuses"] {
  const inWindow = samples.filter((sample) => {
    return sample.tMs >= window.startMs && sample.tMs < window.endMs;
  });
  const groups: PointerGroup[] = [];

  for (const sample of inWindow) {
    const current = groups.at(-1);
    if (!current) {
      groups.push(pointerGroup(sample));
      continue;
    }
    const minimumX = Math.min(current.minimumX, sample.x);
    const maximumX = Math.max(current.maximumX, sample.x);
    const minimumY = Math.min(current.minimumY, sample.y);
    const maximumY = Math.max(current.maximumY, sample.y);
    if (
      maximumX - minimumX <= MAX_GROUP_WIDTH &&
      maximumY - minimumY <= MAX_GROUP_HEIGHT
    ) {
      current.count += 1;
      current.maximumX = maximumX;
      current.maximumY = maximumY;
      current.minimumX = minimumX;
      current.minimumY = minimumY;
      current.totalX += sample.x;
      current.totalY += sample.y;
    } else {
      groups.push(pointerGroup(sample));
    }
  }

  return groups.map((group, focusIndex) => {
    return {
      id: `camera-${String(rangeIndex + 1).padStart(3, "0")}-focus-${String(
        focusIndex + 1,
      ).padStart(3, "0")}`,
      startMs: focusIndex === 0 ? window.startMs : group.firstMs,
      x: group.totalX / group.count,
      y: group.totalY / group.count,
    };
  });
}

export function createCameraPlan(
  track: InputTrack,
  source: VideoSource,
): CameraPlan {
  const describedSource = inputTrackVideoSource(track);
  if (
    describedSource.width !== source.width ||
    describedSource.height !== source.height
  ) {
    throw new Error("Pointer events do not match the source video dimensions");
  }
  if (Math.abs(describedSource.durationMs - source.durationMs) > 1_000) {
    throw new Error("Pointer events do not match the source video duration");
  }

  const allSamples = samplesFromTrack(track);
  const samples = allSamples.filter((sample) => {
    return sample.tMs <= source.durationMs;
  });
  // A recording with no pointer events legitimately produces no camera moves.
  // Events that all sit outside the recording mean the sidecar's tMs values are
  // not relative to the recording start, which previously produced an empty
  // plan and a silent plain transcode that looked like a successful render.
  if (allSamples.length > 0 && samples.length === 0) {
    const first = allSamples[0];
    const last = allSamples.at(-1);
    throw new Error(
      `Pointer event timestamps are not relative to the recording start: ` +
        `events span ${String(first?.tMs)}ms-${String(last?.tMs)}ms but the ` +
        `recording is ${String(source.durationMs)}ms long. No camera moves ` +
        `can be derived from this sidecar`,
    );
  }
  const ranges = cameraWindows(samples, source.durationMs).map(
    (window, rangeIndex) => {
      return {
        id: `camera-${String(rangeIndex + 1).padStart(3, "0")}`,
        startMs: window.startMs,
        endMs: window.endMs,
        scale: DEFAULT_ZOOM,
        focuses: focusGroups(samples, window, rangeIndex),
      };
    },
  );

  return cameraPlanSchema.parse({
    version: 1,
    algorithm: "screen-studio-compatible-v1",
    source,
    ranges,
  });
}

function snappedPosition(position: number): number {
  if (position < EDGE_SNAP_RATIO) {
    return 0;
  }
  if (position > 1 - EDGE_SNAP_RATIO) {
    return 1;
  }
  return position;
}

function targetAt(plan: CameraPlan, timeMs: number): CameraTarget {
  const range = plan.ranges.find((candidate) => {
    return timeMs >= candidate.startMs && timeMs < candidate.endMs;
  });
  if (!range) {
    return { key: "full-frame", scale: 1, translationX: 0, translationY: 0 };
  }
  let focus: CameraPlan["ranges"][number]["focuses"][number] | undefined;
  for (let index = range.focuses.length - 1; index >= 0; index -= 1) {
    const candidate = range.focuses[index];
    if (candidate && candidate.startMs <= timeMs) {
      focus = candidate;
      break;
    }
  }
  if (!focus) {
    throw new Error(`Camera range ${range.id} has no focus`);
  }
  return {
    key: `${range.id}:${focus.id}`,
    scale: range.scale,
    translationX:
      -plan.source.width * (range.scale - 1) * snappedPosition(focus.x),
    translationY:
      -plan.source.height * (range.scale - 1) * snappedPosition(focus.y),
  };
}

function springProgress(elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return 0;
  }
  const seconds = elapsedMs / 1_000;
  const naturalFrequency = Math.sqrt(SPRING_STIFFNESS / SPRING_MASS);
  const decay = SPRING_DAMPING / (2 * SPRING_MASS);
  const dampedFrequency = Math.sqrt(
    Math.max(0, naturalFrequency * naturalFrequency - decay * decay),
  );
  const response =
    dampedFrequency === 0
      ? 1 - Math.exp(-decay * seconds) * (1 + decay * seconds)
      : 1 -
        Math.exp(-decay * seconds) *
          (Math.cos(dampedFrequency * seconds) +
            (decay / dampedFrequency) * Math.sin(dampedFrequency * seconds));
  if (Math.abs(1 - response) < SPRING_PRECISION) {
    return 1;
  }
  return Math.max(0, Math.min(1, response));
}

export function cameraTransitionMidpointMs(frameRate: number): number {
  const maximumFrames = Math.ceil(frameRate * 2);
  for (let frameIndex = 1; frameIndex <= maximumFrames; frameIndex += 1) {
    const elapsedMs = (frameIndex * 1_000) / frameRate;
    if (springProgress(elapsedMs) >= 0.5) {
      return Math.round(elapsedMs);
    }
  }
  return 250;
}

function interpolate(
  from: CameraTransform,
  to: CameraTarget,
  progress: number,
): CameraTransform {
  return {
    scale: from.scale + (to.scale - from.scale) * progress,
    translationX:
      from.translationX + (to.translationX - from.translationX) * progress,
    translationY:
      from.translationY + (to.translationY - from.translationY) * progress,
  };
}

function commandNumber(value: number): string {
  const rounded = Math.abs(value) < 0.000_000_5 ? 0 : value;
  return rounded.toFixed(6);
}

export function createCameraFrameStates(
  plan: CameraPlan,
): readonly CameraFrameState[] {
  const frameCount = Math.max(
    1,
    Math.ceil((plan.source.durationMs / 1_000) * plan.source.frameRate),
  );
  const initial: CameraTransform = {
    scale: 1,
    translationX: 0,
    translationY: 0,
  };
  let activeTarget = targetAt(plan, 0);
  let transitionStartMs = 0;
  let transitionFrom = initial;
  let current = initial;
  const frames: CameraFrameState[] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeMs = (frameIndex * 1_000) / plan.source.frameRate;
    const target = targetAt(plan, timeMs);
    if (target.key !== activeTarget.key) {
      const progress = springProgress(timeMs - transitionStartMs);
      current = interpolate(transitionFrom, activeTarget, progress);
      transitionFrom = current;
      transitionStartMs = timeMs;
      activeTarget = target;
    }
    current = interpolate(
      transitionFrom,
      activeTarget,
      springProgress(timeMs - transitionStartMs),
    );

    const cropWidth = plan.source.width / current.scale;
    const cropHeight = plan.source.height / current.scale;
    const cropX = Math.max(
      0,
      Math.min(
        plan.source.width - cropWidth,
        -current.translationX / current.scale,
      ),
    );
    const cropY = Math.max(
      0,
      Math.min(
        plan.source.height - cropHeight,
        -current.translationY / current.scale,
      ),
    );
    frames.push({
      timeMs,
      scale: current.scale,
      cropWidth,
      cropHeight,
      cropX,
      cropY,
    });
  }

  return frames;
}

interface CameraSegment {
  readonly startMs: number;
  readonly from: CameraTransform;
  readonly to: CameraTransform;
}

/**
 * The camera is a chain of spring settles: it only changes course when the
 * active focus changes, and coasts on a closed-form spring in between. Walking
 * frames the same way `createCameraFrameStates` does keeps the two in step,
 * but recording just the course changes turns the whole animation into a short
 * piecewise expression instead of one command per frame.
 */
function cameraSegments(plan: CameraPlan): readonly CameraSegment[] {
  const frameCount = Math.max(
    1,
    Math.ceil((plan.source.durationMs / 1_000) * plan.source.frameRate),
  );
  const initial: CameraTransform = {
    scale: 1,
    translationX: 0,
    translationY: 0,
  };
  let activeTarget = targetAt(plan, 0);
  let transitionStartMs = 0;
  let transitionFrom = initial;
  const segments: CameraSegment[] = [
    { startMs: 0, from: initial, to: activeTarget },
  ];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeMs = (frameIndex * 1_000) / plan.source.frameRate;
    const target = targetAt(plan, timeMs);
    if (target.key !== activeTarget.key) {
      const current = interpolate(
        transitionFrom,
        activeTarget,
        springProgress(timeMs - transitionStartMs),
      );
      transitionFrom = current;
      transitionStartMs = timeMs;
      activeTarget = target;
      segments.push({ startMs: timeMs, from: current, to: target });
    }
  }
  return segments;
}

const SPRING_DECAY = SPRING_DAMPING / (2 * SPRING_MASS);
const SPRING_FREQUENCY = Math.sqrt(
  Math.max(0, SPRING_STIFFNESS / SPRING_MASS - SPRING_DECAY * SPRING_DECAY),
);

/** `springProgress` written in ffmpeg expression syntax, over `timeExpression` seconds. */
function springExpression(
  startSeconds: number,
  timeExpression: string,
): string {
  const elapsed = `(${timeExpression}-${commandNumber(startSeconds)})`;
  const response =
    `(1-exp(${commandNumber(-SPRING_DECAY)}*${elapsed})*` +
    `(cos(${commandNumber(SPRING_FREQUENCY)}*${elapsed})+` +
    `${commandNumber(SPRING_DECAY / SPRING_FREQUENCY)}*` +
    `sin(${commandNumber(SPRING_FREQUENCY)}*${elapsed})))`;
  return `if(gt(${response},${commandNumber(1 - SPRING_PRECISION)}),1,max(0,${response}))`;
}

/**
 * Sum of one term per segment. The windows are half-open so exactly one term is
 * ever non-zero, which keeps the expression flat instead of deeply nested.
 */
function piecewiseExpression(
  segments: readonly CameraSegment[],
  select: (transform: CameraTransform) => number,
  timeExpression: string,
  endSeconds: number,
): string {
  return segments
    .map((segment, index) => {
      const startSeconds = segment.startMs / 1_000;
      const next = segments[index + 1];
      const stopSeconds = next ? next.startMs / 1_000 : endSeconds;
      const from = select(segment.from);
      const to = select(segment.to);
      const value =
        from === to
          ? commandNumber(from)
          : `(${commandNumber(from)}+${commandNumber(to - from)}*` +
            `(${springExpression(startSeconds, timeExpression)}))`;
      return (
        `(gte(${timeExpression},${commandNumber(startSeconds)})*` +
        `lt(${timeExpression},${commandNumber(stopSeconds)}))*${value}`
      );
    })
    .join("+");
}

/**
 * Renders the camera move as a single `zoompan` filter.
 *
 * The previous renderer drove `crop` through `sendcmd`, changing the crop
 * width and height every frame. libavfilter cannot resize a filter's output
 * link at runtime, so ffmpeg segfaults as soon as a plan contains an actual
 * zoom; only a pure pan survived. `zoompan` samples a moving window into a
 * fixed output size, so the link geometry never changes.
 */
export function createFfmpegCameraFilter(plan: CameraPlan): string {
  const segments = cameraSegments(plan);
  const endSeconds = plan.source.durationMs / 1_000 + 1;
  const time = `(on/${plan.source.frameRate.toString()})`;
  const zoom = piecewiseExpression(
    segments,
    (transform) => {
      return transform.scale;
    },
    time,
    endSeconds,
  );
  const translationX = piecewiseExpression(
    segments,
    (transform) => {
      return transform.translationX;
    },
    time,
    endSeconds,
  );
  const translationY = piecewiseExpression(
    segments,
    (transform) => {
      return transform.translationY;
    },
    time,
    endSeconds,
  );
  return (
    `zoompan=z='max(1,${zoom})'` +
    `:x='max(0,min(iw-iw/zoom,(0-(${translationX}))/zoom))'` +
    `:y='max(0,min(ih-ih/zoom,(0-(${translationY}))/zoom))'` +
    `:d=1:s=${plan.source.width.toString()}x${plan.source.height.toString()}` +
    `:fps=${plan.source.frameRate.toString()}`
  );
}
