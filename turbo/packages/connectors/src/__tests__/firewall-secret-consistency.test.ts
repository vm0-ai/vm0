import { describe, it, expect } from "vitest";
import { connectorTypeSchema, type ConnectorType } from "../connectors";
import {
  getConnectorEnvBindings,
  getConnectorManualGrantFieldNames,
} from "../connector-utils";
import {
  extractFirewallTemplateReferences,
  parseBasicAuthTemplates,
  type FirewallConfig,
} from "../firewall-types";
import { getConnectorFirewall, isFirewallConnectorType } from "../firewalls";

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VAR_REF_PREFIX = "$vars.";

const PLATFORM_INJECTED_SECRET_NAMES: Partial<
  Record<string, readonly string[]>
> = {
  "google-ads": ["GOOGLE_ADS_DEVELOPER_TOKEN"],
};

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

  const envBindings = getConnectorEnvBindings(connectorType);
  const hasEnvBindings = Object.keys(envBindings).length > 0;

  if (hasEnvBindings) {
    for (const [envName, valueRef] of Object.entries(envBindings)) {
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

  for (const name of PLATFORM_INJECTED_SECRET_NAMES[connectorType] ?? []) {
    secretBackedKeys.add(name);
  }

  return { secretBackedKeys, variableBackedKeys };
}

function connectorPlaceholderKeys(connectorType: ConnectorType): Set<string> {
  const placeholderKeys = new Set<string>();

  const envBindings = getConnectorEnvBindings(connectorType);
  const hasEnvBindings = Object.keys(envBindings).length > 0;

  if (hasEnvBindings) {
    for (const [envName, valueRef] of Object.entries(envBindings)) {
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

  for (const name of PLATFORM_INJECTED_SECRET_NAMES[connectorType] ?? []) {
    placeholderKeys.add(name);
  }

  return placeholderKeys;
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
  const connectorTypes = connectorTypeSchema.options;

  for (const connectorType of connectorTypes) {
    if (!isFirewallConnectorType(connectorType)) continue;

    it(`${connectorType} → firewall placeholder keys match connector secrets`, () => {
      const validPlaceholderKeys = connectorPlaceholderKeys(connectorType);

      const firewall = getConnectorFirewall(connectorType);
      const placeholderKeys = Object.keys(firewall.placeholders ?? {});
      for (const key of placeholderKeys) {
        expect(
          validPlaceholderKeys.has(key),
          `firewall "${connectorType}" placeholder "${key}" not found in ${connectorType} connector secrets: [${[...validPlaceholderKeys].join(", ")}]`,
        ).toBe(true);
      }
    });

    it(`${connectorType} → firewall basic auth templates are valid`, () => {
      const firewall = getConnectorFirewall(connectorType);
      expectValidBasicAuthTemplates(connectorType, firewall.apis);
    });

    it(`${connectorType} → firewall auth templates match connector value sources`, () => {
      const { secretBackedKeys, variableBackedKeys } =
        connectorAuthSources(connectorType);
      const firewall = getConnectorFirewall(connectorType);
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
    });
  }
});
