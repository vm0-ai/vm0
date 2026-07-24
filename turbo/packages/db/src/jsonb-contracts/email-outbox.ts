import type { JsonStringRecord, JsonValue } from "./shared";

export type EmailOutboxAddresses = string | readonly string[];
export type EmailOutboxHeaders = JsonStringRecord;
export type EmailOutboxTemplate = JsonValue;
