import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { automations, automationTriggers } from "../schema/automation";

interface NamedExtraConfig {
  readonly name?: unknown;
  readonly config?: {
    readonly name?: unknown;
  };
}

function getExtraConfigNames(table: object): string[] {
  const symbols = Object.getOwnPropertySymbols(table);
  const builderSymbol = symbols.find((symbol) => {
    return symbol.description === "drizzle:ExtraConfigBuilder";
  });
  const columnsSymbol = symbols.find((symbol) => {
    return symbol.description === "drizzle:ExtraConfigColumns";
  });
  if (!builderSymbol || !columnsSymbol) {
    return [];
  }

  const builder = Reflect.get(table, builderSymbol);
  const columns = Reflect.get(table, columnsSymbol);
  if (typeof builder !== "function") {
    return [];
  }

  return builder(columns)
    .map((config: NamedExtraConfig) => {
      if (typeof config.name === "string") {
        return config.name;
      }
      if (typeof config.config?.name === "string") {
        return config.config.name;
      }
      return undefined;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

describe("automations schema", () => {
  it("exports both tables through the shared schema", () => {
    expect(schema.automations).toBe(automations);
    expect(schema.automationTriggers).toBe(automationTriggers);
  });

  it("keeps the expected automation column names stable", () => {
    expect(automations.orgId.name).toBe("org_id");
    expect(automations.userId.name).toBe("user_id");
    expect(automations.name.name).toBe("name");
    expect(automations.description.name).toBe("description");
    expect(automations.instruction.name).toBe("instruction");
    expect(automations.agentId.name).toBe("agent_id");
    expect(automations.chatThreadId.name).toBe("chat_thread_id");
    expect(automations.interpreterKind.name).toBe("interpreter_kind");
    expect(automations.enabled.name).toBe("enabled");
    expect(automations.createdAt.name).toBe("created_at");
    expect(automations.updatedAt.name).toBe("updated_at");
  });

  it("declares automation lookup and uniqueness indexes", () => {
    expect(getExtraConfigNames(automations)).toEqual(
      expect.arrayContaining([
        "idx_automations_agent",
        "idx_automations_org",
        "idx_automations_user_org",
        "idx_automations_chat_thread",
        "idx_automations_agent_name_org_user",
      ]),
    );
  });

  it("keeps the expected trigger column names stable", () => {
    expect(automationTriggers.automationId.name).toBe("automation_id");
    expect(automationTriggers.kind.name).toBe("kind");
    expect(automationTriggers.config.name).toBe("config");
    expect(automationTriggers.webhookToken.name).toBe("webhook_token");
    expect(automationTriggers.encryptedSecret.name).toBe("encrypted_secret");
    expect(automationTriggers.createdAt.name).toBe("created_at");
    expect(automationTriggers.updatedAt.name).toBe("updated_at");
  });

  it("declares the trigger automation index and unique webhook token index", () => {
    expect(getExtraConfigNames(automationTriggers)).toEqual(
      expect.arrayContaining([
        "idx_automation_triggers_automation",
        "idx_automation_triggers_webhook_token",
      ]),
    );
  });
});
