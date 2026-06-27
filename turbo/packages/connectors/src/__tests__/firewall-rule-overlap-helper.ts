import { validateRule } from "../firewall-expander";
import { parseSegment, splitPathSegments } from "../segment-parser";

const VALID_RULE_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ANY",
] as const;

type RuleMethod = (typeof VALID_RULE_METHODS)[number];
type ParsedSegment = Exclude<
  ReturnType<typeof parseSegment>,
  { kind: "error" }
>;

interface ParsedRule {
  readonly method: RuleMethod;
  readonly path: string;
  readonly segments: readonly ParsedSegment[];
}

interface FirewallRuleOverlap {
  readonly leftRule: string;
  readonly rightRule: string;
  readonly method: string;
  readonly path: string;
}

export interface FirewallRuleReference {
  readonly permissionName: string;
  readonly rule: string;
}

interface FirewallRuleReferenceOverlap {
  readonly left: FirewallRuleReference;
  readonly right: FirewallRuleReference;
  readonly method: string;
  readonly path: string;
}

function isRuleMethod(value: string): value is RuleMethod {
  return VALID_RULE_METHODS.includes(value as RuleMethod);
}

function parseRule(rule: string): ParsedRule {
  validateRule(rule, "overlap", "overlap");

  const spaceIdx = rule.indexOf(" ");
  const method = rule.slice(0, spaceIdx);
  const path = rule.slice(spaceIdx + 1);
  if (!isRuleMethod(method)) {
    throw new Error(`Invalid rule method "${method}"`);
  }

  return {
    method,
    path,
    segments: splitPathSegments(path).map((segment) => {
      const parsed = parseSegment(segment);
      if (parsed.kind === "error") {
        throw new Error(parsed.reason);
      }
      return parsed;
    }),
  };
}

function intersectMethods(
  left: RuleMethod,
  right: RuleMethod,
): RuleMethod | null {
  if (left === right) return left === "ANY" ? "GET" : left;
  if (left === "ANY") return right;
  if (right === "ANY") return left;
  return null;
}

function segmentMatchesParam(
  value: string,
  pattern: Extract<ParsedSegment, { kind: "param" }>,
): boolean {
  if (pattern.greedy !== "") return value !== "";
  if (pattern.prefix === "" && pattern.suffix === "") return value !== "";
  return (
    value.startsWith(pattern.prefix) &&
    value.endsWith(pattern.suffix) &&
    value.length > pattern.prefix.length + pattern.suffix.length
  );
}

function segmentWitness(segment: ParsedSegment): string {
  if (segment.kind === "literal") return segment.value;
  if (segment.prefix === "" && segment.suffix === "") return "x";
  return `${segment.prefix}x${segment.suffix}`;
}

function intersectParamSegments(
  left: Extract<ParsedSegment, { kind: "param" }>,
  right: Extract<ParsedSegment, { kind: "param" }>,
): string | null {
  const prefix =
    left.prefix.length >= right.prefix.length ? left.prefix : right.prefix;
  if (!prefix.startsWith(left.prefix) || !prefix.startsWith(right.prefix)) {
    return null;
  }

  const suffix =
    left.suffix.length >= right.suffix.length ? left.suffix : right.suffix;
  if (!suffix.endsWith(left.suffix) || !suffix.endsWith(right.suffix)) {
    return null;
  }

  const candidates = [`${prefix}x${suffix}`, `${prefix}${suffix}x`];
  return (
    candidates.find((candidate) => {
      return (
        segmentMatchesParam(candidate, left) &&
        segmentMatchesParam(candidate, right)
      );
    }) ?? null
  );
}

