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
  readonly index?: number;
  readonly role?: string;
  readonly subrole?: string;
  readonly roleDescription?: string;
  readonly name?: string;
  readonly value?: string;
  readonly valueType?: string;
  readonly valueSettable?: boolean;
  readonly description?: string;
  readonly help?: string;
  readonly placeholderValue?: string;
  readonly visibleText?: string;
  readonly text?: string;
  readonly titleElementText?: string;
  readonly columnTitles?: readonly string[];
  readonly identifier?: string;
  readonly url?: string;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly hidden?: boolean;
  readonly actions?: readonly string[];
  readonly bounds?: ComputerUseCoordinateBounds;
  readonly children?: readonly AccessibilityElementSnapshot[];
}

type AccessibilityTextSourceAttribute =
  | "AXTitle"
  | "AXValue"
  | "AXDescription"
  | "AXHelp"
  | "AXPlaceholderValue"
  | "AXVisibleText"
  | "AXText"
  | "AXTitleUIElement"
  | "AXColumnTitles"
  | "AXIdentifier"
  | "AXURL";

interface AccessibilityVisibleElement {
  readonly elementIndex?: number;
  readonly elementId: string;
  readonly role?: string;
  readonly text: string;
  readonly source: "accessibility";
  readonly sourceAttributes: readonly AccessibilityTextSourceAttribute[];
  readonly bounds?: ComputerUseCoordinateBounds;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly actions?: readonly string[];
}

export interface AccessibilityAppStateSnapshot {
  readonly app: string;
  readonly appDisplayName?: string;
  readonly bundleId?: string;
  readonly pid?: number;
  readonly appPath?: string;
  readonly windowTitle?: string;
  readonly snapshotId: string;
  readonly elements: readonly AccessibilityElementSnapshot[];
  readonly focusedElementIndex?: number;
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
  readonly elementIdsByIndex?: readonly string[];
  readonly focusedElementIndex?: number;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly screenshotSource: "window" | "screen";
  readonly screenshotSourceName: string;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
}

interface IndexedAccessibilitySnapshot {
  readonly snapshot: AccessibilityAppStateSnapshot;
  readonly elementIdsByIndex: readonly string[];
  readonly focusedElementIndex?: number;
}

