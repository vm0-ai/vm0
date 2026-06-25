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
const PERMISSION_LABEL = "Access workspace analytics data";

function trigger(
  unattendedPermissionPolicy: ZeroWorkflowTriggerSummary["unattendedPermissionPolicy"],
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
): SetUnattendedTriggerPermissionPolicyRequest[] {
  const bodies: SetUnattendedTriggerPermissionPolicyRequest[] = [];
  let currentPolicy = initialPolicy;

  context.mocks.api(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    if (params.workflowId !== WORKFLOW_ID) {
      return respond(404, { error: { code: "NOT_FOUND", message: "missing" } });
    }
    return respond(200, workflow(trigger(currentPolicy)));
  });

  context.mocks.api(
    zeroWorkflowTriggersContract.setPermissionPolicy,
    ({ body, respond }) => {
      bodies.push(body);
      currentPolicy = body.unattendedPermissionPolicy ?? null;
      return respond(200, trigger(currentPolicy));
    },
  );

  return bodies;
}

function permissionRow(): HTMLElement {
  const label = screen.getByText(PERMISSION_LABEL);
  const row = label.parentElement;
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

const editorPath = `/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/permissions?ref=slack`;

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

    detachedSetupPage({ context, path: editorPath });

    await waitFor(() => {
      expect(screen.getByText(PERMISSION_LABEL)).toBeInTheDocument();
    });

    // Save is disabled until something changes.
    expect(button("Save")).toBeDisabled();

    await user.click(button("Allow", permissionRow()));
    await user.click(button("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(bodies).toStrictEqual([
      {
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

    detachedSetupPage({ context, path: editorPath });

    await waitFor(() => {
      expect(screen.getByText(PERMISSION_LABEL)).toBeInTheDocument();
    });

    await user.click(button("Deny", permissionRow()));
    await user.click(button("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(bodies).toStrictEqual([{ unattendedPermissionPolicy: null }]);
  });
});
