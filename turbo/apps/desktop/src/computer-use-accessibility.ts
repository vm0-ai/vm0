import type { ComputerUsePermissionState } from "./computer-use-types";
import {
  ComputerUseNativeHelperError,
  createComputerUseNativeBackend,
  type ComputerUseNativeBackend,
  type ComputerUseNativePressKeyRequest,
} from "./computer-use-native";

export const SUPPORTED_COMPUTER_USE_CAPABILITIES = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

export type ComputerUseCommandKind =
  (typeof SUPPORTED_COMPUTER_USE_CAPABILITIES)[number];

export interface ComputerUseCommand {
  readonly id: string;
  readonly kind: ComputerUseCommandKind;
  readonly payload: Record<string, unknown>;
}

export interface AccessibilityElementSnapshot {
  readonly id: string;
  readonly role?: string;
  readonly roleDescription?: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly actions?: readonly string[];
  readonly bounds?: ComputerUseCoordinateBounds;
  readonly children?: readonly AccessibilityElementSnapshot[];
}

export interface AccessibilityAppStateSnapshot {
  readonly app: string;
  readonly snapshotId: string;
  readonly elements: readonly AccessibilityElementSnapshot[];
  readonly nodeCount?: number;
  readonly truncated?: boolean;
  readonly truncationReasons?: readonly string[];
}

interface AccessibilitySnapshotOutputLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxChildrenPerNode: number;
}

export const ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS =
  Object.freeze<AccessibilitySnapshotOutputLimits>({
    maxDepth: 24,
    maxNodes: 700,
    maxChildrenPerNode: 120,
  });

const GENERIC_WRAPPER_ROLES = new Set(["AXGroup", "AXUnknown"]);

export interface ComputerUseScreenshotCaptureRequest {
  readonly app: string;
  readonly windowNames: readonly string[];
  readonly windowBounds: readonly ComputerUseWindowCaptureCandidate[];
}

export interface ComputerUseScreenshotCaptureResult {
  readonly dataUrl: string;
  readonly source: "window" | "screen";
  readonly sourceName: string;
  readonly width: number;
  readonly height: number;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
}

type ComputerUseScreenshotCapture = (
  request: ComputerUseScreenshotCaptureRequest,
) => Promise<ComputerUseScreenshotCaptureResult>;

export interface ComputerUseCommandSuccess {
  readonly status: "succeeded";
  readonly result: Record<string, unknown>;
}

export interface ComputerUseCommandFailure {
  readonly status: "failed";
  readonly error: {
    readonly code:
      | "permission_denied"
      | "accessibility_unavailable"
      | "screen_recording_unavailable"
      | "app_not_found"
      | "app_open_failed"
      | "unsupported_command";
    readonly message: string;
  };
}

export type ComputerUseCommandExecutionResult =
  | ComputerUseCommandSuccess
  | ComputerUseCommandFailure;

export interface ComputerUseCoordinateBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComputerUseWindowCaptureCandidate {
  readonly name: string;
  readonly bounds?: ComputerUseCoordinateBounds;
}

interface ComputerUseSnapshotMetadata {
  readonly app: string;
  readonly snapshotId: string;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly screenshotSource: "window" | "screen";
  readonly screenshotSourceName: string;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
}

export type ComputerUseMouseButton = "left" | "right" | "middle";

interface ComputerUseCommandExecutionDependencies {
  readonly captureScreenshot: ComputerUseScreenshotCapture;
  readonly snapshotStore?: ComputerUseSnapshotStore;
  readonly platform?: NodeJS.Platform;
  readonly nativeBackend?: ComputerUseNativeBackend;
}

const DEFAULT_SNAPSHOT_STORE_LIMIT = 50;
const CG_EVENT_FLAG_SHIFT = 131_072;
const CG_EVENT_FLAG_CONTROL = 262_144;
const CG_EVENT_FLAG_OPTION = 524_288;
const CG_EVENT_FLAG_COMMAND = 1_048_576;

type ComputerUseKeyModifier = "command" | "control" | "option" | "shift";

interface ComputerUseModifierDefinition {
  readonly name: ComputerUseKeyModifier;
  readonly displayName: string;
  readonly keyCode: number;
  readonly flag: number;
}

