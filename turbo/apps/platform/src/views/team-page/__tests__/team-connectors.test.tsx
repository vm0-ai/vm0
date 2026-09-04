import { screen, waitFor, within } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorsContract,
  customConnectorByIdContract,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  DEEPWIKI_CONNECTOR_ID,
  RESEARCH_AGENT_ID,
  SUPPORT_AGENT_ID,
  acmeConnectorFixture,
  agentFixture,
  catalogConnectorFixture,
  deepWikiConnectorFixture,
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();

interface ConnectorSurfaceOptions {
  readonly catalog?: readonly PublicConnectorCatalogStatusItem[];
  readonly customConnectors?: readonly CustomConnectorResponse[];
  readonly initialBuiltInByAgent?: Readonly<Record<string, readonly string[]>>;
  readonly initialCustomByAgent?: Readonly<
    Record<string, readonly AgentCustomConnectorGrant[]>
  >;
  readonly failBuiltInSaveForAgentId?: string;
  readonly failPermissionGrants?: boolean;
  readonly onBuiltInSave?: (args: {
    readonly agentId: string;
    readonly connectorSlugs: readonly string[];
    readonly operation: "add" | "remove" | "replace" | undefined;
  }) => void;
  readonly onCustomSave?: (args: {
    readonly agentId: string;
    readonly grants: readonly AgentCustomConnectorGrant[];
    readonly operation: "add" | "remove" | "replace" | undefined;
  }) => void;
}

function applyStringOperation(
  current: readonly string[],
  requested: readonly string[],
  operation: "add" | "remove" | "replace" | undefined,
): string[] {
  if (operation === "add") {
    return Array.from(new Set([...current, ...requested]));
  }
  if (operation === "remove") {
    return current.filter((value) => {
      return !requested.includes(value);
    });
  }
  return [...requested];
}

function applyGrantOperation(
  current: readonly AgentCustomConnectorGrant[],
  requested: readonly AgentCustomConnectorGrant[],
  operation: "add" | "remove" | "replace" | undefined,
): AgentCustomConnectorGrant[] {
  if (operation === "add") {
    const next = new Map(
      current.map((grant) => {
        return [grant.customConnectorId, grant] as const;
      }),
    );
    for (const grant of requested) {
      next.set(grant.customConnectorId, grant);
    }
    return [...next.values()];
  }
  if (operation === "remove") {
    const removedIds = new Set(
      requested.map((grant) => {
        return grant.customConnectorId;
      }),
    );
    return current.filter((grant) => {
      return !removedIds.has(grant.customConnectorId);
    });
  }
  return [...requested];
}

function mockConnectorSurface(
  testContextValue: TestContext,
  options: ConnectorSurfaceOptions = {},
): void {
  const builtInByAgent = new Map(
    Object.entries(options.initialBuiltInByAgent ?? {}).map(
      ([agentId, slugs]) => {
        return [agentId, [...slugs]] as const;
      },
    ),
  );
  const customByAgent = new Map(
    Object.entries(options.initialCustomByAgent ?? {}).map(
      ([agentId, grants]) => {
        return [agentId, [...grants]] as const;
      },
    ),
  );

  testContextValue.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...(options.catalog ?? [])] });
  });
  testContextValue.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [...(options.customConnectors ?? [])],
    });
  });
  testContextValue.mocks.api(
    userPermissionGrantsContract.list,
    ({ respond }) => {
      return options.failPermissionGrants
        ? respond(403, {
            error: {
              code: "FORBIDDEN",
              message: "Permission grants are unavailable",
            },
          })
        : respond(200, []);
    },
  );
  testContextValue.mocks.api(
    userConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: [...(builtInByAgent.get(params.id) ?? [])],
      });
    },
  );
  testContextValue.mocks.api(
    userConnectorsContract.update,
    ({ body, params, respond }) => {
      options.onBuiltInSave?.({
        agentId: params.id,
        connectorSlugs: body.enabledConnectorSlugs,
        operation: body.operation,
      });
      if (params.id === options.failBuiltInSaveForAgentId) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Connector save failed" },
        });
      }
      const next = applyStringOperation(
        builtInByAgent.get(params.id) ?? [],
        body.enabledConnectorSlugs,
        body.operation,
      );
      builtInByAgent.set(params.id, next);
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  testContextValue.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        grants: [...(customByAgent.get(params.id) ?? [])],
      });
    },
  );
  testContextValue.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      options.onCustomSave?.({
        agentId: params.id,
        grants: body.grants,
        operation: body.operation,
      });
      const next = applyGrantOperation(
        customByAgent.get(params.id) ?? [],
        body.grants,
        body.operation,
      );
      customByAgent.set(params.id, next);
      return respond(200, { grants: next });
    },
  );
}

function exactButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function connectorAccessSwitch(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

function linkContaining(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.includes(name) ?? false;
  });
  if (!link) {
    throw new Error(`Link not found: ${name}`);
  }
  return link;
}

async function navigateToAgent(name: string): Promise<void> {
  click(linkContaining("Agents"));
  await screen.findByText(name);
  click(linkContaining(name));
  await screen.findByRole("heading", { name });
}

