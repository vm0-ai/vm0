import { safeUriComponentDecode } from "../utils";

type LogOrder = "asc" | "desc";

interface DecodedTimeCursor {
  readonly order: LogOrder;
  readonly timestamp: string;
  readonly tieBreaker: string;
}

interface TimedAxiomRecord {
  readonly _time: string;
  readonly _vm0Cursor?: unknown;
}

interface TimePaginationParams {
  readonly since?: number;
  readonly sinceTime?: number;
  readonly cursor?: string;
  readonly order: LogOrder;
}

const ISO_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const MAX_TIME_CURSOR_TIE_BREAKER_LENGTH = 2048;
const TIME_CURSOR_APL_FIELD = "_vm0Cursor";

function safeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function isoTimestamp(value: number | undefined): string | null {
  const safeValue = safeInteger(value);
  if (safeValue === undefined) {
    return null;
  }

  const date = new Date(safeValue);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function timeFilter(value: number | undefined): string | null {
  const timestamp = isoTimestamp(value);
  if (timestamp === null) {
    return null;
  }

  return `| where _time > datetime("${timestamp}")`;
}

function exactUtcTimestamp(value: string): string | null {
  const match = ISO_UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart] =
    match;
  if (
    yearPart === undefined ||
    monthPart === undefined ||
    dayPart === undefined ||
    hourPart === undefined ||
    minutePart === undefined ||
    secondPart === undefined
  ) {
    return null;
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
    ? value
    : null;
}

function decodeCursorComponent(rawValue: string): string | null {
  return safeUriComponentDecode(rawValue) ?? null;
}

function timeCursorTimestampValue(rawValue: string): string | null {
  const decoded = decodeCursorComponent(rawValue);
  if (decoded === null) {
    return null;
  }
  return exactUtcTimestamp(decoded);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function exactTimeCursorTieBreaker(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_TIME_CURSOR_TIE_BREAKER_LENGTH ||
    hasControlCharacter(value)
  ) {
    return null;
  }

  return value;
}

function timeCursorTieBreakerValue(rawValue: string): string | null {
  const decoded = decodeCursorComponent(rawValue);
  return decoded === null ? null : exactTimeCursorTieBreaker(decoded);
}

function encodeTimeCursor(
  order: LogOrder,
  timestamp: string,
  tieBreaker: string,
): string | null {
  const exactTimestamp = exactUtcTimestamp(timestamp);
  const exactTieBreaker = exactTimeCursorTieBreaker(tieBreaker);
  if (exactTimestamp === null || exactTieBreaker === null) {
    return null;
  }

  return `time:${order}:${encodeURIComponent(
    exactTimestamp,
  )}:${encodeURIComponent(exactTieBreaker)}`;
}

function timeCursorInvariantFailure(reason: string): never {
  throw new Error(`Time pagination cursor invariant failed: ${reason}`);
}

function decodeTimeCursor(
  cursor: string | undefined,
  expectedOrder: LogOrder,
): DecodedTimeCursor | null {
  if (!cursor) {
    return null;
  }

  const match = /^time:(asc|desc):([^:]+):(.+)$/.exec(cursor);
  if (!match) {
    return null;
  }

  const order = match[1];
  const rawTimestamp = match[2];
  const rawTieBreaker = match[3];
  if (order !== expectedOrder || (order !== "asc" && order !== "desc")) {
    return null;
  }

  const timestamp = rawTimestamp
    ? timeCursorTimestampValue(rawTimestamp)
    : null;
  const tieBreaker = rawTieBreaker
    ? timeCursorTieBreakerValue(rawTieBreaker)
    : null;
  if (timestamp === null || tieBreaker === null) {
    return null;
  }

  return { order, timestamp, tieBreaker };
}

export function timeCursorBoundary(
  cursor: string | undefined,
  order: LogOrder,
): DecodedTimeCursor | undefined {
  return decodeTimeCursor(cursor, order) ?? undefined;
}

export function buildTimePaginationFilters(
  params: TimePaginationParams,
): string {
  const filters: string[] = [];
  const sinceTimeFilter = timeFilter(params.sinceTime ?? params.since);
  if (sinceTimeFilter !== null) {
    filters.push(sinceTimeFilter);
  }

  return filters.join("\n");
}

export function buildTimeCursorProjection(): string {
  return `| extend ${TIME_CURSOR_APL_FIELD} = cursor_current()`;
}

export function buildTimePaginationOrder(order: LogOrder): string {
  return `| order by _time ${order}`;
}

export function nextTimeCursor<T extends TimedAxiomRecord>(
  records: readonly T[],
  hasMore: boolean,
  order: LogOrder,
  previousCursorBoundary: DecodedTimeCursor | undefined,
): string | null {
  if (!hasMore) {
    return null;
  }

  if (records.length === 0) {
    timeCursorInvariantFailure("page has more rows but no visible records");
  }

  const lastRecord = records[records.length - 1];
  if (!lastRecord) {
    timeCursorInvariantFailure("page has more rows but no boundary record");
  }

  const timestamp = exactUtcTimestamp(lastRecord._time);
  const tieBreaker =
    typeof lastRecord._vm0Cursor === "string" ? lastRecord._vm0Cursor : null;
  if (timestamp === null) {
    timeCursorInvariantFailure("boundary record has invalid _time");
  }
  if (tieBreaker === null) {
    timeCursorInvariantFailure("boundary record has no Axiom cursor");
  }

  if (
    timestamp === previousCursorBoundary?.timestamp &&
    tieBreaker === previousCursorBoundary.tieBreaker
  ) {
    timeCursorInvariantFailure("boundary cursor did not advance");
  }

  const nextCursor = encodeTimeCursor(order, timestamp, tieBreaker);
  if (nextCursor === null) {
    timeCursorInvariantFailure("boundary cursor could not be encoded");
  }

  return nextCursor;
}

export function filterTimedAxiomRecords<T extends Record<string, unknown>>(
  records: readonly T[],
): (T & { readonly _time: string })[] {
  return records.filter((record): record is T & { readonly _time: string } => {
    return typeof record._time === "string";
  });
}