interface ParsedComputerUseKeyPress {
  readonly keyCode: number;
  readonly modifiers: readonly {
    readonly keyCode: number;
    readonly flag: number;
  }[];
  readonly flags: number;
  readonly normalizedKey: string;
}

const MODIFIER_DEFINITIONS: readonly ComputerUseModifierDefinition[] = [
  {
    name: "command",
    displayName: "Command",
    keyCode: 55,
    flag: CG_EVENT_FLAG_COMMAND,
  },
  {
    name: "control",
    displayName: "Control",
    keyCode: 59,
    flag: CG_EVENT_FLAG_CONTROL,
  },
  {
    name: "option",
    displayName: "Option",
    keyCode: 58,
    flag: CG_EVENT_FLAG_OPTION,
  },
  {
    name: "shift",
    displayName: "Shift",
    keyCode: 56,
    flag: CG_EVENT_FLAG_SHIFT,
  },
] as const;

const MODIFIER_ALIASES: Readonly<Record<string, ComputerUseKeyModifier>> =
  Object.freeze({
    alt: "option",
    cmd: "command",
    command: "command",
    control: "control",
    ctrl: "control",
    meta: "command",
    option: "option",
    shift: "shift",
    super: "command",
  });

const KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
  "'": 39,
  ",": 43,
  "-": 27,
  ".": 47,
  "/": 44,
  "0": 29,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "5": 23,
  "6": 22,
  "7": 26,
  "8": 28,
  "9": 25,
  ";": 41,
  "=": 24,
  "[": 33,
  "\\": 42,
  "]": 30,
  "`": 50,
  a: 0,
  b: 11,
  backspace: 51,
  c: 8,
  d: 2,
  delete: 51,
  down: 125,
  downarrow: 125,
  e: 14,
  end: 119,
  enter: 36,
  esc: 53,
  escape: 53,
  f: 3,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  forwarddelete: 117,
  g: 5,
  h: 4,
  home: 115,
  i: 34,
  j: 38,
  k: 40,
  l: 37,
  left: 123,
  leftarrow: 123,
  m: 46,
  n: 45,
  o: 31,
  p: 35,
  pagedown: 121,
  pageup: 116,
  q: 12,
  r: 15,
  return: 36,
  right: 124,
  rightarrow: 124,
  s: 1,
  space: 49,
  spacebar: 49,
  t: 17,
  tab: 48,
  u: 32,
  up: 126,
  uparrow: 126,
  v: 9,
  w: 13,
  x: 7,
  y: 16,
  z: 6,
});

const KEY_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  backspace: "Backspace",
  delete: "Backspace",
  down: "Down",
  downarrow: "Down",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  forwarddelete: "ForwardDelete",
  left: "Left",
  leftarrow: "Left",
  pagedown: "PageDown",
  pageup: "PageUp",
  return: "Return",
  right: "Right",
  rightarrow: "Right",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  up: "Up",
  uparrow: "Up",
});

class UnsupportedComputerUseCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedComputerUseCommandError";
  }
}

function appSnapshotKey(app: string): string {
  return app.trim().toLowerCase();
}

export class ComputerUseSnapshotStore {
  private readonly snapshots = new Map<string, ComputerUseSnapshotMetadata>();
  private readonly latestByApp = new Map<string, string>();

  constructor(private readonly maxEntries = DEFAULT_SNAPSHOT_STORE_LIMIT) {}

  set(metadata: ComputerUseSnapshotMetadata): void {
    const key = this.key(metadata.app, metadata.snapshotId);
    if (this.snapshots.has(key)) {
      this.snapshots.delete(key);
    }
    this.snapshots.set(key, metadata);
    this.latestByApp.set(appSnapshotKey(metadata.app), key);

    while (this.snapshots.size > this.maxEntries) {
      const oldestKey = this.snapshots.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.snapshots.delete(oldestKey);
      for (const [appKey, snapshotKey] of this.latestByApp) {
        if (snapshotKey === oldestKey) {
          this.latestByApp.delete(appKey);
        }
      }
    }
  }

  get(app: string, snapshotId: string): ComputerUseSnapshotMetadata | null {
    return this.snapshots.get(this.key(app, snapshotId)) ?? null;
  }

