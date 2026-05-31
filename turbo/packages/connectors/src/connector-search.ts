import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorAccessConfig,
  type ConnectorAuthMethodConfig,
  type ConnectorConfig,
  type ConnectorType,
} from "./connectors";
import { getConnectorEnvBindingEntries } from "./connector-utils";

/**
 * Result of a connector search hit, one per matched connector type.
 */
export interface ConnectorSearchResult {
  readonly type: ConnectorType;
  readonly score: number;
  /** Short label describing the matched field (e.g. "type", "env:GH_TOKEN", "tag:vcs", "token:gh"). */
  readonly matchedField: string;
}

export interface ConnectorSearchOutput {
  /** Results sorted by score desc then type asc, already capped at `limit`. */
  readonly results: readonly ConnectorSearchResult[];
  /** Total candidates above the minimum threshold, before applying `limit`. */
  readonly total: number;
}

const TOKEN_BOUNDARY = /[_\-\s]+/;
const CASE_BOUNDARY = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const MIN_SCORE = 10;

/**
 * Split a string into lowercase tokens on `_`, `-`, whitespace, and
 * camel/Pascal case boundaries. Digits stay attached to the preceding letters
 * (e.g. `v2`). Empty tokens are dropped and duplicates deduped.
 */
function tokenize(input: string): Set<string> {
  const tokens = new Set<string>();
  for (const chunk of input.split(TOKEN_BOUNDARY)) {
    if (!chunk) continue;
    for (const sub of chunk.split(CASE_BOUNDARY)) {
      const lower = sub.toLowerCase();
      if (lower) tokens.add(lower);
    }
  }
  return tokens;
}

function connectorAccessEnvBindings(
  access: ConnectorAccessConfig,
): Record<string, string> {
  switch (access.kind) {
    case "static":
    case "refresh-token":
      return access.envBindings;
    case "none":
      return {};
  }
}

function getManualGrantFields(
  method: ConnectorAuthMethodConfig,
): Record<string, unknown> | undefined {
  return method.grant.kind === "manual" ? method.grant.fields : undefined;
}

function listSecretNames(config: ConnectorConfig): string[] {
  const names: string[] = [];
  for (const method of Object.values(config.authMethods)) {
    for (const name of Object.keys(getManualGrantFields(method) ?? {})) {
      names.push(name);
    }
    for (const valueRef of Object.values(
      connectorAccessEnvBindings(method.access),
    )) {
      if (valueRef.startsWith("$secrets.")) {
        names.push(valueRef.slice("$secrets.".length));
      }
    }
  }
  return names;
}

type ScoreHit = { score: number; matchedField: string };

function listEnvNames(type: ConnectorType): string[] {
  return [
    ...new Set(
      getConnectorEnvBindingEntries(type).map(({ envName }) => {
        return envName;
      }),
    ),
  ];
}

function findExactMatch(
  keywordLower: string,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  if (type.toLowerCase() === keywordLower) {
    return { score: 100, matchedField: "type" };
  }
  for (const envName of listEnvNames(type)) {
    if (envName.toLowerCase() === keywordLower) {
      return { score: 90, matchedField: `env:${envName}` };
    }
  }
  if (config.label.toLowerCase() === keywordLower) {
    return { score: 80, matchedField: "label" };
  }
  const tags = config.tags ?? [];
  for (const tag of tags) {
    if (tag === keywordLower) {
      return { score: 70, matchedField: `tag:${tag}` };
    }
  }
  return null;
}

function findSubstringMatch(
  keywordLower: string,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  if (type.toLowerCase().includes(keywordLower)) {
    return { score: 50, matchedField: "type" };
  }
  if (config.label.toLowerCase().includes(keywordLower)) {
    return { score: 50, matchedField: "label" };
  }
  for (const envName of listEnvNames(type)) {
    if (envName.toLowerCase().includes(keywordLower)) {
      return { score: 40, matchedField: `env:${envName}` };
    }
  }
  for (const name of listSecretNames(config)) {
    if (name.toLowerCase().includes(keywordLower)) {
      return { score: 30, matchedField: `secret:${name}` };
    }
  }
  const tags = config.tags ?? [];
  for (const tag of tags) {
    if (tag.includes(keywordLower)) {
      return { score: 25, matchedField: `tag:${tag}` };
    }
  }
  return null;
}

function collectCandidateTokens(
  type: ConnectorType,
  config: ConnectorConfig,
): Set<string> {
  const tokens = new Set<string>();
  const sources = [
    type,
    config.label,
    ...listEnvNames(type),
    ...listSecretNames(config),
    ...(config.tags ?? []),
  ];
  for (const source of sources) {
    for (const token of tokenize(source)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function findTokenIntersection(
  keywordTokens: Set<string>,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  const candidateTokens = collectCandidateTokens(type, config);
  let intersection = 0;
  let firstCommon = "";
  for (const token of keywordTokens) {
    if (candidateTokens.has(token)) {
      intersection++;
      if (!firstCommon) firstCommon = token;
    }
  }
  if (intersection === 0) return null;
  return { score: 10 * intersection, matchedField: `token:${firstCommon}` };
}

function scoreConnector(
  keywordLower: string,
  keywordTokens: Set<string>,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  const exact = findExactMatch(keywordLower, type, config);
  if (exact) return exact;

  const candidates: ScoreHit[] = [];
  const substring = findSubstringMatch(keywordLower, type, config);
  if (substring) candidates.push(substring);
  const token = findTokenIntersection(keywordTokens, type, config);
  if (token) candidates.push(token);

  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => {
    return a.score >= b.score ? a : b;
  });
  if (best.score < MIN_SCORE) return null;
  return best;
}

/**
 * Search the connector catalog by weighted multi-field ranking.
 *
 * Matches the keyword against type keys, labels, environment names, secret names,
 * and `tags`. Score is the max over matched rules (never a sum). Results with
 * score below the minimum threshold are dropped. Sort order: score desc, then
 * type asc.
 */
export function searchConnectors(
  keyword: string,
  limit: number,
  filter?: (type: ConnectorType) => boolean,
): ConnectorSearchOutput {
  const trimmed = keyword.trim();
  if (!trimmed) return { results: [], total: 0 };

  const keywordLower = trimmed.toLowerCase();
  const keywordTokens = tokenize(trimmed);

  const hits: ConnectorSearchResult[] = [];
  for (const type of CONNECTOR_TYPE_KEYS) {
    if (filter && !filter(type)) continue;
    const config = CONNECTOR_TYPES[type];
    const hit = scoreConnector(keywordLower, keywordTokens, type, config);
    if (!hit) continue;
    hits.push({ type, score: hit.score, matchedField: hit.matchedField });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.type.localeCompare(b.type);
  });

  const capped = limit > 0 ? hits.slice(0, limit) : hits;
  return { results: capped, total: hits.length };
}
