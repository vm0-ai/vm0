/**
 * Validates Dockerfile content for vm0 image build.
 * Only FROM and RUN instructions are allowed.
 */

const ALLOWED_INSTRUCTIONS = new Set(["FROM", "RUN"]);

export interface DockerfileValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate Dockerfile content.
 * Returns validation result with list of errors if any unsupported instructions found.
 */
export function validateDockerfile(
  content: string,
): DockerfileValidationResult {
  const errors: string[] = [];
  const lines = content.split("\n");
  let inContinuation = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip empty lines (only if not in continuation)
    if (!inContinuation && !trimmed) continue;

    // Skip comments (only if not in continuation)
    if (!inContinuation && trimmed.startsWith("#")) continue;

    // If in continuation, just check if it ends
    if (inContinuation) {
      inContinuation = trimmed.endsWith("\\");
      continue;
    }

    // Extract instruction name (first word before space)
    const match = trimmed.match(/^([A-Za-z]+)\s/);
    if (match) {
      const instruction = match[1]!.toUpperCase();
      if (!ALLOWED_INSTRUCTIONS.has(instruction)) {
        errors.push(`Unsupported instruction: ${instruction} (line ${i + 1})`);
      }
    }

    // Check for continuation
    inContinuation = trimmed.endsWith("\\");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
