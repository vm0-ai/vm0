import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import {
  strapiIntegrations,
  strapiWebhookDeliveries,
  strapiWorkflowAutomations,
  strapiWorkflowPendingEvents,
} from "../schema/strapi-integration";
import {
  workflows,
  workflowAutomations,
  workflowGithubProcessedEvents,
  workflowUserAutomationThreads,
  workflowWebhookAutomations,
  workflowWebhookDeliveries,
} from "../schema/workflow";

function explicitNames(table: Parameters<typeof getTableConfig>[0]): {
  readonly indexes: string[];
  readonly checks: string[];
} {
  const config = getTableConfig(table);
  return {
    indexes: config.indexes
      .flatMap((index) => {
        return index.config.name ? [index.config.name] : [];
      })
      .sort(),
    checks: config.checks
      .flatMap((check) => {
        return check.name ? [check.name] : [];
      })
      .sort(),
  };
}

describe("workflow schema physical identity", () => {
  it("keeps the six workflow table mappings", () => {
    expect({
      workflows: getTableConfig(workflows).name,
      workflowAutomations: getTableConfig(workflowAutomations).name,
      workflowWebhookAutomations: getTableConfig(workflowWebhookAutomations)
        .name,
      workflowWebhookDeliveries: getTableConfig(workflowWebhookDeliveries).name,
      workflowGithubProcessedEvents: getTableConfig(
        workflowGithubProcessedEvents,
      ).name,
      strapiWorkflowAutomations: getTableConfig(strapiWorkflowAutomations).name,
    }).toEqual({
      workflows: "zero_workflows",
      workflowAutomations: "zero_workflow_automations",
      workflowWebhookAutomations: "zero_workflow_webhook_automations",
      workflowWebhookDeliveries: "zero_workflow_webhook_deliveries",
      workflowGithubProcessedEvents: "zero_workflow_github_processed_events",
      strapiWorkflowAutomations: "zero_workflow_strapi_automations",
    });
  });

  it("exports the canonical tables through the root schema", () => {
    expect(schema.workflows).toBe(workflows);
    expect(schema.workflowAutomations).toBe(workflowAutomations);
    expect(schema.workflowWebhookAutomations).toBe(workflowWebhookAutomations);
    expect(schema.workflowWebhookDeliveries).toBe(workflowWebhookDeliveries);
    expect(schema.workflowGithubProcessedEvents).toBe(
      workflowGithubProcessedEvents,
    );
    expect(schema.strapiWorkflowAutomations).toBe(strapiWorkflowAutomations);
  });

  it("keeps the Official result-email projection on the legacy Automation relation", () => {
    expect(getTableConfig(workflowAutomations).columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "official_result_email_enabled",
        }),
      ]),
    );
  });

  it("keeps every explicit index and check name in the touched schemas", () => {
    expect({
      workflows: explicitNames(workflows),
      workflowUserAutomationThreads: explicitNames(
        workflowUserAutomationThreads,
      ),
      workflowAutomations: explicitNames(workflowAutomations),
      workflowWebhookAutomations: explicitNames(workflowWebhookAutomations),
      workflowWebhookDeliveries: explicitNames(workflowWebhookDeliveries),
      workflowGithubProcessedEvents: explicitNames(
        workflowGithubProcessedEvents,
      ),
      strapiIntegrations: explicitNames(strapiIntegrations),
      strapiWorkflowAutomations: explicitNames(strapiWorkflowAutomations),
      strapiWebhookDeliveries: explicitNames(strapiWebhookDeliveries),
      strapiWorkflowPendingEvents: explicitNames(strapiWorkflowPendingEvents),
    }).toEqual({
      workflows: {
        indexes: [
          "idx_zero_workflows_agent",
          "idx_zero_workflows_org",
          "idx_zero_workflows_org_owner",
          "idx_zero_workflows_private_owner_agent_name_unique",
          "idx_zero_workflows_public_agent_name_unique",
        ],
        checks: ["zero_workflows_official_installation_check"],
      },
      workflowUserAutomationThreads: {
        indexes: [
          "idx_workflow_user_automation_threads_chat_thread",
          "idx_workflow_user_automation_threads_unique",
          "idx_workflow_user_automation_threads_workflow_user",
        ],
        checks: [],
      },
      workflowAutomations: {
        indexes: [
          "idx_zero_workflow_automations_next_run",
          "idx_zero_workflow_automations_official_blueprint_unique",
          "idx_zero_workflow_automations_org",
          "idx_zero_workflow_automations_workflow",
        ],
        checks: [
          "zero_workflow_automations_autonomy_budget_check",
          "zero_workflow_automations_official_binding_check",
          "zero_workflow_automations_schedule_config_check",
        ],
      },
      workflowWebhookAutomations: {
        indexes: ["idx_zero_workflow_webhook_automations_token_hash"],
        checks: [],
      },
      workflowWebhookDeliveries: {
        indexes: [
          "idx_zero_workflow_webhook_deliveries_automation_key",
          "idx_zero_workflow_webhook_deliveries_automation_received",
        ],
        checks: [],
      },
      workflowGithubProcessedEvents: {
        indexes: [
          "idx_zero_workflow_github_processed_automation_delivery",
          "idx_zero_workflow_github_processed_subject",
        ],
        checks: [],
      },
      strapiIntegrations: {
        indexes: [
          "idx_strapi_integrations_org",
          "idx_strapi_integrations_org_base_url",
          "idx_strapi_integrations_token_hash",
        ],
        checks: [],
      },
      strapiWorkflowAutomations: {
        indexes: ["idx_zero_workflow_strapi_automations_integration"],
        checks: [],
      },
      strapiWebhookDeliveries: {
        indexes: [
          "idx_strapi_webhook_deliveries_integration_body",
          "idx_strapi_webhook_deliveries_received",
        ],
        checks: [],
      },
      strapiWorkflowPendingEvents: {
        indexes: [
          "idx_strapi_pending_events_automation_document_active",
          "idx_strapi_pending_events_due",
          "idx_strapi_pending_events_integration",
        ],
        checks: [],
      },
    });
  });
});
