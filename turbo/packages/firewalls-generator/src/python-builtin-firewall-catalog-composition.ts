import * as path from "node:path";

import {
  type BuiltinFirewallRuntimeApi,
  type BuiltinFirewallRuntimeFirewall,
  type BuiltinFirewallRuntimePermission,
  type PythonBuiltinFirewallCatalogEntry,
  type PythonBuiltinFirewallCatalogFile,
  renderPythonBuiltinFirewallCatalogFiles,
} from "./python-builtin-firewall-catalog";
import {
  type ConnectorFirewallSourceSetOptions,
  loadConnectorFirewallSourceSet,
} from "./connector-firewall-sources";

export type { PythonBuiltinFirewallCatalogFile };

interface PythonBuiltinFirewallSourcePermission {
  readonly name: string;
  readonly rules: readonly string[];
  readonly description?: string;
}

interface PythonBuiltinFirewallSourceApi {
  readonly base: string;
  readonly auth: unknown;
  readonly permissions?: readonly PythonBuiltinFirewallSourcePermission[];
}

export interface PythonBuiltinFirewallSourceFirewall {
  readonly name: string;
  readonly apis: readonly PythonBuiltinFirewallSourceApi[];
}

interface PythonBuiltinFirewallCatalog {
  readonly firewalls: Record<string, BuiltinFirewallRuntimeFirewall>;
}

interface ComposePythonBuiltinFirewallCatalogOptions {
  readonly modelProviderFirewalls: readonly PythonBuiltinFirewallSourceFirewall[];
}

interface RenderComposedPythonBuiltinFirewallCatalogOptions extends ComposePythonBuiltinFirewallCatalogOptions {
  readonly generatedHeader: readonly string[];
  readonly maxJsonChunkLength?: number;
}

function defaultConnectorSourceSetOptions(): ConnectorFirewallSourceSetOptions {
  return {
    firewallsDir: path.resolve(
      import.meta.dirname,
      "../../connectors/src/firewalls",
    ),
    connectorsDir: path.resolve(
      import.meta.dirname,
      "../../connectors/src/connectors",
    ),
  };
}

function runtimePermission(
  permission: PythonBuiltinFirewallSourcePermission,
): BuiltinFirewallRuntimePermission {
  return {
    name: permission.name,
    rules: permission.rules,
    ...(permission.description !== undefined
      ? { description: permission.description }
      : {}),
  };
}

function runtimeApi(
  api: PythonBuiltinFirewallSourceApi,
): BuiltinFirewallRuntimeApi {
  return {
    base: api.base,
    auth: api.auth,
    ...(api.permissions !== undefined
      ? { permissions: api.permissions.map(runtimePermission) }
      : {}),
  };
}

function runtimeFirewall(
  firewall: PythonBuiltinFirewallSourceFirewall,
): BuiltinFirewallRuntimeFirewall {
  return {
    name: firewall.name,
    apis: firewall.apis.map(runtimeApi),
  };
}

async function connectorFirewallEntries(): Promise<
  readonly PythonBuiltinFirewallCatalogEntry[]
> {
  const { sources } = await loadConnectorFirewallSourceSet(
    defaultConnectorSourceSetOptions(),
  );
  return sources.map((source) => {
    return {
      firewall: runtimeFirewall(source.firewall),
      diagnosticKind: "connector",
    };
  });
}

function modelProviderFirewallEntries(
  modelProviderFirewalls: readonly PythonBuiltinFirewallSourceFirewall[],
): readonly PythonBuiltinFirewallCatalogEntry[] {
  return modelProviderFirewalls.map((firewall) => {
    return {
      firewall: runtimeFirewall(firewall),
      diagnosticKind: "modelProvider",
    };
  });
}

async function buildPythonBuiltinFirewallCatalogEntries({
  modelProviderFirewalls,
}: ComposePythonBuiltinFirewallCatalogOptions): Promise<
  readonly PythonBuiltinFirewallCatalogEntry[]
> {
  return [
    ...(await connectorFirewallEntries()),
    ...modelProviderFirewallEntries(modelProviderFirewalls),
  ];
}

export async function buildPythonBuiltinFirewallCatalog(
  options: ComposePythonBuiltinFirewallCatalogOptions,
): Promise<PythonBuiltinFirewallCatalog> {
  const entries = await buildPythonBuiltinFirewallCatalogEntries(options);
  const firewalls: Record<string, BuiltinFirewallRuntimeFirewall> = {};
  for (const entry of entries) {
    const { name } = entry.firewall;
    if (name in firewalls) {
      throw new Error(`duplicate built-in firewall catalog name: ${name}`);
    }
    firewalls[name] = entry.firewall;
  }
  return { firewalls };
}

export async function renderComposedPythonBuiltinFirewallCatalogFiles({
  generatedHeader,
  maxJsonChunkLength,
  modelProviderFirewalls,
}: RenderComposedPythonBuiltinFirewallCatalogOptions): Promise<
  readonly PythonBuiltinFirewallCatalogFile[]
> {
  return renderPythonBuiltinFirewallCatalogFiles({
    entries: await buildPythonBuiltinFirewallCatalogEntries({
      modelProviderFirewalls,
    }),
    generatedHeader,
    maxJsonChunkLength,
  });
}
