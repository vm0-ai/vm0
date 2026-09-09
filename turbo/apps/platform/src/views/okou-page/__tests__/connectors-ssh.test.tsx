import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  listAgent,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const agentId = "c0000000-0000-4000-8000-000000000001";

test.each([0, 2])(
  "SSH with %i hosts remains visible in shelves and respects category selection",
  async (configuredCount) => {
    mockCatalog();
    mockPublicConnectorStatus(
      context,
      Array.from({ length: 8 }, (_, index) => {
        return publicStatusItem({
          connectorSlug: connectorSlugSchema.parse(`mail-${index}`),
          label: `Mail ${index}`,
          category: "communication-collaboration",
          popularityRank: index,
          connected: false,
        });
      }),
    );
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount });
    });
    await setupPage({
      context,
      path: "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.SshAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: true,
      },
    });
    await screen.findByTestId("connector-shelf-communication-collaboration");
    await screen.findByRole("heading", { name: "Remote access" });
    expect(getConnectorAction("link", "Manage SSH hosts")).toHaveAttribute(
      "href",
      configuredCount === 0 ? "/connectors/ssh?add=1" : "/connectors/ssh",
    );
    const communication = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.startsWith("Communication");
    });
    if (!communication) {
      throw new Error("Expected the Communication category chip");
    }
    click(communication);
    await screen.findByTestId("connector-category-communication-collaboration");
    expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
    click(getConnectorAction("button", "Remote access1"));
    await screen.findByRole("heading", { name: "Remote access" });
    expect(queryConnectorAction("link", "Manage SSH hosts")).not.toBeNull();
    expect(
      screen.queryByTestId("connector-category-communication-collaboration"),
    ).toBeNull();
  },
);

test("The global card manages visible Agent grants with Connector presentation and search", async () => {
  mockCatalog();
  const otherId = "c0000000-0000-4000-8000-000000000002";
  context.mocks.data.agents([
    listAgent(agentId, "Research"),
    { ...listAgent(otherId, "Shared"), ownerId: "another-owner" },
  ]);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  const grants = new Set<string>();
  context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
    return respond(200, { enabled: grants.has(params.agentId) });
  });
  context.mocks.api(
    agentSshAccessContract.update,
    ({ params, body, respond }) => {
      if (body.enabled) {
        grants.add(params.agentId);
      } else {
        grants.delete(params.agentId);
      }
      return respond(200, { enabled: body.enabled });
    },
  );
  await page("/connectors?keywords=ssh");
  await screen.findByText("Add access");
  click(screen.getByTestId("connector-card-agent-access"));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByRole("switch", {
      name: "Authorize SSH access for Research",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Revoke SSH access for Research",
  });
  expect(screen.getByTestId("connector-card-access-names")).toHaveTextContent(
    "Research",
  );
  click(
    within(dialog).getByRole("switch", {
      name: "Authorize SSH access for Shared",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Revoke SSH access for Shared",
  });
  expect(screen.getByTestId("connector-card-access-names")).toHaveTextContent(
    "2 agents",
  );
  await fill(within(dialog).getByRole("textbox"), "shared");
  expect(within(dialog).queryByText("Research")).toBeNull();
  click(
    within(dialog).getByRole("switch", {
      name: "Revoke SSH access for Shared",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Authorize SSH access for Shared",
  });
  expect(grants).toStrictEqual(new Set([agentId]));
});

function mockCatalog() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: false });
  });
}

async function page(path = "/connectors", enabled = true) {
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.SshAccess]: enabled },
  });
}

test("SSH is absent from global Connectors when disabled, without requesting SSH data", async () => {
  mockCatalog();
  await page("/connectors?keywords=ssh", false);
  await screen.findByText(/No connectors matching/u);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Remote access" }),
  ).not.toBeInTheDocument();
});

test("The remote-access category is localized independently of the SSH service name", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=ssh",
    locale: "fr-FR",
    featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
  });
  await screen.findByRole("heading", { name: "Accès à distance" });
  expect(
    screen.getByTestId("connector-category-remote-access"),
  ).toHaveTextContent("SSH");
});

test("The SSH card tolerates an older API summary with an extra limit field", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    const legacySummary = { configuredCount: 2, limit: 64 };
    return respond(200, legacySummary);
  });
  await page("/connectors?keywords=ssh");
  await screen.findByText("2 hosts configured");
  expect(getConnectorAction("link", "Manage SSH hosts")).toBeInTheDocument();
});

