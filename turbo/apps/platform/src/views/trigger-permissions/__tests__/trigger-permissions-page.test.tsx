import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  type SetUnattendedTriggerPermissionPolicyRequest,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup();

const CURRENT_USER_ID = "test-user-123";
const AGENT_ID = "c0000000-0000-4000-a000-000000000301";
const WORKFLOW_ID = "d0000000-0000-4000-a000-000000000401";
const TRIGGER_ID = "workflow-trigger-perm-editor";
const SLACK_PERMISSION_LABEL = "Access workspace analytics data";
const GMAIL_DRAFTS_WRITE_LABEL = "Create, update, and delete Gmail drafts.";
const GMAIL_MESSAGES_SEND_LABEL = "Send Gmail messages directly.";

function trigger(
  unattendedPermissionPolicy: ZeroWorkflowTriggerSummary["unattendedPermissionPolicy"],
  unattendedConnectorRefs: ZeroWorkflowTriggerSummary["unattendedConnectorRefs"] = [],
): ZeroWorkflowTriggerSummary {
  return {
    id: TRIGGER_ID,
    kind: "schedule",
    schedule: { type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" },
    scheduleSummary: "Every day at 9:00 AM",
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_perm_editor",
    nextRunAt: null,
    lastRunAt: null,
    unattendedConnectorRefs,
    unattendedPermissionPolicy,
  };
}

function workflow(
  triggerSummary: ZeroWorkflowTriggerSummary,
): ZeroWorkflowDetailResponse {
  return {
    id: WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "perm-workflow",
    displayName: "Perm Workflow",
    description: null,
    visibility: "private",
    requestToPublish: false,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-17T12:00:00.000Z",
    updatedAt: "2026-06-17T12:00:00.000Z",
    instruction: "Do the thing.",
    files: [],
    fileContents: [],
    triggers: [triggerSummary],
  };
}

/**
 * Mocks the workflow-detail GET and the trigger setPermissionPolicy PUT over a
 * single shared policy, so the post-save workflow reload reflects the latest
 * saved policy the way the real backend would. Returns the captured request
 * bodies.
 */
function mockTriggerPolicyApis(
  initialPolicy: ZeroWorkflowTriggerSummary["unattendedPermissionPolicy"],
  initialConnectorRefs: ZeroWorkflowTriggerSummary["unattendedConnectorRefs"] = [],
): SetUnattendedTriggerPermissionPolicyRequest[] {
  const bodies: SetUnattendedTriggerPermissionPolicyRequest[] = [];
  let currentPolicy = initialPolicy;
  let currentConnectorRefs = initialConnectorRefs;

  context.mocks.api(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    if (params.workflowId !== WORKFLOW_ID) {
      return respond(404, { error: { code: "NOT_FOUND", message: "missing" } });
    }
    return respond(200, workflow(trigger(currentPolicy, currentConnectorRefs)));
  });

  context.mocks.api(
    zeroWorkflowTriggersContract.setPermissionPolicy,
    ({ body, respond }) => {
      bodies.push(body);
      if (body.unattendedConnectorRefs !== undefined) {
        currentConnectorRefs = body.unattendedConnectorRefs;
      }
      currentPolicy = body.unattendedPermissionPolicy ?? null;
      return respond(200, trigger(currentPolicy, currentConnectorRefs));
    },
  );

  return bodies;
}

function permissionRow(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const row = label.parentElement?.parentElement;
  if (!row) {
    throw new Error("Expected a permission row");
  }
  return row;
}

function button(label: string, container?: HTMLElement): HTMLElement {
  const match = queryAllByRoleFast("button", container).find((el) => {
    return el.textContent?.trim() === label;
  });
  if (!match) {
    throw new Error(`Expected a "${label}" button`);
  }
  return match;
}

function editorPath(connectorRef: string): string {
  return `/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/permissions?ref=${connectorRef}`;
}