  getLatestForApp(app: string): ComputerUseSnapshotMetadata | null {
    const key = this.latestByApp.get(appSnapshotKey(app));
    return key ? (this.snapshots.get(key) ?? null) : null;
  }

  private key(app: string, snapshotId: string): string {
    return `${appSnapshotKey(app)}\0${snapshotId}`;
  }
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function payloadNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadMouseButton(
  payload: Record<string, unknown>,
): ComputerUseMouseButton {
  const value = payload.button;
  if (value === "right" || value === "middle") {
    return value;
  }
  return "left";
}

function payloadClickCount(payload: Record<string, unknown>): number {
  const value = payload.clickCount;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 3
    ? value
    : 1;
}

function snapshotId(): string {
  return `desktop_${Date.now().toString(36)}`;
}

function requireAccessibility(
  permissions: ComputerUsePermissionState,
  platform: NodeJS.Platform,
): ComputerUseCommandFailure | null {
  if (platform !== "darwin") {
    return {
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: "Desktop Computer Use is currently implemented for macOS",
      },
    };
  }
  if (!permissions.accessibility) {
    return {
      status: "failed",
      error: {
        code: "permission_denied",
        message: "macOS Accessibility permission is required",
      },
    };
  }
  return null;
}

function requireScreenRecording(
  permissions: ComputerUsePermissionState,
): ComputerUseCommandFailure | null {
  if (!permissions.screenRecording) {
    return {
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    };
  }
  return null;
}

function stringHasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function elementIsWebArea(element: AccessibilityElementSnapshot): boolean {
  return (
    element.role === "AXWebArea" ||
    element.roleDescription?.toLowerCase().includes("html") === true
  );
}

function elementHasMeaningfulContent(
  element: AccessibilityElementSnapshot,
): boolean {
  return (
    stringHasValue(element.name) ||
    stringHasValue(element.value) ||
    stringHasValue(element.description) ||
    element.focused === true ||
    element.enabled === false ||
    (element.actions !== undefined && element.actions.length > 0)
  );
}

function shouldElideElement(
  element: AccessibilityElementSnapshot,
  childCount: number,
  inWebArea: boolean,
): boolean {
  if (!element.role || !GENERIC_WRAPPER_ROLES.has(element.role)) {
    return false;
  }
  if (elementHasMeaningfulContent(element)) {
    return false;
  }
  if (inWebArea && childCount > 1) {
    return false;
  }
  return true;
}

function pushUniqueReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function normalizeAccessibilitySnapshot(
  snapshot: AccessibilityAppStateSnapshot,
  limits: AccessibilitySnapshotOutputLimits = ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
): AccessibilityAppStateSnapshot {
  let nodeCount = 0;
  const truncationReasons: string[] = [];

  const normalizeElement = (
    element: AccessibilityElementSnapshot,
    depth: number,
    inWebArea: boolean,
  ): AccessibilityElementSnapshot[] => {
    if (depth > limits.maxDepth) {
      pushUniqueReason(truncationReasons, "max_depth");
      return [];
    }

    const nextInWebArea = inWebArea || elementIsWebArea(element);
    const rawChildren = element.children ?? [];
    const childEntries = rawChildren.slice(0, limits.maxChildrenPerNode);
    if (rawChildren.length > childEntries.length) {
      pushUniqueReason(truncationReasons, "max_children_per_node");
    }

    const elide = shouldElideElement(element, rawChildren.length, inWebArea);
    if (!elide) {
      if (nodeCount >= limits.maxNodes) {
        pushUniqueReason(truncationReasons, "max_nodes");
        return [];
      }
      nodeCount += 1;
    }

    const children: AccessibilityElementSnapshot[] = [];
    for (const child of childEntries) {
      if (nodeCount >= limits.maxNodes) {
        pushUniqueReason(truncationReasons, "max_nodes");
        break;
      }
      children.push(...normalizeElement(child, depth + 1, nextInWebArea));
    }

    if (elide) {
      return children;
    }

    return [
      {
        ...element,
        children: children.length > 0 ? children : undefined,
      },
    ];
  };

  const elements = snapshot.elements.flatMap((element) => {
    return normalizeElement(element, 0, false);
  });

  const combinedReasons = [
    ...(snapshot.truncationReasons ?? []),
    ...truncationReasons,
  ];

  return {
    ...snapshot,
    elements,
    nodeCount,
    truncated:
      snapshot.truncated === true ||
      combinedReasons.length > 0 ||
      snapshot.nodeCount !== undefined
        ? snapshot.truncated === true || combinedReasons.length > 0
        : undefined,
    truncationReasons:
      combinedReasons.length > 0
        ? [...new Set(combinedReasons)]
        : snapshot.truncationReasons,
  };
}

function normalizeKeyToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]+/g, "");
}

function displayKeyToken(token: string): string {
  if (KEY_DISPLAY_NAMES[token]) {
    return KEY_DISPLAY_NAMES[token];
  }
  if (/^f\d{1,2}$/.test(token)) {
    return token.toUpperCase();
  }
  if (token.length === 1) {
    return token.toUpperCase();
  }
  return token;
}

function unsupportedCommand(message: string): ComputerUseCommandFailure {
  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message,
    },
  };
}

function missingField(field: string): ComputerUseCommandFailure {
  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: `Missing required payload field: ${field}`,
    },
  };
}

function parseComputerUseKeyPress(key: string): ParsedComputerUseKeyPress {
  const rawParts = key.split("+").map((part) => {
    return part.trim();
  });
  if (
    rawParts.length === 0 ||
    rawParts.some((part) => {
      return part.length === 0;
    })
  ) {
    throw new UnsupportedComputerUseCommandError(
      "keyboard.press_key requires a non-empty key or key combination",
    );
  }

  const modifiers = new Set<ComputerUseKeyModifier>();
  let keyCode: number | null = null;
  let displayKey: string | null = null;

  for (const rawPart of rawParts) {
    const token = normalizeKeyToken(rawPart);
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }

    const code = KEY_CODES[token];
    if (code === undefined) {
      throw new UnsupportedComputerUseCommandError(
        `Unsupported key specification: ${rawPart}`,
      );
    }
    if (keyCode !== null) {
      throw new UnsupportedComputerUseCommandError(
        "keyboard.press_key supports exactly one non-modifier key",
      );
    }
    keyCode = code;
    displayKey = displayKeyToken(token);
  }

  if (keyCode === null || displayKey === null) {
    throw new UnsupportedComputerUseCommandError(
      "keyboard.press_key requires a non-modifier key",
    );
  }

  const activeModifiers = MODIFIER_DEFINITIONS.filter((modifier) => {
    return modifiers.has(modifier.name);
  });
  return {
    keyCode,
    modifiers: activeModifiers.map((modifier) => {
      return {
        keyCode: modifier.keyCode,
        flag: modifier.flag,
      };
    }),
    flags: activeModifiers.reduce((flags, modifier) => {
      return flags | modifier.flag;
    }, 0),
    normalizedKey: [
      ...activeModifiers.map((modifier) => {
        return modifier.displayName;
      }),
      displayKey,
    ].join("+"),
  };
}

