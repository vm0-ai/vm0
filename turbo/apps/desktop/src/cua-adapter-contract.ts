import type { ToolResult } from "@trycua/cua-driver";
import { ComputerUseNativeHelperError } from "./computer-use-native";
import type { ComputerUseCoordinateBounds } from "./computer-use-accessibility";

export function refuse(message: string): never {
  throw new ComputerUseNativeHelperError("unsupported_command", message);
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Invalid CUA response object",
    );
  return value as Record<string, unknown>;
}

export function textField(value: unknown, max = 64_000): string {
  if (typeof value !== "string" || value.length > max)
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Invalid or oversized CUA text",
    );
  return value;
}

export function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Invalid CUA integer",
    );
  return value;
}

export function arrayField(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ComputerUseNativeHelperError(
      "result_too_large",
      "Invalid or oversized CUA array",
    );
  return value;
}

export function boundsField(value: unknown): ComputerUseCoordinateBounds {
  const b = record(value);
  const { x, y, width, height } = b;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    throw new ComputerUseNativeHelperError(
      "window_unavailable",
      "Invalid CUA window bounds",
    );
  return { x, y, width, height };
}

export function structured(result: ToolResult): Record<string, unknown> {
  if (!result.structuredJson || result.structuredJson.length > 1_000_000)
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "CUA structured result is missing or oversized; completion may be unknown, do not replay",
    );
  return record(JSON.parse(result.structuredJson));
}

export function readResult(result: ToolResult): Record<string, unknown> {
  const data = structured(result);
  if (result.isError)
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      `CUA refused observation: ${textField(result.text).slice(0, 1000)}`,
    );
  return data;
}

export function actionFacts(result: ToolResult): Record<string, unknown> {
  const data = structured(result);
  const effects = [
    "confirmed",
    "partial",
    "unverifiable",
    "suspected_noop",
    "refused",
  ];
  const routes = [
    "accessibility",
    "synthetic_events",
    "global_input",
    "system_api",
    "dom",
    "trusted_input",
  ];
  if (
    !effects.includes(textField(data.effect)) ||
    !routes.includes(textField(data.route))
  )
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "CUA action completion is unknown; do not replay",
    );
  const facts: Record<string, unknown> = {
    driver: "cua",
    driverVersion: "0.23.2",
    effect: data.effect,
    route: data.route,
  };
  if (data.delivery !== undefined) {
    const delivery = record(data.delivery);
    if (
      !["background", "foreground", "not_applicable", "unknown"].includes(
        textField(delivery.mode),
      )
    )
      refuse("Invalid CUA delivery mode");
    facts.delivery = {
      mode: delivery.mode,
      ...(delivery.delivered_count !== undefined
        ? { delivered_count: integer(delivery.delivered_count) }
        : {}),
    };
  }
  if (data.evidence !== undefined) {
    facts.evidence = arrayField(data.evidence, 100).map((item) => {
      const evidence = record(item);
      if (
        !["value_readback", "window_change"].includes(textField(evidence.kind))
      )
        refuse("Invalid CUA action evidence");
      return { kind: evidence.kind };
    });
  }
  if (
    data.effect === "confirmed" &&
    (!Array.isArray(facts.evidence) || facts.evidence.length === 0)
  )
    refuse("CUA confirmation has no evidence");
  if (
    data.effect === "partial" &&
    (data.delivery === undefined ||
      record(data.delivery).delivered_count === undefined)
  )
    refuse("CUA partial delivery has no count");
  if (
    data.effect === "refused" &&
    (data.delivery !== undefined || data.evidence !== undefined)
  )
    refuse("Invalid CUA refusal facts");
  return facts;
}

export function normalizeKey(input: string): {
  key: string;
  modifiers: string[];
  normalizedKey: string;
} {
  const aliases: Readonly<Record<string, string>> = {
    command: "cmd",
    meta: "cmd",
    control: "ctrl",
    alt: "option",
    enter: "return",
    esc: "escape",
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    backspace: "delete",
  };
  const parts = input
    .toLowerCase()
    .split("+")
    .map((part) => aliases[part.trim()] ?? part.trim());
  const key = parts.pop();
  if (
    !key ||
    !/^(?:[a-z0-9]|return|tab|escape|up|down|left|right|space|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/.test(
      key,
    ) ||
    parts.some(
      (part) => !["cmd", "ctrl", "shift", "option", "fn"].includes(part),
    ) ||
    new Set(parts).size !== parts.length
  )
    refuse(
      "Unsupported CUA key; use a supported key with cmd/ctrl/shift/option/fn modifiers",
    );
  return { key, modifiers: parts, normalizedKey: [...parts, key].join("+") };
}