interface ComputerUseElementTarget {
  readonly elementId: string;
  readonly elementIndex?: number;
  readonly snapshotId?: string;
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

function payloadElementIndex(payload: Record<string, unknown>): number | null {
  const value = payload.elementIndex;
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new UnsupportedComputerUseCommandError(
    "elementIndex must be a non-negative integer",
  );
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

function normalizeDisplayText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function stringArrayHasValue(value: readonly string[] | undefined): boolean {
  return (
    value !== undefined &&
    value.some((entry) => {
      return normalizeDisplayText(entry).length > 0;
    })
  );
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
    stringHasValue(element.help) ||
    stringHasValue(element.placeholderValue) ||
    stringHasValue(element.visibleText) ||
    stringHasValue(element.text) ||
    stringHasValue(element.titleElementText) ||
    stringArrayHasValue(element.columnTitles) ||
    stringHasValue(element.identifier) ||
    stringHasValue(element.url) ||
    element.focused === true ||
    element.enabled === false ||
    element.selected === true ||
    element.expanded !== undefined ||
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
    if (
      depth > 0 &&
      element.hidden === true &&
      element.focused !== true &&
      element.selected !== true
    ) {
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

function boundsIntersect(
  lhs: ComputerUseCoordinateBounds,
  rhs: ComputerUseCoordinateBounds,
): boolean {
  const lhsRight = lhs.x + lhs.width;
  const lhsBottom = lhs.y + lhs.height;
  const rhsRight = rhs.x + rhs.width;
  const rhsBottom = rhs.y + rhs.height;
  return (
    lhs.width > 0 &&
    lhs.height > 0 &&
    rhs.width > 0 &&
    rhs.height > 0 &&
    lhs.x < rhsRight &&
    lhsRight > rhs.x &&
    lhs.y < rhsBottom &&
    lhsBottom > rhs.y
  );
}

function elementIsInCapturedSource(
  element: AccessibilityElementSnapshot,
  sourceBounds: ComputerUseCoordinateBounds | undefined,
): boolean {
  if (!sourceBounds || !element.bounds) {
    return true;
  }
  return (
    boundsIntersect(element.bounds, sourceBounds) ||
    element.focused === true ||
    element.selected === true
  );
}

interface AccessibilityTextCandidate {
  readonly text: string;
  readonly sourceAttribute: AccessibilityTextSourceAttribute;
}

function pushTextCandidate(
  candidates: AccessibilityTextCandidate[],
  value: string | undefined,
  sourceAttribute: AccessibilityTextSourceAttribute,
): void {
  if (!value) {
    return;
  }
  const text = normalizeDisplayText(value);
  if (text.length === 0) {
    return;
  }
  candidates.push({ text, sourceAttribute });
}

function pushTextArrayCandidate(
  candidates: AccessibilityTextCandidate[],
  value: readonly string[] | undefined,
  sourceAttribute: AccessibilityTextSourceAttribute,
): void {
  if (!value) {
    return;
  }
  const text = value
    .map(normalizeDisplayText)
    .filter((entry) => {
      return entry.length > 0;
    })
    .join(", ");
  if (text.length === 0) {
    return;
  }
  candidates.push({ text, sourceAttribute });
}

function elementTextCandidates(
  element: AccessibilityElementSnapshot,
): readonly AccessibilityTextCandidate[] {
  const candidates: AccessibilityTextCandidate[] = [];
  pushTextCandidate(candidates, element.name, "AXTitle");
  pushTextCandidate(candidates, element.value, "AXValue");
  pushTextCandidate(candidates, element.description, "AXDescription");
  pushTextCandidate(candidates, element.help, "AXHelp");
  pushTextCandidate(candidates, element.placeholderValue, "AXPlaceholderValue");
  pushTextCandidate(candidates, element.visibleText, "AXVisibleText");
  pushTextCandidate(candidates, element.text, "AXText");
  pushTextCandidate(candidates, element.titleElementText, "AXTitleUIElement");
  pushTextArrayCandidate(candidates, element.columnTitles, "AXColumnTitles");
  pushTextCandidate(candidates, element.identifier, "AXIdentifier");
  pushTextCandidate(candidates, element.url, "AXURL");
  return candidates;
}

function visibleElementForSnapshotElement(
  element: AccessibilityElementSnapshot,
  sourceBounds: ComputerUseCoordinateBounds | undefined,
): AccessibilityVisibleElement | null {
  if (
    element.hidden === true &&
    element.focused !== true &&
    element.selected !== true
  ) {
    return null;
  }
  if (!elementIsInCapturedSource(element, sourceBounds)) {
    return null;
  }

  const candidates = elementTextCandidates(element);
  const primary = candidates[0];
  if (!primary) {
    return null;
  }

  const sourceAttributes = candidates
    .filter((candidate) => {
      return candidate.text === primary.text;
    })
    .map((candidate) => {
      return candidate.sourceAttribute;
    });

  return {
    ...(element.index !== undefined ? { elementIndex: element.index } : {}),
    elementId: element.id,
    ...(element.role ? { role: element.role } : {}),
    text: primary.text,
    source: "accessibility",
    sourceAttributes: [...new Set(sourceAttributes)],
    ...(element.bounds ? { bounds: element.bounds } : {}),
    ...(element.focused !== undefined ? { focused: element.focused } : {}),
    ...(element.enabled !== undefined ? { enabled: element.enabled } : {}),
    ...(element.selected !== undefined ? { selected: element.selected } : {}),
    ...(element.expanded !== undefined ? { expanded: element.expanded } : {}),
    ...(element.actions && element.actions.length > 0
      ? { actions: element.actions }
      : {}),
  };
}

export function collectAccessibilityVisibleElements(
  snapshot: AccessibilityAppStateSnapshot,
  sourceBounds?: ComputerUseCoordinateBounds,
): readonly AccessibilityVisibleElement[] {
  const result: AccessibilityVisibleElement[] = [];
  const seen = new Set<string>();

  const visit = (element: AccessibilityElementSnapshot): void => {
    const visibleElement = visibleElementForSnapshotElement(
      element,
      sourceBounds,
    );
    if (visibleElement) {
      const key = `${visibleElement.elementId}\0${visibleElement.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(visibleElement);
      }
    }
    for (const child of element.children ?? []) {
      visit(child);
    }
  };

  for (const element of snapshot.elements) {
    visit(element);
  }
  return result;
}

function renderAccessibilityVisibleText(
  visibleElements: readonly AccessibilityVisibleElement[],
): string {
  return visibleElements
    .map((element) => {
      const role = element.role ? ` ${element.role}` : "";
      const source = element.sourceAttributes.join("+");
      const selector =
        element.elementIndex !== undefined
          ? String(element.elementIndex)
          : element.elementId;
      return `${selector}${role} [${source}] ${element.text}`;
    })
    .join("\n");
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

function indexAccessibilitySnapshot(
  snapshot: AccessibilityAppStateSnapshot,
): IndexedAccessibilitySnapshot {
  let nextIndex = 0;
  const elementIdsByIndex: string[] = [];
  let focusedElementIndex = snapshot.focusedElementIndex;

  const indexElement = (
    element: AccessibilityElementSnapshot,
  ): AccessibilityElementSnapshot => {
    const index = nextIndex;
    nextIndex += 1;
    elementIdsByIndex[index] = element.id;
    if (focusedElementIndex === undefined && element.focused === true) {
      focusedElementIndex = index;
    }

    const children = element.children?.map((child) => {
      return indexElement(child);
    });
    return {
      ...element,
      index,
      ...(children && children.length > 0 ? { children } : {}),
    };
  };

  const elements = snapshot.elements.map((element) => {
    return indexElement(element);
  });

  return {
    snapshot: {
      ...snapshot,
      elements,
      ...(focusedElementIndex !== undefined ? { focusedElementIndex } : {}),
    },
    elementIdsByIndex,
    ...(focusedElementIndex !== undefined ? { focusedElementIndex } : {}),
  };
}

const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXComboBox: "combo box",
  AXDisclosureTriangle: "disclosure triangle",
  AXGroup: "container",
  AXHeading: "heading",
  AXImage: "image",
  AXLink: "link",
  AXList: "list",
  AXMenu: "menu",
  AXMenuBar: "menu bar",
  AXMenuBarItem: "menu bar item",
  AXMenuItem: "menu item",
  AXOutline: "outline",
  AXPopUpButton: "pop up button",
  AXRadioButton: "radio button",
  AXScrollArea: "scroll area",
  AXSlider: "slider",
  AXStaticText: "text",
  AXTabGroup: "tab group",
  AXTable: "table",
  AXTextArea: "text entry area",
  AXTextField: "text field",
  AXToolbar: "toolbar",
  AXUnknown: "container",
});

const DEFAULT_ACTION_NAMES = new Set(["AXPress"]);

const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  AXCancel: "Cancel",
  AXConfirm: "Confirm",
  AXDecrement: "Decrement",
  AXDelete: "Delete",
  AXIncrement: "Increment",
  AXPick: "Pick",
  AXRaise: "Raise",
  AXShowMenu: "Show Menu",
});

function normalizeText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateText(value: string, maxLength = 180): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function formatText(
  value: string | undefined,
  maxLength?: number,
): string | null {
  const normalized = normalizeText(value);
  return normalized ? truncateText(normalized, maxLength) : null;
}

function labelFromAxRole(role: string): string {
  const withoutPrefix = role.startsWith("AX") ? role.slice(2) : role;
  return withoutPrefix.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function elementRoleLabel(element: AccessibilityElementSnapshot): string {
  if (element.role === "AXWindow") {
    if (element.subrole === "AXDialog") {
      return "dialog";
    }
    return "standard window";
  }
  if (element.role === "AXWebArea") {
    return formatText(element.roleDescription, 80) ?? "HTML content";
  }
  if (element.role) {
    const label = ROLE_LABELS[element.role];
    if (label) {
      return label;
    }
  }
  if (element.roleDescription) {
    return formatText(element.roleDescription, 80) ?? "element";
  }
  return element.role ? labelFromAxRole(element.role) : "element";
}

function elementAnnotations(element: AccessibilityElementSnapshot): string[] {
  const annotations: string[] = [];
  if (element.valueSettable === true) {
    annotations.push(
      element.valueType ? `settable, ${element.valueType}` : "settable",
    );
  }
  if (element.enabled === false) {
    annotations.push("disabled");
  }
  if (element.selected === true) {
    annotations.push("selected");
  }
  if (element.expanded === true) {
    annotations.push("expanded");
  }
  return annotations;
}

function elementPrimaryText(
  element: AccessibilityElementSnapshot,
): string | null {
  return (
    formatText(element.name) ??
    formatText(element.value) ??
    formatText(element.visibleText) ??
    formatText(element.text) ??
    formatText(element.titleElementText) ??
    formatText(element.description) ??
    formatText(element.placeholderValue) ??
    formatText(element.identifier) ??
    formatText(element.url, 240)
  );
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/^AX/, "");
}

function secondaryActions(element: AccessibilityElementSnapshot): string[] {
  return (element.actions ?? [])
    .filter((action) => {
      return !DEFAULT_ACTION_NAMES.has(action);
    })
    .map((action) => {
      return actionLabel(action);
    });
}

function elementDetails(
  element: AccessibilityElementSnapshot,
  primary: string | null,
): string[] {
  const details: string[] = [];
  const description = formatText(element.description);
  if (description && description !== primary) {
    details.push(`Description: ${description}`);
  }
  const value = formatText(element.value);
  if (value && value !== primary) {
    details.push(`Value: ${value}`);
  }
  const visibleText = formatText(element.visibleText);
  if (visibleText && visibleText !== primary) {
    details.push(`Visible Text: ${visibleText}`);
  }
  const text = formatText(element.text);
  if (text && text !== primary) {
    details.push(`Text: ${text}`);
  }
  const titleElementText = formatText(element.titleElementText);
  if (titleElementText && titleElementText !== primary) {
    details.push(`Title Element: ${titleElementText}`);
  }
  const placeholderValue = formatText(element.placeholderValue);
  if (placeholderValue && placeholderValue !== primary) {
    details.push(`Placeholder: ${placeholderValue}`);
  }
  const columnTitles = formatText(element.columnTitles?.join(", "));
  if (columnTitles && columnTitles !== primary) {
    details.push(`Columns: ${columnTitles}`);
  }
  const identifier = formatText(element.identifier, 120);
  if (identifier && identifier !== primary) {
    details.push(`Identifier: ${identifier}`);
  }
  const url = formatText(element.url, 240);
  if (url && url !== primary) {
    details.push(`URL: ${url}`);
  }
  const help = formatText(element.help);
  if (help && help !== primary) {
    details.push(`Help: ${help}`);
  }
  const actions = secondaryActions(element);
  if (actions.length > 0) {
    details.push(`Secondary Actions: ${actions.join(", ")}`);
  }
  return details;
}

function elementIndex(element: AccessibilityElementSnapshot): number {
  return element.index ?? 0;
}

function formatElementLine(
  element: AccessibilityElementSnapshot,
  depth: number,
): string {
  const primary = elementPrimaryText(element);
  const annotations = elementAnnotations(element);
  const details = elementDetails(element, primary);
  let line = `${"\t".repeat(depth)}${elementIndex(element)} ${elementRoleLabel(
    element,
  )}`;
  if (annotations.length > 0) {
    line += ` (${annotations.join(", ")})`;
  }
  if (primary) {
    line += ` ${primary}`;
  }
  if (details.length > 0) {
    line += `${primary ? ", " : " "}${details.join(", ")}`;
  }
  return line;
}

function findElementByIndex(
  elements: readonly AccessibilityElementSnapshot[],
  index: number,
): AccessibilityElementSnapshot | null {
  for (const element of elements) {
    if (element.index === index) {
      return element;
    }
    const child = findElementByIndex(element.children ?? [], index);
    if (child) {
      return child;
    }
  }
  return null;
}

function focusedElementLine(
  snapshot: AccessibilityAppStateSnapshot,
): string | null {
  if (snapshot.focusedElementIndex === undefined) {
    return null;
  }
  const element = findElementByIndex(
    snapshot.elements,
    snapshot.focusedElementIndex,
  );
  if (!element) {
    return `The focused UI element is ${snapshot.focusedElementIndex}.`;
  }
  return `The focused UI element is ${formatElementLine(element, 0)}.`;
}

export function renderAccessibilityTree(
  snapshot: AccessibilityAppStateSnapshot,
): string {
  const indexed = indexAccessibilitySnapshot(snapshot).snapshot;
  const appName = indexed.appDisplayName ?? indexed.app;
  const appIdentity = indexed.appPath ?? appName;
  const appDetails = [
    indexed.bundleId ? `bundleID ${indexed.bundleId}` : null,
    indexed.pid !== undefined ? `pid ${indexed.pid}` : null,
  ].filter((part): part is string => {
    return part !== null;
  });
  const lines = [
    "Computer Use state",
    "<app_state>",
    appDetails.length > 0
      ? `App=${appIdentity} (${appDetails.join(", ")})`
      : `App=${appIdentity}`,
  ];
  const windowTitle =
    formatText(indexed.windowTitle) ?? formatText(indexed.elements[0]?.name);
  if (windowTitle) {
    lines.push(`Window: "${windowTitle}", App: ${appName}.`);
  }

  const visit = (
    element: AccessibilityElementSnapshot,
    depth: number,
  ): void => {
    lines.push(formatElementLine(element, depth));
    for (const child of element.children ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const element of indexed.elements) {
    visit(element, 0);
  }
  const focusedLine = focusedElementLine(indexed);
  if (focusedLine) {
    lines.push("", focusedLine);
  }
  lines.push("</app_state>");
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

function publicElementSnapshot(
  element: AccessibilityElementSnapshot,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (key !== "id" && key !== "children" && value !== undefined) {
      result[key] = value;
    }
  }
  if (element.children && element.children.length > 0) {
    result.children = element.children.map((child) => {
      return publicElementSnapshot(child);
    });
  }
  return result;
}

function publicAppStateSnapshot(
  snapshot: AccessibilityAppStateSnapshot,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== "elements" && value !== undefined) {
      result[key] = value;
    }
  }
  result.elements = snapshot.elements.map((element) => {
    return publicElementSnapshot(element);
  });
  return result;
}

function buildComputerUseAppStateResult(
  snapshot: AccessibilityAppStateSnapshot,
  screenshot: ComputerUseScreenshotCaptureResult,
): Record<string, unknown> {
  const visibleElements = collectAccessibilityVisibleElements(
    snapshot,
    screenshot.sourceBounds,
  );
  return {
    ...publicAppStateSnapshot(snapshot),
    text: renderAccessibilityTree(snapshot),
    visibleTextSource: "accessibility",
    visibleText: renderAccessibilityVisibleText(visibleElements),
    visibleElements,
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
  const indexed = indexAccessibilitySnapshot(snapshot);
  const windowBounds = snapshotWindowCaptureCandidates(indexed.snapshot);
  let screenshot: ComputerUseScreenshotCaptureResult;
  try {
    screenshot = await captureScreenshot({
      app,
      windowNames: snapshotWindowNames(indexed.snapshot),
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
    app: indexed.snapshot.app,
    snapshotId: indexed.snapshot.snapshotId,
    elementIdsByIndex: indexed.elementIdsByIndex,
    ...(indexed.focusedElementIndex !== undefined
      ? { focusedElementIndex: indexed.focusedElementIndex }
      : {}),
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
    result: buildComputerUseAppStateResult(indexed.snapshot, screenshot),
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
      dispatchMode: "background_app_open",
      dispatchTarget: "target_app",
      inputRisk: "background_app_launch",
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

function resolveElementTarget(args: {
  readonly app: string;
  readonly elementId: string | null;
  readonly elementIndex: number | null;
  readonly snapshotId: string | null;
  readonly snapshotStore: ComputerUseSnapshotStore;
  readonly commandName: string;
}): ComputerUseElementTarget | ComputerUseCommandFailure {
  if (args.elementId) {
    return { elementId: args.elementId };
  }
  if (args.elementIndex === null) {
    return unsupportedCommand(
      `${args.commandName} requires elementId or elementIndex`,
    );
  }

  const snapshot = resolveClickSnapshot({
    app: args.app,
    snapshotId: args.snapshotId,
    snapshotStore: args.snapshotStore,
  });
  if ("status" in snapshot) {
    return snapshot;
  }
  const elementId = snapshot.elementIdsByIndex?.[args.elementIndex];
  if (!elementId) {
    return unsupportedCommand(
      `Element index ${args.elementIndex} was not found in snapshot ${snapshot.snapshotId}`,
    );
  }
  return {
    elementId,
    elementIndex: args.elementIndex,
    snapshotId: snapshot.snapshotId,
  };
}

function elementTargetResult(
  target: ComputerUseElementTarget,
): Record<string, unknown> {
  if (target.elementIndex !== undefined) {
    return {
      elementIndex: target.elementIndex,
      ...(target.snapshotId ? { snapshotId: target.snapshotId } : {}),
    };
  }
  return { elementId: target.elementId };
}

function elementTargetText(target: ComputerUseElementTarget): string {
  return target.elementIndex !== undefined
    ? `elementIndex=${target.elementIndex}`
    : target.elementId;
}

async function clickElement(args: {
  readonly app: string;
  readonly elementId: string | null;
  readonly elementIndex: number | null;
  readonly snapshotId: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly button: ComputerUseMouseButton;
  readonly clickCount: number;
  readonly nativeBackend: ComputerUseNativeBackend;
  readonly snapshotStore: ComputerUseSnapshotStore;
}): Promise<ComputerUseCommandExecutionResult> {
  if (args.elementId || args.elementIndex !== null) {
    if (args.button !== "left") {
      return unsupportedCommand(
        "element.click with element target only supports the left button; use coordinates for right or middle clicks",
      );
    }
    const target = resolveElementTarget({
      app: args.app,
      elementId: args.elementId,
      elementIndex: args.elementIndex,
      snapshotId: args.snapshotId,
      snapshotStore: args.snapshotStore,
      commandName: "element.click",
    });
    if ("status" in target) {
      return target;
    }
    await args.nativeBackend.clickElement({
      app: args.app,
      elementId: target.elementId,
      button: args.button,
      clickCount: args.clickCount,
    });
    return {
      status: "succeeded",
      result: {
        app: args.app,
        ...elementTargetResult(target),
        button: args.button,
        clickCount: args.clickCount,
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action",
        text: `Clicked ${elementTargetText(target)}`,
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
        dispatchMode: "background_mouse_event",
        dispatchTarget: "app_process",
        inputRisk: "background_app_pointer",
        text: `Clicked ${args.x},${args.y}`,
      },
    };
  }
  return unsupportedCommand(
    "element.click requires elementId, elementIndex, or coordinates",
  );
}

async function setElementValue(
  app: string,
  target: ComputerUseElementTarget,
  value: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.setElementValue({
    app,
    elementId: target.elementId,
    value,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...elementTargetResult(target),
      dispatchMode: "accessibility_value",
      dispatchTarget: "element",
      inputRisk: "targeted_app_text",
      text: `Set ${elementTargetText(target)}`,
    },
  };
}

async function performElementAction(
  app: string,
  target: ComputerUseElementTarget,
  action: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.performElementAction({
    app,
    elementId: target.elementId,
    action,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...elementTargetResult(target),
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
      dispatchMode: "background_keyboard_event",
      dispatchTarget: "app_process",
      inputRisk: "background_app_shortcut",
      text: `Pressed ${parsed.normalizedKey}`,
    },
  };
}

async function scrollElement(
  app: string,
  target: ComputerUseElementTarget,
  direction: string,
  pages: number,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  await nativeBackend.scrollElement({
    app,
    elementId: target.elementId,
    direction,
    pages,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...elementTargetResult(target),
      direction,
      pages,
      dispatchMode: "accessibility_action",
      dispatchTarget: "element",
      inputRisk: "targeted_app_action",
      text: `Scrolled ${elementTargetText(target)}`,
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
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      if (
        !elementId &&
        elementIndex === null &&
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
        elementId,
        elementIndex,
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
      const elementIndex = payloadElementIndex(command.payload);
      const snapshotId = payloadString(command.payload, "snapshotId");
      const direction = payloadString(command.payload, "direction");
      if (!direction) {
        return missingField("direction");
      }
      const target = resolveElementTarget({
        app,
        elementId,
        elementIndex,
        snapshotId,
        snapshotStore,
        commandName: "element.scroll",
      });
      if ("status" in target) {
        return target;
      }
      return await scrollElement(
        app,
        target,
        direction,
        payloadNumber(command.payload, "pages") ?? 1,
        nativeBackend,
      );
    }
    if (command.kind === "element.set_value") {
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      const snapshotId = payloadString(command.payload, "snapshotId");
      const value = payloadString(command.payload, "value");
      if (!value) {
        return missingField("value");
      }
      const target = resolveElementTarget({
        app,
        elementId,
        elementIndex,
        snapshotId,
        snapshotStore,
        commandName: "element.set_value",
      });
      if ("status" in target) {
        return target;
      }
      return await setElementValue(app, target, value, nativeBackend);
    }
    if (command.kind === "element.perform_action") {
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      const snapshotId = payloadString(command.payload, "snapshotId");
      const action = payloadString(command.payload, "action");
      if (!action) {
        return missingField("action");
      }
      const target = resolveElementTarget({
        app,
        elementId,
        elementIndex,
        snapshotId,
        snapshotStore,
        commandName: "element.perform_action",
      });
      if ("status" in target) {
        return target;
      }
      return await performElementAction(app, target, action, nativeBackend);
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