export function renderAccessibilityTree(
  snapshot: AccessibilityAppStateSnapshot,
): string {
  const lines = [`snapshot_id=${snapshot.snapshotId}`, `app=${snapshot.app}`];

  const visit = (
    element: AccessibilityElementSnapshot,
    depth: number,
  ): void => {
    const indent = "  ".repeat(depth);
    const label = [
      element.id,
      element.role,
      element.name ? `"${element.name}"` : null,
      element.value ? `value="${element.value}"` : null,
      element.actions && element.actions.length > 0
        ? `actions=${element.actions.join(",")}`
        : null,
    ]
      .filter((part): part is string => {
        return part !== null && part !== undefined;
      })
      .join(" ");
    lines.push(`${indent}${label}`);
    for (const child of element.children ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const element of snapshot.elements) {
    visit(element, 0);
  }
  return lines.join("\n");
}

function snapshotWindowNames(
  snapshot: AccessibilityAppStateSnapshot,
): string[] {
  return snapshotWindowCaptureCandidates(snapshot).map((window) => {
    return window.name;
  });
}

function snapshotWindowCaptureCandidates(
  snapshot: AccessibilityAppStateSnapshot,
): ComputerUseWindowCaptureCandidate[] {
  return snapshot.elements
    .map((element): ComputerUseWindowCaptureCandidate | null => {
      const name = element.name?.trim();
      if (!name) {
        return null;
      }
      return {
        name,
        ...(element.bounds ? { bounds: element.bounds } : {}),
      };
    })
    .filter((window): window is ComputerUseWindowCaptureCandidate => {
      return window !== null;
    });
}

function buildComputerUseAppStateResult(
  snapshot: AccessibilityAppStateSnapshot,
  screenshot: ComputerUseScreenshotCaptureResult,
): Record<string, unknown> {
  return {
    ...snapshot,
    text: renderAccessibilityTree(snapshot),
    screenshot: screenshot.dataUrl,
    screenshotMimeType: "image/png",
    screenshotSource: screenshot.source,
    screenshotSourceName: screenshot.sourceName,
    screenshotWidth: screenshot.width,
    screenshotHeight: screenshot.height,
    ...(screenshot.sourceBounds
      ? { screenshotSourceBounds: screenshot.sourceBounds }
      : {}),
  };
}

async function listApps(
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const apps = [...(await nativeBackend.listApps())].sort();
  return { status: "succeeded", result: { apps, text: apps.join("\n") } };
}

async function getAppState(
  app: string,
  nativeBackend: ComputerUseNativeBackend,
  captureScreenshot: ComputerUseScreenshotCapture,
  snapshotStore: ComputerUseSnapshotStore,
): Promise<ComputerUseCommandExecutionResult> {
  const id = snapshotId();
  const snapshot = normalizeAccessibilitySnapshot(
    await nativeBackend.getAppState(app, id),
  );
  const windowBounds = snapshotWindowCaptureCandidates(snapshot);
  let screenshot: ComputerUseScreenshotCaptureResult;
  try {
    screenshot = await captureScreenshot({
      app,
      windowNames: snapshotWindowNames(snapshot),
      windowBounds,
    });
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  snapshotStore.set({
    app: snapshot.app,
    snapshotId: snapshot.snapshotId,
    screenshotWidth: screenshot.width,
    screenshotHeight: screenshot.height,
    screenshotSource: screenshot.source,
    screenshotSourceName: screenshot.sourceName,
    ...(screenshot.sourceBounds
      ? { sourceBounds: screenshot.sourceBounds }
      : {}),
  });
  return {
    status: "succeeded",
    result: buildComputerUseAppStateResult(snapshot, screenshot),
  };
}

async function openApp(
  app: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.openApp(app);
  return {
    status: "succeeded",
    result: {
      app,
      dispatchMode: "app_activation",
      dispatchTarget: "target_app",
      inputRisk: "activates_app",
      text: `Opened ${app}`,
    },
  };
}

function roundScreenCoordinate(value: number): number {
  return Number(value.toFixed(2));
}

function mapScreenshotPointToScreen(args: {
  readonly metadata: ComputerUseSnapshotMetadata;
  readonly x: number;
  readonly y: number;
}):
  | { readonly screenX: number; readonly screenY: number }
  | ComputerUseCommandFailure {
  const { metadata } = args;
  if (!metadata.sourceBounds) {
    return unsupportedCommand(
      `Snapshot source bounds are unavailable: ${metadata.snapshotId}`,
    );
  }
  if (metadata.screenshotWidth <= 0 || metadata.screenshotHeight <= 0) {
    return unsupportedCommand(
      `Snapshot dimensions are invalid: ${metadata.snapshotId}`,
    );
  }

  return {
    screenX: roundScreenCoordinate(
      metadata.sourceBounds.x +
        (args.x / metadata.screenshotWidth) * metadata.sourceBounds.width,
    ),
    screenY: roundScreenCoordinate(
      metadata.sourceBounds.y +
        (args.y / metadata.screenshotHeight) * metadata.sourceBounds.height,
    ),
  };
}

function resolveClickSnapshot(args: {
  readonly app: string;
  readonly snapshotId: string | null;
  readonly snapshotStore: ComputerUseSnapshotStore;
}): ComputerUseSnapshotMetadata | ComputerUseCommandFailure {
  if (args.snapshotId) {
    const snapshot = args.snapshotStore.get(args.app, args.snapshotId);
    return (
      snapshot ??
      unsupportedCommand(
        `Snapshot not found for ${args.app}: ${args.snapshotId}`,
      )
    );
  }

  const latest = args.snapshotStore.getLatestForApp(args.app);
  return (
    latest ??
    unsupportedCommand(`No app state snapshot is available for ${args.app}`)
  );
}

async function clickElement(args: {
  readonly app: string;
  readonly elementId: string | null;
  readonly snapshotId: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly button: ComputerUseMouseButton;
  readonly clickCount: number;
  readonly nativeBackend: ComputerUseNativeBackend;
  readonly snapshotStore: ComputerUseSnapshotStore;
}): Promise<ComputerUseCommandExecutionResult> {
  if (args.elementId) {
    if (args.button !== "left") {
      return unsupportedCommand(
        "element.click with element id only supports the left button; use coordinates for right or middle clicks",
      );
    }
    await args.nativeBackend.clickElement({
      app: args.app,
      elementId: args.elementId,
      button: args.button,
      clickCount: args.clickCount,
    });
    return {
      status: "succeeded",
      result: {
        app: args.app,
        elementId: args.elementId,
        button: args.button,
        clickCount: args.clickCount,
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action",
        text: `Clicked ${args.elementId}`,
      },
    };
  }
  if (args.x !== null && args.y !== null) {
    const snapshot = resolveClickSnapshot(args);
    if ("status" in snapshot) {
      return snapshot;
    }
    const screenPoint = mapScreenshotPointToScreen({
      metadata: snapshot,
      x: args.x,
      y: args.y,
    });
    if ("status" in screenPoint) {
      return screenPoint;
    }
    await args.nativeBackend.clickPoint({
      app: args.app,
      x: screenPoint.screenX,
      y: screenPoint.screenY,
      button: args.button,
      clickCount: args.clickCount,
    });
    return {
      status: "succeeded",
      result: {
        app: args.app,
        snapshotId: snapshot.snapshotId,
        x: args.x,
        y: args.y,
        screenX: screenPoint.screenX,
        screenY: screenPoint.screenY,
        button: args.button,
        clickCount: args.clickCount,
        dispatchMode: "targeted_mouse_event",
        dispatchTarget: "app_process",
        inputRisk: "targeted_app_pointer",
        text: `Clicked ${args.x},${args.y}`,
      },
    };
  }
  return unsupportedCommand(
    "element.click requires an element id or coordinates",
  );
}

async function setElementValue(
  app: string,
  elementId: string,
  value: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.setElementValue({ app, elementId, value });
  return {
    status: "succeeded",
    result: {
      app,
      elementId,
      dispatchMode: "accessibility_value",
      dispatchTarget: "element",
      inputRisk: "targeted_app_text",
      text: `Set ${elementId}`,
    },
  };
}

async function performElementAction(
  app: string,
  elementId: string,
  action: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.performElementAction({ app, elementId, action });
  return {
    status: "succeeded",
    result: {
      app,
      elementId,
      action,
      dispatchMode: "accessibility_action",
      dispatchTarget: "element",
      inputRisk: "targeted_app_action",
      text: `Performed ${action}`,
    },
  };
}

async function typeText(
  app: string,
  text: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandExecutionResult> {
  const result = await nativeBackend.typeText({ app, text });
  return {
    status: "succeeded",
    result: {
      app,
      dispatchMode: "accessibility_value",
      dispatchTarget: "focused_editable_element",
      inputRisk: "targeted_app_text",
      role: result.role,
      text: "Typed text",
    },
  };
}

async function pressKey(
  app: string,
  key: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const parsed = parseComputerUseKeyPress(key);
  const request: ComputerUseNativePressKeyRequest = {
    app,
    keyCode: parsed.keyCode,
    modifiers: parsed.modifiers,
    flags: parsed.flags,
    normalizedKey: parsed.normalizedKey,
  };
  await nativeBackend.pressKey(request);
  return {
    status: "succeeded",
    result: {
      app,
      key: parsed.normalizedKey,
      dispatchMode: "targeted_keyboard_event",
      dispatchTarget: "app_process",
      inputRisk: "targeted_app_shortcut",
      text: `Pressed ${parsed.normalizedKey}`,
    },
  };
}

async function scrollElement(
  app: string,
  elementId: string,
  direction: string,
  pages: number,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.scrollElement({ app, elementId, direction, pages });
  return {
    status: "succeeded",
    result: {
      app,
      elementId,
      direction,
      pages,
      dispatchMode: "accessibility_action",
      dispatchTarget: "element",
      inputRisk: "targeted_app_action",
      text: `Scrolled ${elementId}`,
    },
  };
}

export async function executeComputerUseCommand(
  command: ComputerUseCommand,
  permissions: ComputerUsePermissionState,
  dependencies: ComputerUseCommandExecutionDependencies,
): Promise<ComputerUseCommandExecutionResult> {
  const permissionError = requireAccessibility(
    permissions,
    dependencies.platform ?? process.platform,
  );
  if (permissionError) {
    return permissionError;
  }

  try {
    const nativeBackend =
      dependencies.nativeBackend ?? createComputerUseNativeBackend();
    const snapshotStore =
      dependencies.snapshotStore ?? new ComputerUseSnapshotStore();
    const app = payloadString(command.payload, "app");
    if (command.kind === "apps.list") {
      return await listApps(nativeBackend);
    }
    if (!app) {
      return missingField("app");
    }
    if (command.kind === "app.state") {
      const screenRecordingError = requireScreenRecording(permissions);
      if (screenRecordingError) {
        return screenRecordingError;
      }
      return await getAppState(
        app,
        nativeBackend,
        dependencies.captureScreenshot,
        snapshotStore,
      );
    }
    if (command.kind === "app.open") {
      return await openApp(app, nativeBackend);
    }
    if (command.kind === "element.click") {
      const x = payloadNumber(command.payload, "x");
      const y = payloadNumber(command.payload, "y");
      const snapshotId = payloadString(command.payload, "snapshotId");
      if (
        !payloadString(command.payload, "elementId") &&
        x !== null &&
        y !== null &&
        !snapshotId &&
        !snapshotStore.getLatestForApp(app)
      ) {
        const screenRecordingError = requireScreenRecording(permissions);
        if (screenRecordingError) {
          return screenRecordingError;
        }
        const snapshotResult = await getAppState(
          app,
          nativeBackend,
          dependencies.captureScreenshot,
          snapshotStore,
        );
        if (snapshotResult.status === "failed") {
          return snapshotResult;
        }
      }
      return await clickElement({
        app,
        elementId: payloadString(command.payload, "elementId"),
        snapshotId,
        x,
        y,
        button: payloadMouseButton(command.payload),
        clickCount: payloadClickCount(command.payload),
        nativeBackend,
        snapshotStore,
      });
    }
    if (command.kind === "element.scroll") {
      const elementId = payloadString(command.payload, "elementId");
      const direction = payloadString(command.payload, "direction");
      if (!elementId) {
        return missingField("elementId");
      }
      if (!direction) {
        return missingField("direction");
      }
      return await scrollElement(
        app,
        elementId,
        direction,
        payloadNumber(command.payload, "pages") ?? 1,
        nativeBackend,
      );
    }
    if (command.kind === "element.set_value") {
      const elementId = payloadString(command.payload, "elementId");
      const value = payloadString(command.payload, "value");
      if (!elementId) {
        return missingField("elementId");
      }
      if (!value) {
        return missingField("value");
      }
      return await setElementValue(app, elementId, value, nativeBackend);
    }
    if (command.kind === "element.perform_action") {
      const elementId = payloadString(command.payload, "elementId");
      const action = payloadString(command.payload, "action");
      if (!elementId) {
        return missingField("elementId");
      }
      if (!action) {
        return missingField("action");
      }
      return await performElementAction(app, elementId, action, nativeBackend);
    }
    if (command.kind === "keyboard.type_text") {
      const text = payloadString(command.payload, "text");
      return text
        ? await typeText(app, text, nativeBackend)
        : missingField("text");
    }
    if (command.kind === "keyboard.press_key") {
      const key = payloadString(command.payload, "key");
      return key
        ? await pressKey(app, key, nativeBackend)
        : missingField("key");
    }
  } catch (error) {
    if (error instanceof UnsupportedComputerUseCommandError) {
      return unsupportedCommand(error.message);
    }
    if (error instanceof ComputerUseNativeHelperError) {
      return {
        status: "failed",
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }
    return {
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: `Unsupported command: ${command.kind}`,
    },
  };
}
