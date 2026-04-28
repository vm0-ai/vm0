import type { TelegramMessageEntity } from "@vm0/db/schema/telegram-message";

interface TelegramEntityMessageLike {
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
}

const STYLE_ENTITY_TYPES = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "code",
  "pre",
  "blockquote",
  "expandable_blockquote",
]);

function isValidEntity(entity: TelegramMessageEntity): boolean {
  return (
    typeof entity.type === "string" &&
    Number.isInteger(entity.offset) &&
    Number.isInteger(entity.length) &&
    entity.offset >= 0 &&
    entity.length > 0
  );
}

function extractTelegramMessageText(
  message: TelegramEntityMessageLike,
): string {
  return message.text ?? message.caption ?? "";
}

export function extractTelegramMessageEntities(
  message: TelegramEntityMessageLike,
): TelegramMessageEntity[] | undefined {
  const entities = message.text ? message.entities : message.caption_entities;
  const normalized = entities?.filter(isValidEntity);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function entityText(text: string, entity: TelegramMessageEntity): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function formatEntityUser(user: TelegramMessageEntity["user"]): string {
  if (!user) return "unknown user";

  const parts = [`id: ${user.id}`];
  if (user.username) parts.push(`username: @${user.username}`);
  const displayName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ");
  if (displayName) parts.push(`name: ${displayName}`);
  if (user.is_bot) parts.push("bot: true");

  return `{${parts.join(", ")}}`;
}

function formatEntity(
  text: string,
  entity: TelegramMessageEntity,
): string | undefined {
  const value = entityText(text, entity);
  if (!value) return undefined;

  switch (entity.type) {
    case "mention":
      return `mention ${value}`;
    case "text_mention":
      return `text_mention ${quoted(value)} -> ${formatEntityUser(entity.user)}`;
    case "bot_command":
      return `bot_command ${value}`;
    case "url":
      return `url ${value}`;
    case "text_link":
      return `text_link ${quoted(value)} -> ${entity.url ?? "unknown URL"}`;
    case "email":
      return `email ${value}`;
    case "phone_number":
      return `phone ${value}`;
    case "hashtag":
      return `hashtag ${value}`;
    case "cashtag":
      return `cashtag ${value}`;
    case "custom_emoji":
      return `custom_emoji ${quoted(value)}${entity.custom_emoji_id ? ` (${entity.custom_emoji_id})` : ""}`;
    case "pre":
      return `pre ${quoted(value)}${entity.language ? ` (${entity.language})` : ""}`;
    default:
      if (STYLE_ENTITY_TYPES.has(entity.type)) {
        return `${entity.type} ${quoted(value)}`;
      }
      return `${entity.type} ${quoted(value)}`;
  }
}

export function formatTelegramEntitiesForContext(
  text: string,
  entities: TelegramMessageEntity[] | null | undefined,
): string | undefined {
  if (!entities || entities.length === 0) return undefined;

  const formatted = entities
    .map((entity) => {
      return formatEntity(text, entity);
    })
    .filter((value): value is string => {
      return Boolean(value);
    });

  return formatted.length > 0 ? formatted.join("; ") : undefined;
}

export function formatCurrentTelegramEntitiesForPrompt(
  message: TelegramEntityMessageLike,
): string | undefined {
  const text = extractTelegramMessageText(message);
  const entities = extractTelegramMessageEntities(message);
  const summary = formatTelegramEntitiesForContext(text, entities);
  return summary ? `[Telegram entities]\n${summary}` : undefined;
}
