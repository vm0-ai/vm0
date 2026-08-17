import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { agentphoneUserAgentPreferences } from "../schema/agentphone-user-agent-preference";
import { agentphoneUserLinks } from "../schema/agentphone-user-link";
import { feishuOrgConnections } from "../schema/feishu-org-connection";
import { feishuUserAgentPreferences } from "../schema/feishu-user-agent-preference";
import { githubUserLinks } from "../schema/github-user-link";
import { slackOrgConnections } from "../schema/slack-org-connection";
import { slackUserAgentPreferences } from "../schema/slack-user-agent-preference";
import { teamsOrgConnections } from "../schema/teams-org-connection";
import { teamsUserAgentPreferences } from "../schema/teams-user-agent-preference";
import { telegramOfficialUserLinks } from "../schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "../schema/telegram-user-agent-preference";
import { telegramUserLinks } from "../schema/telegram-user-link";

const runtimeTables = [
  ["agentphone_user_agent_preferences", agentphoneUserAgentPreferences],
  ["agentphone_user_links", agentphoneUserLinks],
  ["feishu_org_connections", feishuOrgConnections],
  ["feishu_user_agent_preferences", feishuUserAgentPreferences],
  ["github_user_links", githubUserLinks],
  ["slack_org_connections", slackOrgConnections],
  ["slack_user_agent_preferences", slackUserAgentPreferences],
  ["teams_org_connections", teamsOrgConnections],
  ["teams_user_agent_preferences", teamsUserAgentPreferences],
  ["telegram_official_user_links", telegramOfficialUserLinks],
  ["telegram_user_agent_preferences", telegramUserAgentPreferences],
  ["telegram_user_links", telegramUserLinks],
] as const;

describe("integration user identity runtime contract", () => {
  it("omits the legacy identity from all twelve runtime table configurations", () => {
    expect(runtimeTables).toHaveLength(12);

    for (const [tableName, table] of runtimeTables) {
      const config = getTableConfig(table);
      const columnNames = config.columns.map((column) => {
        return column.name;
      });

      expect(config.name).toBe(tableName);
      expect(columnNames).toContain("user_id");
      expect(columnNames).not.toContain("vm0_user_id");
    }
  });

  it("builds canonical-only statement shapes", () => {
    const db = drizzle.mock();
    const statements = {
      insert: db
        .insert(githubUserLinks)
        .values({
          githubUserId: "github-user-27796",
          installationId: "00000000-0000-4000-8000-000000027796",
          userId: "user-27796",
        })
        .toSQL().sql,
      upsert: db
        .insert(teamsUserAgentPreferences)
        .values({
          userId: "user-27796",
          orgId: "org-27796",
          selectedComposeId: null,
        })
        .onConflictDoUpdate({
          target: [
            teamsUserAgentPreferences.userId,
            teamsUserAgentPreferences.orgId,
          ],
          set: { selectedComposeId: null },
        })
        .toSQL().sql,
      update: db
        .update(telegramOfficialUserLinks)
        .set({ telegramUsername: "canonical-user" })
        .where(eq(telegramOfficialUserLinks.userId, "user-27796"))
        .toSQL().sql,
      select: db
        .select()
        .from(agentphoneUserLinks)
        .where(eq(agentphoneUserLinks.userId, "user-27796"))
        .toSQL().sql,
      returning: db
        .update(slackOrgConnections)
        .set({ dmWelcomeSent: true })
        .where(eq(slackOrgConnections.userId, "user-27796"))
        .returning()
        .toSQL().sql,
    };

    expect(statements.insert).toContain('insert into "github_user_links"');
    expect(statements.upsert).toContain("on conflict");
    expect(statements.update).toContain(
      'update "telegram_official_user_links"',
    );
    expect(statements.select).toContain('from "agentphone_user_links"');
    expect(statements.returning).toContain("returning");

    for (const statement of Object.values(statements)) {
      expect(statement).not.toContain("vm0_user_id");
    }
  });
});
