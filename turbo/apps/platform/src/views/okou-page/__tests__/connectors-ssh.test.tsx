import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  listAgent,
  mockConnectors,
  mockPublicConnectorStatus,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const agentId = "c0000000-0000-4000-8000-000000000001";

function mockCatalog() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
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
    return respond(200, { configuredCount: 0, limit: 64 });
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

test.each([0, 1, 2])(
  "Global SSH entry shows %i configured hosts and opens management without an Agent",
  async (count) => {
    mockCatalog();
    context.mocks.data.agents([]);
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: count, limit: 64 });
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
    expect(entry).toHaveAttribute("href", "/settings/ssh");
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
    click(getConnectorAction("button", "Add host"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
    expect(within(dialog).queryByText("OAuth")).not.toBeInTheDocument();
  },
);

test("SSH participates in search and configured filters without changing generic connector actions", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2, limit: 64 });
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
    return respond(200, { configuredCount: 0, limit: 64 });
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
      return respond(200, { configuredCount: 0, limit: 64 });
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

test("Another owner's Agent filter never requests or displays SSH access", async () => {
  mockCatalog();
  context.mocks.data.agents([
    { ...listAgent(agentId, "Shared"), ownerId: "another-owner" },
  ]);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2, limit: 64 });
  });
  await page(`/connectors?keywords=ssh&connection=agent:${agentId}`);
  await screen.findByText(/No connectors for this agent/);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
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
    return respond(200, { configuredCount: exists ? 1 : 0, limit: 64 });
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
