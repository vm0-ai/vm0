import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "../../../lib/db";
import {
  slackUserMentionedAutomationSchemaAvailable,
  slackWorkflowAutomationDeliverySchemaAvailable,
} from "../slack-workflow-automation-schema.service";
import { prepareSlackUserMentionedEventConfigForPersist } from "../slack-workflow-automation.service";

describe("Slack workflow automation rollout compatibility", () => {
  it("detects delivery-table availability across the deployment window", async () => {
    const rollback = new Error("rollback Slack delivery rollout fixture");
    await expect(
      db().transaction(async (tx) => {
        await expect(
          slackWorkflowAutomationDeliverySchemaAvailable(tx),
        ).resolves.toBeTruthy();

        await tx.execute(sql`SET LOCAL search_path TO pg_temp`);
        await expect(
          slackWorkflowAutomationDeliverySchemaAvailable(tx),
        ).resolves.toBeFalsy();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("blocks preparation until the automation constraint supports Slack", async () => {
    const rollback = new Error("rollback Slack automation rollout fixture");

    await expect(
      db().transaction(async (tx) => {
        // The historical constraint cannot be constructed through a production
        // API. This service-level fixture is intentionally narrow so the
        // deploy-before-migrate boundary is exercised against both real shapes.
        await tx.execute(sql`
          CREATE TEMP TABLE zero_workflow_automations
          (LIKE public.zero_workflow_automations
            INCLUDING DEFAULTS
            INCLUDING CONSTRAINTS)
          ON COMMIT DROP
        `);
        await tx.execute(sql`SET LOCAL search_path TO pg_temp, public`);

        const orgId = `org_slack_rollout_${randomUUID()}`;
        const userId = `user_slack_rollout_${randomUUID()}`;
        await tx.insert(userFeatureSwitches).values({
          orgId,
          userId,
          switches: { [FeatureSwitchKey.SlackUserMentionAutomations]: true },
        });
        const signal = new AbortController().signal;
        const preparationArgs = {
          orgId,
          userId,
          isAdmin: false,
          eventConfig: {
            provider: "slack",
            event: "user_mentioned",
            channel: "general",
          },
          signal,
        } as const;

        await expect(
          slackUserMentionedAutomationSchemaAvailable(tx),
        ).resolves.toBeTruthy();
        await expect(
          prepareSlackUserMentionedEventConfigForPersist(tx, preparationArgs),
        ).resolves.toStrictEqual({
          kind: "bad-request",
          message:
            "Ask a workspace admin to install the Zero Slack App before using a Slack user-mentioned automation.",
        });

        await tx.execute(sql`
          ALTER TABLE pg_temp.zero_workflow_automations
          DROP CONSTRAINT zero_workflow_automations_schedule_config_check
        `);
        await tx.execute(sql`
          ALTER TABLE pg_temp.zero_workflow_automations
          ADD CONSTRAINT zero_workflow_automations_schedule_config_check
          CHECK (
            (
              kind = 'schedule'
              AND event_type IS NULL
              AND event_config IS NULL
              AND (
                (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
                OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
                OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
              )
            )
            OR (
              kind = 'event'
              AND event_type IN ('chat-run-finished', 'gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'strapi-entry-published', 'webhook-received')
              AND event_config IS NOT NULL
              AND schedule_type IS NULL
              AND cron_expression IS NULL
              AND interval_seconds IS NULL
              AND at_time IS NULL
            )
          )
        `);

        await expect(
          slackUserMentionedAutomationSchemaAvailable(tx),
        ).resolves.toBeFalsy();
        await expect(
          prepareSlackUserMentionedEventConfigForPersist(tx, preparationArgs),
        ).resolves.toStrictEqual({
          kind: "bad-request",
          message:
            "Slack user-mentioned automations are temporarily unavailable while the database upgrade completes. Try again shortly.",
        });

        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
