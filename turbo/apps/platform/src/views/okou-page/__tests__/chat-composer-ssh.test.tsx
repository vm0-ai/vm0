import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  installComposerConnectorFixture,
  builtinConnector,
  SCOUT_AGENT_ID,
  OTHER_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";

const github = connectorSlugSchema.parse("github");
const slack = connectorSlugSchema.parse("slack");
const gmail = connectorSlugSchema.parse("gmail");

function triggerIcons(trigger: HTMLElement) {
  return [...trigger.querySelectorAll('img, svg[role="img"]')].map((icon) => {
    return icon.getAttribute("src") ?? icon.getAttribute("aria-label");
  });
}

test("Opening services retains SSH while refreshing and applies the confirmed grant", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: github, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [github] },
  });
  const refresh = context.mocks.deferred<void>();
  let refreshing = false;
  let enabled = true;
  context.mocks.api(sshConnectionsContract.summary, async ({ respond }) => {
    if (refreshing) {
      await refresh.promise;
    }
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
  });
  const trigger = await findFastControl("button", "Connectors");
  await within(trigger).findByRole("img", { name: "SSH" });
  const expected = ["https://icons.example.test/github.svg", "SSH"];
  expect(triggerIcons(trigger)).toStrictEqual(expected);
  refreshing = true;
  click(trigger);
  await waitFor(() => {
    expect(screen.getByLabelText("Remove SSH")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(triggerIcons(trigger)).toStrictEqual(expected);
  enabled = false;
  refresh.resolve();
  await screen.findByLabelText("Add SSH");
  expect(triggerIcons(trigger)).toStrictEqual([
    "https://icons.example.test/github.svg",
  ]);
});

test.each([2, 3])(
  "SSH follows all builtin services and does not displace %s builtin trigger icons",
  async (count) => {
    const catalog = [
      builtinConnector({ slug: github, label: "GitHub" }),
      builtinConnector({ slug: slack, label: "Slack" }),
      builtinConnector({ slug: gmail, label: "Gmail" }),
    ].slice(0, count);
    installComposerConnectorFixture({
      catalog,
      builtinAuthorizations: {
        [SCOUT_AGENT_ID]: catalog.map((connector) => {
          return connector.slug;
        }),
      },
    });
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 1 });
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled: true });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
    });
    const trigger = await findFastControl("button", "Connectors");
    click(trigger);
    await screen.findByLabelText("Remove SSH");
    const list = screen.getByRole("list", { name: "Connectors" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.at(-1)).toHaveTextContent("SSH");
    expect(
      rows.slice(0, count).every((row) => {
        return !row.textContent?.includes("SSH");
      }),
    ).toBeTruthy();
    const icons = catalog.map((connector) => {
      return `https://icons.example.test/${connector.slug}.svg`;
    });
    await waitFor(() => {
      expect(triggerIcons(trigger)).toStrictEqual(icons.slice(0, 2));
    });
    click(await screen.findByRole("switch", { name: "Disable Cloud browser" }));
    await waitFor(() => {
      expect(triggerIcons(trigger)).toStrictEqual(
        [...icons, "SSH"].slice(0, 3),
      );
    });
  },
);

