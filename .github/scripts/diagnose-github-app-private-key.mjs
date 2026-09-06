import { createPrivateKey } from "node:crypto";

const input = process.env.SOURCE_PRIVATE_KEY_INPUT ?? "";
const candidates = new Map();

function addCandidate(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  candidates.set(name, value);
  candidates.set(
    `${name}+escaped-newlines`,
    value.replaceAll("\\r", "").replaceAll("\\n", "\n"),
  );
}

addCandidate("raw", input);
addCandidate("trimmed", input.trim());

if (
  (input.startsWith('"') && input.endsWith('"')) ||
  (input.startsWith("'") && input.endsWith("'"))
) {
  addCandidate("unquoted", input.slice(1, -1));
}

try {
  const parsed = JSON.parse(input);
  if (typeof parsed === "string") {
    addCandidate("json-string", parsed);
  } else if (parsed && typeof parsed === "object") {
    for (const key of ["private_key", "privateKey", "pem", "value"]) {
      addCandidate(`json-object-${key}`, parsed[key]);
    }
  }
} catch {
  // Classification only: a non-JSON secret is expected for most formats.
}

const assignment = input.match(/^[A-Z0-9_]+=(.*)$/s);
if (assignment?.[1]) {
  addCandidate("assignment-value", assignment[1]);
}

const compactBase64 = input.replaceAll(/\s/gu, "");
if (
  compactBase64.length > 0 &&
  compactBase64.length % 4 === 0 &&
  /^[A-Za-z0-9+/]*={0,2}$/u.test(compactBase64)
) {
  addCandidate(
    "base64",
    Buffer.from(compactBase64, "base64").toString("utf8"),
  );
}

for (const [name, candidate] of candidates) {
  try {
    const key = createPrivateKey(candidate);
    const canonicalPem = key.export({ type: "pkcs8", format: "pem" }).toString();
    process.stderr.write(`GitHub App private key format: ${name}\n`);
    process.stdout.write(canonicalPem.trimEnd().replaceAll("\n", "\\n"));
    process.exit(0);
  } catch {
    // Try the next format without exposing candidate key material.
  }
}

process.stderr.write(
  `${JSON.stringify({
    length: input.length,
    startsPem: input.startsWith("-----BEGIN"),
    containsActualNewline: input.includes("\n"),
    containsEscapedNewline: input.includes("\\n"),
    startsDoubleQuote: input.startsWith('"'),
    startsSingleQuote: input.startsWith("'"),
    containsAssignment: assignment !== null,
    strictBase64: /^[A-Za-z0-9+/\s]*={0,2}$/u.test(input),
  })}\n`,
);
throw new Error("GitHub App private key format was not recognized");
