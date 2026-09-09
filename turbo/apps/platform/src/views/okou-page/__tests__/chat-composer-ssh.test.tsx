import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
  OTHER_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";

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
