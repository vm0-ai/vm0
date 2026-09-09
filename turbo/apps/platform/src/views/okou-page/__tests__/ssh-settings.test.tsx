import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { catalogConnectorFixture } from "../../team-page/__tests__/team-page-test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_ssh_settings";
const auth = Object.freeze({
  user: { id: "test-user-123", fullName: "Test User" },
  organization: {
    activeOrg: { id: orgId, name: "SSH test organization" },
    memberships: [{ id: orgId }],
  },
});
const id = "b0000000-0000-4000-8000-000000000001";
const agentId = "c0000000-0000-4000-8000-000000000001";
const base: SshConnectionResponse = Object.freeze({
  id,
  displayName: "Deployment",
  host: "ssh.example.com",
  port: 22,
  username: "deploy",
  generation: 1,
  learnedHostKey: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
async function page(path = "/connectors/ssh", enabled = true) {
  await setupPage({
    context,
    path,
    auth,
    featureSwitches: { [FeatureSwitchKey.SshAccess]: enabled },
  });
}

test("SSH is a Connectors detail page with a working return breadcrumb", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page();
  await screen.findByText("0 / 64 hosts configured");
  expect(pathname()).toBe("/connectors/ssh");
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).getByText("SSH")).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    getAction(
      "link",
      "Connectors",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  ).toHaveAttribute("aria-current", "page");
  click(getAction("link", "Connectors", breadcrumb));
  await screen.findByPlaceholderText("Find connectors");
  expect(pathname()).toBe("/connectors");
});

test("Mobile SSH management retains its Connectors section and return navigation", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page();
  await screen.findByText("0 / 64 hosts configured");
  const name = await screen.findByTestId("breadcrumb-name");
  expect(name).toHaveTextContent("SSH");
  const section = name.parentElement;
  if (!section) {
    throw new Error("Mobile breadcrumb section is missing");
  }
  click(getAction("link", "Connectors", section));
  await screen.findByPlaceholderText("Find connectors");
  expect(pathname()).toBe("/connectors");
});

test.each([
  { count: 0, label: "0 / 64 hosts configured" },
  { count: 1, label: "1 / 64 host configured" },
  { count: 2, label: "2 / 64 hosts configured" },
])(
  "Shows the translated configured host count for $count hosts",
  async ({ count, label }) => {
    const hosts = Array.from({ length: count }, (_, index) => {
      return { ...base, id: `b0000000-0000-4000-8000-00000000000${index}` };
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    await page();
    const configuredCount = await screen.findByText(label);
    expect(configuredCount).toBeInTheDocument();
  },
);

test("Create a configured host with write-only credentials, then edit without replacing them", async () => {
  let hosts: SshConnectionResponse[] = [];
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    hosts = [base];
    return respond(201, base);
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    hosts = [{ ...base, displayName: "Renamed", generation: 2 }];
    return respond(200, hosts[0]!);
  });
  await page();
  await screen.findByText(
    "No SSH hosts configured. Add a host to make it available to Agents with SSH access.",
  );
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Deployment");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "ssh.example.com",
  );
  await fill(within(dialog).getByLabelText("SSH username"), "deploy");
  await fill(within(dialog).getByLabelText("Private key"), " key-canary\n");
  await fill(
    within(dialog).getByLabelText("Passphrase (optional)"),
    " passphrase-canary ",
  );
  click(getAction("button", "Save", dialog));
  await screen.findByText("Configured · connectivity not tested");
  expect(requests).toStrictEqual([
    {
      displayName: "Deployment",
      host: "ssh.example.com",
      port: 22,
      username: "deploy",
      privateKey: " key-canary\n",
      passphrase: " passphrase-canary ",
    },
  ]);
  expect(document.body.textContent).not.toContain("canary");
  click(getAction("button", "Edit host"));
  const edit = await screen.findByRole("dialog");
  expect(within(edit).queryByLabelText("Private key")).not.toBeInTheDocument();
  await fill(within(edit).getByLabelText("Display name"), "Renamed");
  click(getAction("button", "Save", edit));
  await screen.findByText("Renamed");
  expect(requests[1]).toStrictEqual({
    displayName: "Renamed",
    host: "ssh.example.com",
    port: 22,
    username: "deploy",
    expectedGeneration: 1,
  });
});