test("Switching Agents does not retain the previous Agent's enabled SSH icon", async () => {
  installComposerConnectorFixture();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SCOUT_AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
    return respond(200, { enabled: params.agentId === SCOUT_AGENT_ID });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
  });
  const trigger = await findFastControl("button", "Connectors");
  await within(trigger).findByRole("img", { name: "SSH" });
  click(await findFastControl("link", "Other Agent"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${OTHER_AGENT_ID}/chat`);
  });
  const otherTrigger = await findFastControl("button", "Connectors");
  click(otherTrigger);
  await screen.findByLabelText("Add SSH");
  expect(within(otherTrigger).queryByRole("img", { name: "SSH" })).toBeNull();
});

test.each(["workspace", "user"])(
  "Changing %s clears retained SSH presentation while the new owner loads",
  async (changedIdentity) => {
    installComposerConnectorFixture();
    const clerk = context.mocks.clerk();
    const nextOwner = context.mocks.deferred<void>();
    let changing = false;
    context.mocks.api(sshConnectionsContract.summary, async ({ respond }) => {
      if (changing) {
        await nextOwner.promise;
      }
      return respond(200, { configuredCount: 1 });
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled: !changing });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
    });
    const trigger = await findFastControl("button", "Connectors");
    await within(trigger).findByRole("img", { name: "SSH" });
    changing = true;
    act(() => {
      if (changedIdentity === "workspace") {
        clerk.organization({
          activeOrg: { id: "org_ssh_other", name: "Other workspace" },
          memberships: [{ id: "org_ssh_other" }],
        });
      } else {
        clerk.user(
          { id: "other-ssh-user", fullName: "Other user" },
          {
            token: "other-user-token",
          },
        );
      }
      clerk.stateChanged();
    });
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: "SSH" })).toBeNull();
    });
    nextOwner.resolve();
    const nextTrigger = await findFastControl("button", "Connectors");
    click(nextTrigger);
    await screen.findByLabelText("Add SSH");
    expect(within(nextTrigger).queryByRole("img", { name: "SSH" })).toBeNull();
  },
);

test.each([SCOUT_AGENT_ID, OTHER_AGENT_ID])(
  "Chat SSH uses the composer Agent %s, not another Agent's grant",
  async (agentId) => {
    const fixture = installComposerConnectorFixture();
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 2 });
    });
    const grants = new Set([SCOUT_AGENT_ID]);
    const writes: unknown[] = [];
    context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
      return respond(200, { enabled: grants.has(params.agentId) });
    });
    context.mocks.api(
      agentSshAccessContract.update,
      ({ params, body, respond }) => {
        writes.push({ agentId: params.agentId, enabled: body.enabled });
        if (body.enabled) {
          grants.add(params.agentId);
        } else {
          grants.delete(params.agentId);
        }
        return respond(200, body);
      },
    );
    await setupPage({
      context,
      path: `/agents/${agentId}/chat`,
      featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
    });
    click(await findFastControl("button", "Connectors"));
    const enabled = agentId === SCOUT_AGENT_ID;
    const toggle = await screen.findByLabelText(
      enabled ? "Remove SSH" : "Add SSH",
    );
    expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    const row = toggle.closest('[role="listitem"]');
    expect(row).toHaveTextContent("SSH");
    expect(queryFastControl("button", "Manage SSH hosts")).toBeNull();
    click(toggle);
    await screen.findByLabelText(enabled ? "Add SSH" : "Remove SSH");
    expect(writes).toStrictEqual([{ agentId, enabled: !enabled }]);
    expect(fixture.builtinAuthorizationUpdates).toStrictEqual([]);
    expect(fixture.customAuthorizationUpdates).toStrictEqual([]);
  },
);

test.each([true, false])(
  "Chat hides unconfigured SSH and exposes the zero-host setup entry only when enabled (%s)",
  async (enabled) => {
    installComposerConnectorFixture();
    let reads = 0;
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      reads++;
      return respond(200, { configuredCount: 0 });
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SshAccess]: enabled },
    });
    click(await findFastControl("button", "Connectors"));
    click(await findFastControl("button", "Add connectors"));
    const search = await screen.findByPlaceholderText("Find connectors...");
    const dialog = search.closest('[role="dialog"]');
    expect(screen.queryByRole("switch", { name: /SSH/u })).toBeNull();
    expect(reads > 0).toBe(enabled);
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    const entry = queryFastControl("link", "Manage SSH hosts", dialog);
    expect(entry !== null).toBe(enabled);
    if (enabled) {
      click(entry!);
      await screen.findByRole("dialog", { name: "Add host" });
    }
    await waitFor(() => {
      return expect(window.location.pathname).toBe(
        enabled ? "/connectors/ssh" : `/agents/${SCOUT_AGENT_ID}/chat`,
      );
    });
    expect(window.location.search).toBe("");
  },
);