describe("trigger permissions page", () => {
  it("shows a connector picker when no connector ref is selected", async () => {
    mockTriggerPolicyApis(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/permissions`,
    });

    await waitFor(() => {
      expect(screen.getByText("Trigger permissions")).toBeInTheDocument();
    });

    const slackLink = screen.getByText("Slack").closest("a");
    expect(slackLink).toHaveAttribute(
      "href",
      `/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/permissions?ref=slack`,
    );
  });

  it("toggles connector access from the connector picker", async () => {
    const bodies = mockTriggerPolicyApis(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/permissions`,
    });

    await waitFor(() => {
      expect(screen.getByText("Trigger permissions")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("switch", { name: "Enable Slack" }));

    await waitFor(() => {
      expect(bodies).toStrictEqual([
        {
          unattendedConnectorRefs: ["slack"],
          unattendedPermissionPolicy: null,
        },
      ]);
    });
  });

  it("rejects an unknown connector ref", async () => {
    mockTriggerPolicyApis(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/permissions?ref=not-a-connector`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unknown connector: not-a-connector"),
      ).toBeInTheDocument();
    });
  });

  it("allows a permission and saves the merged policy", async () => {
    const bodies = mockTriggerPolicyApis(null);

    detachedSetupPage({ context, path: editorPath("slack") });

    await waitFor(() => {
      expect(screen.getByText(SLACK_PERMISSION_LABEL)).toBeInTheDocument();
    });

    // Save is disabled until something changes.
    expect(button("Save")).toBeDisabled();

    await user.click(button("Allow", permissionRow(SLACK_PERMISSION_LABEL)));
    await user.click(button("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(bodies).toStrictEqual([
      {
        unattendedConnectorRefs: [],
        unattendedPermissionPolicy: {
          slack: { policies: { "admin.analytics:read": "allow" } },
        },
      },
    ]);
  });

  it("clears the policy to null when the only allowed permission is denied", async () => {
    const bodies = mockTriggerPolicyApis({
      slack: { policies: { "admin.analytics:read": "allow" } },
    });

    detachedSetupPage({ context, path: editorPath("slack") });

    await waitFor(() => {
      expect(screen.getByText(SLACK_PERMISSION_LABEL)).toBeInTheDocument();
    });

    await user.click(button("Deny", permissionRow(SLACK_PERMISSION_LABEL)));
    await user.click(button("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(bodies).toStrictEqual([
      { unattendedConnectorRefs: [], unattendedPermissionPolicy: null },
    ]);
  });

  it("shows Gmail connector metadata defaults when no trigger policy is saved", async () => {
    mockTriggerPolicyApis(null);

    detachedSetupPage({ context, path: editorPath("gmail") });

    await waitFor(() => {
      expect(screen.getByText(GMAIL_DRAFTS_WRITE_LABEL)).toBeInTheDocument();
    });

    expect(
      button("Allow", permissionRow(GMAIL_DRAFTS_WRITE_LABEL)),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      button("Deny", permissionRow(GMAIL_MESSAGES_SEND_LABEL)),
    ).toHaveAttribute("aria-pressed", "true");
    expect(button("Save")).toBeDisabled();
  });

  it("preserves an explicit Gmail deny override for metadata-default allowed permissions", async () => {
    const bodies = mockTriggerPolicyApis(null);

    detachedSetupPage({ context, path: editorPath("gmail") });

    await waitFor(() => {
      expect(screen.getByText(GMAIL_DRAFTS_WRITE_LABEL)).toBeInTheDocument();
    });

    await user.click(button("Deny", permissionRow(GMAIL_DRAFTS_WRITE_LABEL)));
    await user.click(button("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(bodies).toStrictEqual([
      {
        unattendedConnectorRefs: [],
        unattendedPermissionPolicy: {
          gmail: { policies: { "drafts.write": "deny" } },
        },
      },
    ]);
  });

  it("clears a Gmail override when restored to the metadata default", async () => {
    const bodies = mockTriggerPolicyApis({
      gmail: { policies: { "drafts.write": "deny" } },
    });

    detachedSetupPage({ context, path: editorPath("gmail") });

    await waitFor(() => {
      expect(screen.getByText(GMAIL_DRAFTS_WRITE_LABEL)).toBeInTheDocument();
    });

    await user.click(button("Allow", permissionRow(GMAIL_DRAFTS_WRITE_LABEL)));
    await user.click(button("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(bodies).toStrictEqual([
      { unattendedConnectorRefs: [], unattendedPermissionPolicy: null },
    ]);
  });
});