function intersectFixedSegments(
  left: ParsedSegment,
  right: ParsedSegment,
): string | null {
  if (left.kind === "literal" && right.kind === "literal") {
    return left.value === right.value ? left.value : null;
  }

  if (left.kind === "literal" && right.kind === "param") {
    return segmentMatchesParam(left.value, right) ? left.value : null;
  }

  if (left.kind === "param" && right.kind === "literal") {
    return segmentMatchesParam(right.value, left) ? right.value : null;
  }

  if (left.kind === "param" && right.kind === "param") {
    return intersectParamSegments(left, right);
  }

  return null;
}

function isGreedySegment(
  segment: ParsedSegment | undefined,
): segment is Extract<ParsedSegment, { kind: "param" }> {
  return segment?.kind === "param" && segment.greedy !== "";
}

function witnessForPattern(
  segments: readonly ParsedSegment[],
  startIndex: number,
  requireNonEmpty: boolean,
): readonly string[] | null {
  if (startIndex >= segments.length) {
    return requireNonEmpty ? ["x"] : [];
  }

  const segment = segments[startIndex]!;
  if (isGreedySegment(segment)) {
    if (segment.greedy === "+" || requireNonEmpty) return ["x"];
    return [];
  }

  const tail = witnessForPattern(segments, startIndex + 1, false);
  if (tail === null) return null;
  return [segmentWitness(segment), ...tail];
}

function emptyWitnessForPattern(
  segments: readonly ParsedSegment[],
  startIndex: number,
): readonly string[] | null {
  if (startIndex >= segments.length) return [];

  const segment = segments[startIndex]!;
  if (isGreedySegment(segment) && segment.greedy === "*") return [];

  return null;
}

function intersectPathSegments(
  left: readonly ParsedSegment[],
  right: readonly ParsedSegment[],
  leftIndex: number,
  rightIndex: number,
): readonly string[] | null {
  const leftSegment = left[leftIndex];
  const rightSegment = right[rightIndex];

  if (leftSegment === undefined && rightSegment === undefined) return [];
  if (leftSegment === undefined) {
    return emptyWitnessForPattern(right, rightIndex);
  }
  if (rightSegment === undefined) {
    return emptyWitnessForPattern(left, leftIndex);
  }

  const leftGreedy = isGreedySegment(leftSegment);
  const rightGreedy = isGreedySegment(rightSegment);
  if (leftGreedy && rightGreedy) {
    return leftSegment.greedy === "+" || rightSegment.greedy === "+"
      ? ["x"]
      : [];
  }
  if (leftGreedy) {
    return witnessForPattern(right, rightIndex, leftSegment.greedy === "+");
  }
  if (rightGreedy) {
    return witnessForPattern(left, leftIndex, rightSegment.greedy === "+");
  }

  const segment = intersectFixedSegments(leftSegment, rightSegment);
  if (segment === null) return null;
  const tail = intersectPathSegments(
    left,
    right,
    leftIndex + 1,
    rightIndex + 1,
  );
  if (tail === null) return null;
  return [segment, ...tail];
}

function pathFromSegments(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function findFirewallRuleOverlap(
  leftRule: string,
  rightRule: string,
): FirewallRuleOverlap | null {
  const left = parseRule(leftRule);
  const right = parseRule(rightRule);
  const method = intersectMethods(left.method, right.method);
  if (method === null) return null;

  const segments = intersectPathSegments(left.segments, right.segments, 0, 0);
  if (segments === null) return null;

  return {
    leftRule,
    rightRule,
    method,
    path: pathFromSegments(segments),
  };
}

export function findFirewallRuleReferenceOverlaps(
  leftRules: readonly FirewallRuleReference[],
  rightRules: readonly FirewallRuleReference[],
): FirewallRuleReferenceOverlap[] {
  const overlaps: FirewallRuleReferenceOverlap[] = [];

  for (const left of leftRules) {
    for (const right of rightRules) {
      const overlap = findFirewallRuleOverlap(left.rule, right.rule);
      if (overlap === null) continue;
      overlaps.push({
        left,
        right,
        method: overlap.method,
        path: overlap.path,
      });
    }
  }

  return overlaps;
}
