const uppercasePrivateTokenPattern = /\b[A-Z][A-Z0-9_]{3,}\b/g;
// Private objects may use credential-like keys; avoid collecting generic keys such as "id".
const credentialTermPattern =
  "(?:secret|token|credential|password|private|api[-_]?key|access[-_]?key|client[-_]?secret|refresh[-_]?token)";
const credentialPrefixPattern =
  "(?:sk|pk|rk|xaat|gh[pousr]|github_pat|xox[a-z]?)";
function credentialTokenPattern(): RegExp {
  return new RegExp(
    `\\b(?:${credentialPrefixPattern}[-_][A-Za-z0-9._-]{8,}|(?=[A-Za-z0-9._-]{8,}\\b)(?=[A-Za-z0-9._-]*${credentialTermPattern})[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)\\b`,
    "gi",
  );
}

function credentialKeyPattern(): RegExp {
  return new RegExp(
    `^(?:${credentialPrefixPattern}[-_][A-Za-z0-9._-]{8,}|(?=[A-Za-z0-9._-]{8,}$)(?=[A-Za-z0-9._-]*${credentialTermPattern})[A-Za-z0-9]+(?:[._-]?[A-Za-z0-9]+)*)$`,
    "i",
  );
}

export function privateTokenMatches(value: string): readonly string[] {
  const matches = new Set<string>();
  for (const match of value.matchAll(uppercasePrivateTokenPattern)) {
    matches.add(match[0]);
  }
  for (const match of value.matchAll(credentialTokenPattern())) {
    matches.add(match[0]);
  }
  return [...matches];
}

export function isPrivateTokenLikeKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]{3,}$/.test(key) || credentialKeyPattern().test(key);
}