test.each(["Display name", "Public hostname or IP address", "SSH username"])(
  "Whitespace-only %s is rejected visibly before submission and can be corrected",
  async (label) => {
    let hosts: SshConnectionResponse[] = [];
    let creates = 0;
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    context.mocks.api(sshConnectionsContract.create, ({ respond }) => {
      creates++;
      hosts = [base];
      return respond(201, base);
    });
    await page();
    click(
      await waitFor(() => {
        return getAction("button", "Add host");
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await fill(within(dialog).getByLabelText("Display name"), "Deployment");
    await fill(
      within(dialog).getByLabelText("Public hostname or IP address"),
      "ssh.example.com",
    );
    await fill(within(dialog).getByLabelText("SSH username"), "deploy");
    await fill(within(dialog).getByLabelText("Private key"), "test-key");
    const field = within(dialog).getByLabelText(label);
    await fill(field, "   ");
    click(getAction("button", "Save", dialog));
    expect(field).toBeInvalid();
    expect(creates).toBe(0);
    expect(dialog).toBeInTheDocument();
    await fill(field, "valid");
    click(getAction("button", "Save", dialog));
    await screen.findByText("Configured · connectivity not tested");
    expect(creates).toBe(1);
  },
);

test("Credential replacement is explicit and fields clear before the request finishes and on close", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  const ready = context.mocks.deferred<void>();
  const requests: unknown[] = [];
  context.mocks.api(
    sshConnectionsContract.update,
    async ({ body, respond }) => {
      requests.push(body);
      await ready.promise;
      return respond(200, { ...base, generation: 2 });
    },
  );
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Replace credentials");
    }),
  );
  let dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Private key"), "close-canary");
  click(getAction("button", "Cancel", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(getAction("button", "Replace credentials"));
  dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
  await fill(within(dialog).getByLabelText("Private key"), " new-key\n");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(requests).toStrictEqual([
      {
        expectedGeneration: 1,
        credentials: { privateKey: " new-key\n", passphrase: null },
      },
    ]);
  });
  expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
  ready.resolve();
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test("Reset requires confirmation, generation conflict refreshes without retry, and deletion is explicit", async () => {
  const learned = {
    ...base,
    learnedHostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" },
  };
  let hosts = [learned];
  let resets = 0;
  let deleted = false;
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  context.mocks.api(
    sshConnectionsContract.resetHostKey,
    ({ body, respond }) => {
      resets++;
      expect(body).toStrictEqual({ expectedGeneration: 1 });
      hosts = [{ ...learned, generation: 2 }];
      return respond(409, { error: { code: "CONFLICT", message: "changed" } });
    },
  );
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    deleted = true;
    hosts = [];
    return respond(204);
  });
  await page();
  await screen.findByText("SHA256:fixture");
  click(getAction("button", "Reset host key"));
  const reset = await screen.findByRole("dialog");
  expect(resets).toBe(0);
  expect(
    within(reset).getByText(/Only reset after independently verifying/),
  ).toBeInTheDocument();
  click(getAction("button", "Reset host key", reset));
  await screen.findByRole("alert");
  expect(resets).toBe(1);
  click(getAction("button", "Delete host"));
  const remove = await screen.findByRole("dialog");
  expect(deleted).toBeFalsy();
  click(getAction("button", "Delete host", remove));
  await screen.findByText(
    "No SSH hosts configured. Add a host to make it available to Agents with SSH access.",
  );
  expect(deleted).toBeTruthy();
});

test("Disabled SSH has no management fetches or controls", async () => {
  let requests = 0;
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    requests++;
    return respond(200, { connections: [] });
  });
  await page("/connectors/ssh", false);
  await screen.findByText("SSH access is not available for this account.");
  expect(requests).toBe(0);
  expect(queryAction("button", "Add host")).not.toBeInTheDocument();
});

test("An ordinary owner can manage SSH when the feature flag is enabled", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await setupPage({
    context,
    path: "/connectors/ssh",
    featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
  });
  await screen.findByText("Configured · connectivity not tested");
  expect(getAction("button", "Add host")).toBeEnabled();
});

