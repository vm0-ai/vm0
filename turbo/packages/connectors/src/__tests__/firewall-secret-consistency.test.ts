import { describe, it, expect } from "vitest";
import { connectorTypeSchema, type ConnectorType } from "../connectors";
import {
  getConnectorEnvBindingEntries,
  getConnectorManualGrantFieldNames,
} from "../connector-utils";
import {
  extractFirewallTemplateReferences,
  parseBasicAuthTemplates,
  type FirewallConfig,
} from "../firewall-types";
import { loadRuntimeFirewallEntries } from "./firewall-test-helpers";

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VAR_REF_PREFIX = "$vars.";
const FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS = 60_000;

interface ConnectorAuthSources {
  readonly secretBackedKeys: ReadonlySet<string>;
  readonly variableBackedKeys: ReadonlySet<string>;
}

function isTemplateWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f" ||
    char === "\v"
  );
}

function basicTemplateStartIndexes(template: string): readonly number[] {
  const starts: number[] = [];
  let start = template.indexOf("${{");

  while (start !== -1) {
    let index = start + "${{".length;
    while (index < template.length && isTemplateWhitespace(template[index]!)) {
      index += 1;
    }
    if (template.startsWith("basic(", index)) {
      starts.push(start);
    }
    start = template.indexOf("${{", start + "${{".length);
  }

  return starts;
}

function unparsedBasicTemplateStartIndexes(
  template: string,
): readonly number[] {
  const matches = parseBasicAuthTemplates(template);
  return basicTemplateStartIndexes(template).filter((start) => {
    return !matches.some((match) => {
      return start >= match.start && start < match.end;
    });
  });
}

function expectValidBasicAuthTemplates(
  connectorType: ConnectorType,
  apis: FirewallConfig["apis"],
): void {
  for (const entry of apis) {
    for (const [name, value] of Object.entries(entry.auth.headers ?? {})) {
      expect(
        unparsedBasicTemplateStartIndexes(value),
        `firewall "${connectorType}" auth header "${name}" has malformed basic() templates`,
      ).toStrictEqual([]);
    }

    if (entry.auth.base) {
      expect(
        basicTemplateStartIndexes(entry.auth.base),
        `firewall "${connectorType}" auth.base must not use basic() templates`,
      ).toStrictEqual([]);
    }

    for (const [name, value] of Object.entries(entry.auth.query ?? {})) {
      expect(
        basicTemplateStartIndexes(value),
        `firewall "${connectorType}" auth.query "${name}" must not use basic() templates`,
      ).toStrictEqual([]);
    }
  }
}

function connectorAuthSources(
  connectorType: ConnectorType,
): ConnectorAuthSources {
  const secretBackedKeys = new Set<string>();
  const variableBackedKeys = new Set<string>();

  const envBindingEntries = getConnectorEnvBindingEntries(connectorType);
  const hasEnvBindings = envBindingEntries.length > 0;

  if (hasEnvBindings) {
    for (const { envName, valueRef } of envBindingEntries) {
      if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
        // Firewall auth templates resolve against sandbox env names, not raw
        // OAuth storage keys such as GITHUB_ACCESS_TOKEN.
        secretBackedKeys.add(envName);
      } else if (valueRef.startsWith(CONNECTOR_VAR_REF_PREFIX)) {
        variableBackedKeys.add(envName);
      }
    }
  } else {
    const manualFields = getConnectorManualGrantFieldNames(connectorType);
    manualFields?.secrets.forEach((name) => {
      secretBackedKeys.add(name);
    });
    manualFields?.variables.forEach((name) => {
      variableBackedKeys.add(name);
    });
  }

  return { secretBackedKeys, variableBackedKeys };
}

function connectorPlaceholderKeys(connectorType: ConnectorType): Set<string> {
  const placeholderKeys = new Set<string>();

  const envBindingEntries = getConnectorEnvBindingEntries(connectorType);
  const hasEnvBindings = envBindingEntries.length > 0;

  if (hasEnvBindings) {
    for (const { envName, valueRef } of envBindingEntries) {
      if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
        placeholderKeys.add(envName);
        placeholderKeys.add(valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length));
      }
    }
  } else {
    const manualFields = getConnectorManualGrantFieldNames(connectorType);
    manualFields?.secrets.forEach((name) => {
      placeholderKeys.add(name);
    });
  }

  return placeholderKeys;
}

function assertConnectorType(type: string): asserts type is ConnectorType {
  if (!connectorTypeSchema.safeParse(type).success) {
    throw new Error(`Unknown connector type: ${type}`);
  }
}

/**
 * Verify that every builtin firewall's placeholder names match the
 * secret-backed environment names exposed by the connector that references it.
 *
 * Connector auth-provider methods expose environment names via derived env bindings (e.g. SLACK_TOKEN).
 * API-token connectors expose manual grant fields.
 * The firewall's `placeholders` keys must be a subset of these secret names,
 * otherwise the proxy won't find the secret to inject.
 */
describe("firewall secret name consistency", () => {
  it(
    "keeps firewall placeholder keys aligned with connector secrets",
    async () => {
      for (const [
        connectorType,
        firewall,
      ] of await loadRuntimeFirewallEntries()) {
        assertConnectorType(connectorType);
        const validPlaceholderKeys = connectorPlaceholderKeys(connectorType);
        const placeholderKeys = Object.keys(firewall.placeholders ?? {});
        for (const key of placeholderKeys) {
          expect(
            validPlaceholderKeys.has(key),
            `firewall "${connectorType}" placeholder "${key}" not found in ${connectorType} connector secrets: [${[...validPlaceholderKeys].join(", ")}]`,
          ).toBe(true);
        }
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps firewall basic auth templates valid",
    async () => {
      for (const [
        connectorType,
        firewall,
      ] of await loadRuntimeFirewallEntries()) {
        assertConnectorType(connectorType);
        expectValidBasicAuthTemplates(connectorType, firewall.apis);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps firewall auth templates aligned with connector value sources",
    async () => {
      for (const [
        connectorType,
        firewall,
      ] of await loadRuntimeFirewallEntries()) {
        assertConnectorType(connectorType);
        const { secretBackedKeys, variableBackedKeys } =
          connectorAuthSources(connectorType);
        const references = extractFirewallTemplateReferences(firewall.apis);

        for (const key of references.secrets) {
          expect(
            secretBackedKeys.has(key),
            `firewall "${connectorType}" secrets.${key} is not backed by a connector secret: [${[...secretBackedKeys].join(", ")}]`,
          ).toBe(true);
        }
        for (const key of references.vars) {
          expect(
            variableBackedKeys.has(key),
            `firewall "${connectorType}" vars.${key} is not backed by a connector variable: [${[...variableBackedKeys].join(", ")}]`,
          ).toBe(true);
        }
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );
});
