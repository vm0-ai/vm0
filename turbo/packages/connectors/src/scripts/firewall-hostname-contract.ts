import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { canonicalizeFirewallBaseUrl } from "../firewall-types";
import { FIREWALL_HOSTNAME_POLICY_VERSION } from "../firewall-hostname-policy";

const UNICODE_MAX = 0x10ffff;
const MULTI_SHAPE_MAX = 0x2ffff;
const FIRST_CODE_POINT = 0;
const HIGH_SURROGATE_START = 0xd800;
const LOW_SURROGATE_END = 0xdfff;
const EXPECTED_TOTAL = 2_279_424;
const EXPECTED_ACCEPTED = 860_246;
const EXPECTED_UNIQUE_OUTPUTS = 835_577;
const EXPECTED_SHA256 =
  "5422dc745f533d9eb9dae7c38db683af7e7de9b8e582a49ad7a9d6c18a68fa8a";

interface CorpusSummary {
  readonly policy: string;
  readonly total: number;
  readonly accepted: number;
  readonly uniqueOutputs: number;
  readonly sha256: string;
}

function isUnicodeScalar(codePoint: number): boolean {
  return codePoint < HIGH_SURROGATE_START || codePoint > LOW_SURROGATE_END;
}

function validationResult(label: string): string | null {
  try {
    const canonicalBase = canonicalizeFirewallBaseUrl(
      `https://${label}.example`,
      "hostname contract",
    );
    const authorityStart = canonicalBase.indexOf("://") + 3;
    const pathStart = canonicalBase.indexOf("/", authorityStart);
    return canonicalBase.slice(
      authorityStart,
      pathStart === -1 ? undefined : pathStart,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid base URL")
    ) {
      return null;
    }
    throw error;
  }
}

function multiShapeLabels(char: string): readonly string[] {
  return [
    `a${char}`,
    `${char}a`,
    `1${char}`,
    `${char}1`,
    `\u0627${char}`,
    `${char}\u0301`,
  ];
}

function addCase(
  hash: ReturnType<typeof createHash>,
  outputs: Set<string>,
  caseId: string,
  label: string,
): boolean {
  const result = validationResult(label);
  hash.update(caseId);
  hash.update("\0");
  hash.update(result ?? "-");
  hash.update("\n");
  if (result === null) return false;
  outputs.add(result);
  return true;
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error("output path argument is required");
  }

  const hash = createHash("sha256");
  hash.update(`${FIREWALL_HOSTNAME_POLICY_VERSION}\n`);
  const outputs = new Set<string>();
  let total = 0;
  let accepted = 0;

  for (
    let codePoint = FIRST_CODE_POINT;
    codePoint <= UNICODE_MAX;
    codePoint += 1
  ) {
    if (!isUnicodeScalar(codePoint)) continue;
    const char = String.fromCodePoint(codePoint);
    total += 1;
    if (addCase(hash, outputs, `scalar:${codePoint.toString(16)}`, char)) {
      accepted += 1;
    }
    if (codePoint > MULTI_SHAPE_MAX) continue;
    for (const [shapeIndex, label] of multiShapeLabels(char).entries()) {
      total += 1;
      if (
        addCase(
          hash,
          outputs,
          `shape:${shapeIndex}:${codePoint.toString(16)}`,
          label,
        )
      ) {
        accepted += 1;
      }
    }
  }

  const summary: CorpusSummary = {
    policy: FIREWALL_HOSTNAME_POLICY_VERSION,
    total,
    accepted,
    uniqueOutputs: outputs.size,
    sha256: hash.digest("hex"),
  };
  await writeFile(outputPath, `${[...outputs].sort().join("\n")}\n`, "utf8");
  if (
    summary.total !== EXPECTED_TOTAL ||
    summary.accepted !== EXPECTED_ACCEPTED ||
    summary.uniqueOutputs !== EXPECTED_UNIQUE_OUTPUTS ||
    summary.sha256 !== EXPECTED_SHA256
  ) {
    throw new Error(
      `Firewall hostname corpus changed: ${JSON.stringify(summary)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

await main();