test("Changing owner closes the credential form and clears its fields", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Replace credentials");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Private key"), "old-owner-canary");
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "other-owner", fullName: "Other Owner" },
    { token: "other-token" },
  );
  clerk.stateChanged();
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(
    screen.queryByDisplayValue("old-owner-canary"),
  ).not.toBeInTheDocument();
});

test("An admin who is not the Agent owner gets no SSH grant control or grant fetch", async () => {
  const agent: AgentResponse = {
    agentId,
    ownerId: "another-owner",
    displayName: "Shared Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  let requests = 0;
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    requests++;
    return respond(200, { enabled: true });
  });
  await page(`/agents/${agentId}?tab=authorization`);
  await screen.findByText(/No connected services yet/);
  expect(
    screen.queryByRole("switch", { name: /SSH access/ }),
  ).not.toBeInTheDocument();
  expect(requests).toBe(0);
});

test("Owner Authorization offers SSH access while Profile has no SSH controls", async () => {
  const agent: AgentResponse = {
    agentId,
    ownerId: auth.user.id,
    displayName: "Research",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  let enabled = false;
  context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
    expect(params.agentId).toBe(agentId);
    return respond(200, { enabled });
  });
  context.mocks.api(
    agentSshAccessContract.update,
    ({ body, params, respond }) => {
      expect(params.agentId).toBe(agentId);
      enabled = body.enabled;
      return respond(200, body);
    },
  );
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page(`/agents/${agentId}?tab=profile`);
  await screen.findByDisplayValue("Research");
  expect(
    screen.queryByRole("switch", { name: /SSH access/ }),
  ).not.toBeInTheDocument();
  expect(queryAction("button", "Manage SSH hosts")).not.toBeInTheDocument();
  click(getAction("button", "Authorization"));
  const control = await screen.findByRole("switch", {
    name: "Grant SSH access",
  });
  expect(control).not.toBeChecked();
  expect(getAction("button", "Manage SSH hosts")).toBeInTheDocument();
  expect(
    screen.queryByText(/No connected services yet/),
  ).not.toBeInTheDocument();
  click(control);
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: "Revoke SSH access" }),
    ).toBeChecked();
  });
  click(screen.getByRole("switch", { name: "Revoke SSH access" }));
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: "Grant SSH access" }),
    ).not.toBeChecked();
  });
  click(getAction("button", "Manage SSH hosts"));
  await screen.findByRole("heading", { name: "SSH hosts" });
  expect(pathname()).toBe("/connectors/ssh");
});

test.each([false, true])(
  "SSH uses connector authorization search and survives ordinary permission failure (%s)",
  async (ordinaryFailure) => {
    const agent: AgentResponse = {
      agentId,
      ownerId: auth.user.id,
      displayName: "Research",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "private",
    };
    context.mocks.data.agents([agent]);
    context.mocks.api(agentsByIdContract.get, ({ respond }) => {
      return respond(200, agent);
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled: true });
    });
    const github = catalogConnectorFixture(
      connectorSlugSchema.parse("github"),
      "GitHub",
      { hasPermissions: false },
    );
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [github] });
    });
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
      return ordinaryFailure
        ? respond(403, {
            error: {
              message: "Permission grants unavailable",
              code: "FORBIDDEN",
            },
          })
        : respond(200, []);
    });
    await page(`/agents/${agentId}?tab=authorization`);
    await screen.findByRole("switch", { name: "Revoke SSH access" });
    if (!ordinaryFailure) {
      await screen.findByRole("switch", { name: "Grant GitHub access" });
    } else {
      await screen.findByText("Failed to load permission grants");
    }
    click(getAction("button", "Find connectors"));
    const search = screen.getByPlaceholderText("Find connectors...");
    await fill(search, "ssh");
    expect(
      screen.getByRole("switch", { name: "Revoke SSH access" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("switch", { name: /GitHub access/ }),
    ).not.toBeInTheDocument();
    await fill(search, "github");
    expect(
      screen.queryByRole("switch", { name: /SSH access/ }),
    ).not.toBeInTheDocument();
    await fill(search, "");
    expect(
      screen.getByRole("switch", { name: "Revoke SSH access" }),
    ).toBeChecked();
  },
);
