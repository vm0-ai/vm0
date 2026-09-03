import { createCameraFrameStates } from "./camera-plan";
import type { CameraPlan, CameraFrameState } from "./camera-plan";

const CLICK_BEFORE_MS = 300;
const CLICK_AFTER_MS = [500, 1_500] as const;

export type CameraCheckpointReason =
  | { readonly kind: "click-before"; readonly clickMs: number }
  | { readonly kind: "click"; readonly clickMs: number }
  | {
      readonly kind: "click-after";
      readonly clickMs: number;
      readonly offsetMs: (typeof CLICK_AFTER_MS)[number];
    }
  | { readonly kind: "move-start"; readonly keyId: string }
  | { readonly kind: "move-end"; readonly keyId: string }
  | { readonly kind: "shot-end"; readonly shotId: string }
  | { readonly kind: "maximum-camera-speed" };

export interface CameraReviewCheckpoint {
  readonly id: string;
  readonly timeMs: number;
  readonly reasons: readonly CameraCheckpointReason[];
}

function boundedTime(timeMs: number, plan: CameraPlan): number {
  const lastFrameMs = Math.max(
    0,
    plan.source.durationMs - 1_000 / plan.source.frameRate,
  );
  return Math.round(Math.max(0, Math.min(timeMs, lastFrameMs)));
}

function normalizedCameraSpeed(
  previous: CameraFrameState,
  current: CameraFrameState,
  plan: CameraPlan,
): number {
  const elapsedSeconds = (current.timeMs - previous.timeMs) / 1_000;
  if (elapsedSeconds <= 0) {
    return 0;
  }
  const previousCenterX =
    (previous.cropX + previous.cropWidth / 2) / plan.source.width;
  const previousCenterY =
    (previous.cropY + previous.cropHeight / 2) / plan.source.height;
  const currentCenterX =
    (current.cropX + current.cropWidth / 2) / plan.source.width;
  const currentCenterY =
    (current.cropY + current.cropHeight / 2) / plan.source.height;
  const previousZoom = Math.log(previous.scale);
  const currentZoom = Math.log(current.scale);
  return (
    Math.hypot(
      currentCenterX - previousCenterX,
      currentCenterY - previousCenterY,
      currentZoom - previousZoom,
    ) / elapsedSeconds
  );
}

function maximumCameraSpeedTime(plan: CameraPlan): number | null {
  const frames = createCameraFrameStates(plan);
  let maximumSpeed = 0;
  let maximumTimeMs: number | null = null;
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (!previous || !current) {
      continue;
    }
    const speed = normalizedCameraSpeed(previous, current, plan);
    if (speed > maximumSpeed) {
      maximumSpeed = speed;
      maximumTimeMs = current.timeMs;
    }
  }
  return maximumTimeMs;
}

export function createCameraReviewCheckpoints(
  plan: CameraPlan,
  clickTimes: readonly number[],
): readonly CameraReviewCheckpoint[] {
  const reasonsByTime = new Map<number, CameraCheckpointReason[]>();
  const add = (timeMs: number, reason: CameraCheckpointReason): void => {
    const bounded = boundedTime(timeMs, plan);
    reasonsByTime.set(bounded, [...(reasonsByTime.get(bounded) ?? []), reason]);
  };

  for (const clickMs of clickTimes) {
    if (clickMs > plan.source.durationMs) {
      continue;
    }
    add(clickMs - CLICK_BEFORE_MS, { kind: "click-before", clickMs });
    add(clickMs, { kind: "click", clickMs });
    for (const offsetMs of CLICK_AFTER_MS) {
      add(clickMs + offsetMs, { kind: "click-after", clickMs, offsetMs });
    }
  }

  for (const shot of plan.shots) {
    for (const key of shot.keys) {
      add(Math.max(0, key.startMs), { kind: "move-start", keyId: key.id });
      add(key.startMs + key.durationMs, { kind: "move-end", keyId: key.id });
    }
    if (shot.endMs < plan.source.durationMs) {
      add(shot.endMs, { kind: "shot-end", shotId: shot.id });
    }
  }

  const maximumSpeedTimeMs = maximumCameraSpeedTime(plan);
  if (maximumSpeedTimeMs !== null) {
    add(maximumSpeedTimeMs, { kind: "maximum-camera-speed" });
  }

  return [...reasonsByTime.entries()]
    .sort(([left], [right]) => {
      return left - right;
    })
    .map(([timeMs, reasons], index) => {
      return {
        id: `checkpoint-${String(index + 1).padStart(3, "0")}`,
        timeMs,
        reasons,
      };
    });
}