test("Connector changes for one agent never appear on another agent", async () => {
  const customSaves: string[] = [];
  mockConnectorSurface(context, {
    catalog: [catalogConnectorFixture("github", "GitHub")],
    customConnectors: [
      acmeConnectorFixture({
        permissionBundleRef: "builtin:acme-search@1",
      }),
    ],
    failBuiltInSaveForAgentId: RESEARCH_AGENT_ID,
    onCustomSave: ({ agentId }) => {
      customSaves.push(agentId);
    },
  });
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
    return respond(200, {
      ref: "builtin:acme-search@1",
      permissions: [{ name: "search:run", description: "Run a search" }],
      defaultPolicies: { "search:run": "deny" },
    });
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent"),
      agentFixture(SUPPORT_AGENT_ID, "Support Agent"),
    ],
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("Acme Search");
  click(connectorAccessSwitch("Grant Acme Search access"));
  await screen.findByRole("heading", { name: /Acme Search permissions/i });
  const permissionName = await screen.findByText("search:run");
  const permissionRow = permissionName.closest("div.flex.items-center.gap-3");
  expect(permissionRow).not.toBeNull();
  click(within(permissionRow as HTMLElement).getByText("Allow"));
  click(exactButton("Cancel"));
  await waitFor(() => {
    expect(
      screen.queryByRole("heading", { name: /Acme Search permissions/i }),
    ).not.toBeInTheDocument();
  });

  await navigateToAgent("Support Agent");
  await screen.findByText("Acme Search");
  expect(
    screen.queryByRole("heading", { name: /Acme Search permissions/i }),
  ).not.toBeInTheDocument();
  expect(connectorAccessSwitch("Grant Acme Search access")).toBeVisible();
  expect(customSaves).toStrictEqual([]);

  await navigateToAgent("Research Agent");
  await screen.findByText("GitHub");
  click(connectorAccessSwitch("Grant GitHub access"));
  await waitFor(() => {
    expect(connectorAccessSwitch("Grant GitHub access")).toBeVisible();
  });

  await navigateToAgent("Support Agent");
  await screen.findByText("GitHub");
  expect(connectorAccessSwitch("Grant GitHub access")).toBeVisible();
  expect(
    screen.queryByLabelText("Revoke GitHub access"),
  ).not.toBeInTheDocument();
});

test("An agent with no connected services guides the user to Connectors", async () => {
  mockConnectorSurface(context);
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  const guidance = await screen.findByText(/No connected services yet/i);
  expect(guidance).toBeVisible();
  const connectorLink = linkContaining("Connectors");
  expect(connectorLink).toHaveAttribute("href", "/connectors");
});

test("A user can authorize a connected MCP custom connector for an agent", async () => {
  mockConnectorSurface(context, {
    customConnectors: [deepWikiConnectorFixture()],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
    featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("DeepWiki");
  expect(screen.getByText("https://mcp.deepwiki.com/mcp")).toBeVisible();
  expect(connectorAccessSwitch("Grant DeepWiki access")).toBeVisible();
  expect(
    screen.queryByLabelText("Manage DeepWiki permissions"),
  ).not.toBeInTheDocument();

  click(connectorAccessSwitch("Grant DeepWiki access"));
  await waitFor(() => {
    expect(connectorAccessSwitch("Revoke DeepWiki access")).toBeVisible();
    expect(screen.getByText("Custom connectors saved")).toBeVisible();
  });
});

test("An agent remains identifiable when permission grants cannot load", async () => {
  mockConnectorSurface(context, {
    catalog: [catalogConnectorFixture("axiom", "Axiom")],
    failPermissionGrants: true,
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  const heading = await screen.findByRole("heading", {
    name: "Research Agent",
  });
  const error = await screen.findByText("Failed to load permission grants");
  expect(heading).toBeVisible();
  expect(error).toBeVisible();
});

test("Connector permission management appears only when permissions exist", async () => {
  mockConnectorSurface(context, {
    catalog: [
      catalogConnectorFixture("axiom", "Axiom", {
        externalUsername: "workspace",
        hasPermissions: false,
        permissionCount: 0,
      }),
    ],
    customConnectors: [acmeConnectorFixture()],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("Axiom");
  expect(screen.getByText("Acme Search")).toBeVisible();
  expect(
    screen.queryByLabelText("Manage Axiom permissions"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Manage Acme Search permissions"),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.includes("Manage permissions") ?? false;
    }),
  ).toHaveLength(0);
});

test("Previously authorized MCP access remains revocable after the feature is disabled", async () => {
  const savedAgents: string[] = [];
  mockConnectorSurface(context, {
    customConnectors: [deepWikiConnectorFixture()],
    initialCustomByAgent: {
      [RESEARCH_AGENT_ID]: [
        {
          customConnectorId: DEEPWIKI_CONNECTOR_ID,
          permissionNames: [],
        },
      ],
    },
    onCustomSave: ({ agentId }) => {
      savedAgents.push(agentId);
    },
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
    featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: false },
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("DeepWiki");
  expect(connectorAccessSwitch("Revoke DeepWiki access")).toBeVisible();
  expect(
    screen.queryByLabelText("Grant DeepWiki access"),
  ).not.toBeInTheDocument();

  click(connectorAccessSwitch("Revoke DeepWiki access"));
  await waitFor(() => {
    expect(screen.queryByText("DeepWiki")).not.toBeInTheDocument();
  });
  expect(savedAgents).toStrictEqual([RESEARCH_AGENT_ID]);
});

test("An unconfigured custom connector is not offered to an agent", async () => {
  mockConnectorSurface(context, {
    catalog: [
      catalogConnectorFixture("axiom", "Axiom", {
        externalUsername: "workspace",
      }),
    ],
    customConnectors: [
      acmeConnectorFixture({
        connected: false,
        connectedAccountId: undefined,
        missingRequiredFields: ["apiKey"],
        configuredFieldKeys: [],
      }),
    ],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  const account = await screen.findByText("@workspace");
  expect(account).toBeVisible();
  expect(screen.queryByText("Acme Search")).not.toBeInTheDocument();
});
