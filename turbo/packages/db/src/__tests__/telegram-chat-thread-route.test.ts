import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { chatThreads } from "../schema/chat-thread";
import { telegramChatThreadRoutes } from "../schema/telegram-chat-thread-route";
import { telegramOfficialUserLinks } from "../schema/telegram-official-user-link";
import { telegramUserLinks } from "../schema/telegram-user-link";

describe("telegramChatThreadRoutes schema", () => {
  it("exports the shared personal and official route table", () => {
    expect(schema.telegramChatThreadRoutes).toBe(telegramChatThreadRoutes);
  });

  it("preserves the link, chat, and reply-chain route keys", () => {
    const config = getTableConfig(telegramChatThreadRoutes);
    const columns = new Map(
      config.columns.map((column) => {
        return [column.name, column] as const;
      }),
    );
    const indexColumns = (name: string): readonly (string | undefined)[] => {
      const index = config.indexes.find((candidate) => {
        return candidate.config.name === name;
      });
      return (
        index?.config.columns.map((column) => {
          return "name" in column ? column.name : undefined;
        }) ?? []
      );
    };

    expect(
      indexColumns("idx_telegram_chat_thread_routes_chat_user_link"),
    ).toStrictEqual(["telegram_user_link_id", "chat_id", "root_message_id"]);
    expect(
      indexColumns("idx_telegram_chat_thread_routes_chat_official_link"),
    ).toStrictEqual([
      "telegram_official_user_link_id",
      "chat_id",
      "root_message_id",
    ]);
    expect(columns.get("chat_id")?.notNull).toBeTruthy();
    expect(columns.get("root_message_id")?.notNull).toBeTruthy();
    expect(columns.get("chat_thread_id")?.notNull).toBeTruthy();
    expect(columns.has("last_processed_message_id")).toBeTruthy();
    expect(
      config.foreignKeys.map((foreignKey) => {
        return foreignKey.reference().foreignTable;
      }),
    ).toEqual(
      expect.arrayContaining([
        telegramUserLinks,
        telegramOfficialUserLinks,
        chatThreads,
      ]),
    );
    expect(
      config.checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_telegram_chat_thread_routes_one_owner");
  });
});