test.each([0, 1, 2])(
  "Global SSH entry shows %i configured hosts and opens management without an Agent",
  async (count) => {
    mockCatalog();
    context.mocks.data.agents([]);
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: count });
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    await page();
    const label =
      count === 0
        ? "Configure SSH hosts for your Agents to execute remote commands."
        : `${count} ${count === 1 ? "host" : "hosts"} configured`;
    await screen.findByText(label);
    const entry = getConnectorAction("link", "Manage SSH hosts");
    expect(entry).toHaveAttribute(
      "href",
      count === 0 ? "/connectors/ssh?add=1" : "/connectors/ssh",
    );
    expect(
      screen.getByRole("heading", { name: "Remote access" }),
    ).toBeInTheDocument();
    const card = screen.getByTestId("connector-category-remote-access");
    expect(
      within(card).queryByText(
        "Configure SSH hosts for your Agents to execute remote commands.",
      ) !== null,
    ).toBe(count === 0);
    expect(
      within(card).queryByText("0 hosts configured"),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByText(/connected|tested/iu),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("connector-category-remote-access"),
    ).toContainElement(entry);
    expect(
      screen.getByText("Connect 1 services for your agents to use."),
    ).toBeInTheDocument();
    click(entry);
    await screen.findByRole("heading", { name: "SSH hosts" });
    if (count !== 0) {
      click(getConnectorAction("button", "Add host"));
    }
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
    expect(within(dialog).queryByText("OAuth")).not.toBeInTheDocument();
  },
);

test("SSH participates in search and configured filters without changing generic connector actions", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  await page();
  await screen.findByText("2 hosts configured");
  const search = screen.getByPlaceholderText("Find connectors");
  await fill(search, "SSH");
  await expect(
    screen.findByText("2 hosts configured"),
  ).resolves.toBeInTheDocument();
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Not connected");
    }),
  );
  await screen.findByText(/No connectors left to connect/);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Connected");
    }),
  );
  await screen.findByText("2 hosts configured");
  await fill(search, "unrelated-provider");
  await screen.findByText(/No connected connectors/);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
});

test("An empty SSH inventory matches Not connected but not Connected", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  await page("/connectors?keywords=ssh&connection=not-connected");
  await screen.findByText(
    "Configure SSH hosts for your Agents to execute remote commands.",
  );
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Connected");
    }),
  );
  await screen.findByText(/No connected connectors/);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
});

test.each([true, false])(
  "Agent filter uses its standalone SSH grant (%s), including no hosts",
  async (enabled) => {
    mockCatalog();
    context.mocks.data.agents([listAgent(agentId, "Research")]);
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled });
    });
    await page(`/connectors?keywords=ssh&connection=agent:${agentId}`);
    await screen.findByText(
      enabled
        ? "Configure SSH hosts for your Agents to execute remote commands."
        : /No connectors for this agent/,
    );
    expect(queryConnectorAction("link", "Manage SSH hosts") !== null).toBe(
      enabled,
    );
  },
);

test("A shared Agent filter uses the current user's SSH grant", async () => {
  mockCatalog();
  context.mocks.data.agents([
    { ...listAgent(agentId, "Shared"), ownerId: "another-owner" },
  ]);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  await page(`/connectors?keywords=ssh&connection=agent:${agentId}`);
  await screen.findByText("2 hosts configured");
  expect(queryConnectorAction("link", "Manage SSH hosts")).not.toBeNull();
});

test("Returning from host management refreshes the SSH card after deleting the last host", async () => {
  mockCatalog();
  let exists = true;
  const host = {
    id: "b0000000-0000-4000-8000-000000000001",
    displayName: "Deployment",
    host: "ssh.example.com",
    port: 22,
    username: "deploy",
    generation: 1,
    learnedHostKey: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: exists ? 1 : 0 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: exists ? [host] : [] });
  });
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    exists = false;
    return respond(204);
  });
  await page();
  await screen.findByText("1 host configured");
  click(getConnectorAction("link", "Manage SSH hosts"));
  await screen.findByText("Deployment");
  click(getConnectorAction("button", "Delete host"));
  const dialog = await screen.findByRole("dialog");
  click(getConnectorAction("button", "Delete host", dialog));
  await screen.findByText(/No SSH hosts configured/);
  click(getConnectorAction("link", "Connectors"));
  await screen.findByText(
    "Configure SSH hosts for your Agents to execute remote commands.",
  );
  expect(getConnectorAction("link", "Manage SSH hosts")).toBeInTheDocument();
});
