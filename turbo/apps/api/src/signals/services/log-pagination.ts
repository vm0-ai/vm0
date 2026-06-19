import { MAX_EVENT_SEQUENCE_NUMBER } from "@vm0/api-contracts/contracts/runs";

type LogOrder = "asc" | "desc";

interface DecodedSequenceCursor {
  readonly order: LogOrder;
  readonly value: number;
}

interface DecodedTimeCursor {
  readonly order: LogOrder;
  readonly timestamp: string;
}

interface TimedAxiomRecord {
  readonly _time: string;
}

interface TimePaginationParams {
  readonly since?: number;
  readonly sinceTime?: number;
  readonly cursor?: string;
  readonly order: LogOrder;
}

const ISO_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function safeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function sequenceNumberCursor(value: number | undefined): number | undefined {
  const safeValue = safeInteger(value);
  if (safeValue === undefined) {
    return undefined;
  }

  return safeValue >= -1 && safeValue <= MAX_EVENT_SEQUENCE_NUMBER
    ? safeValue
    : undefined;
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

function timeCursorTimestampValue(rawValue: string): string | null {
  if (/^-?\d+$/.test(rawValue)) {
    return isoTimestamp(Number(rawValue));
  }

  const decoded = rawValue.replaceAll(/%3A/gi, ":").replaceAll(/%2E/gi, ".");
  return exactUtcTimestamp(decoded);
}

function encodeSequenceCursor(order: LogOrder, value: number): string | null {
  if (sequenceNumberCursor(value) === undefined) {
    return null;
  }

  return `sequence:${order}:${value}`;
}

function encodeTimeCursor(order: LogOrder, timestamp: string): string | null {
  const exactTimestamp = exactUtcTimestamp(timestamp);
  if (exactTimestamp === null) {
    return null;
  }

  return `time:${order}:${encodeURIComponent(exactTimestamp)}`;
}

function decodeSequenceCursor(
  cursor: string | undefined,
  expectedOrder: LogOrder,
): DecodedSequenceCursor | null {
  if (!cursor) {
    return null;
  }

  const match = /^sequence:(asc|desc):(-?\d+)$/.exec(cursor);
  if (!match) {
    return null;
  }

  const order = match[1];
  const rawValue = match[2];
  if (
    order !== expectedOrder ||
    (order !== "asc" && order !== "desc") ||
    rawValue === undefined
  ) {
    return null;
  }

  const value = Number(rawValue);
  if (sequenceNumberCursor(value) === undefined) {
    return null;
  }

  return { order, value };
}

function decodeTimeCursor(
  cursor: string | undefined,
  expectedOrder: LogOrder,
): DecodedTimeCursor | null {
  if (!cursor) {
    return null;
  }

  const match = /^time:(asc|desc):(.+)$/.exec(cursor);
  if (!match) {
    return null;
  }

  const order = match[1];
  const rawValue = match[2];
  if (order !== expectedOrder || (order !== "asc" && order !== "desc")) {
    return null;
  }

  const timestamp = rawValue ? timeCursorTimestampValue(rawValue) : null;
  if (timestamp === null) {
    return null;
  }

  return { order, timestamp };
}

export function sequenceCursorValue(
  cursor: string | undefined,
  order: LogOrder,
): number | undefined {
  return decodeSequenceCursor(cursor, order)?.value;
}

export function timeCursorTimestamp(
  cursor: string | undefined,
  order: LogOrder,
): string | undefined {
  return decodeTimeCursor(cursor, order)?.timestamp;
}

function buildSequencePaginationFilter(
  params: Pick<TimePaginationParams, "since" | "cursor" | "order">,
): string {
  const cursorValue = sequenceCursorValue(params.cursor, params.order);
  if (cursorValue !== undefined) {
    const operator = params.order === "asc" ? ">" : "<";
    return `| where sequenceNumber ${operator} ${cursorValue}`;
  }

  const since = sequenceNumberCursor(params.since);
  return since !== undefined ? `| where sequenceNumber > ${since}` : "";
}

export function buildAgentEventPaginationFilters(
  params: TimePaginationParams,
): string {
  return [timeFilter(params.sinceTime), buildSequencePaginationFilter(params)]
    .filter((filter): filter is string => {
      return filter !== null && filter.length > 0;
    })
    .join("\n");
}

export function buildTimePaginationFilters(
  params: TimePaginationParams,
): string {
  const filters: string[] = [];
  const sinceTimeFilter = timeFilter(params.sinceTime ?? params.since);
  if (sinceTimeFilter !== null) {
    filters.push(sinceTimeFilter);
  }

  const cursorTimestamp = timeCursorTimestamp(params.cursor, params.order);
  if (cursorTimestamp !== undefined) {
    const operator = params.order === "asc" ? ">" : "<";
    filters.push(`| where _time ${operator} datetime("${cursorTimestamp}")`);
  }

  return filters.join("\n");
}

export function nextSequenceCursor(
  events: readonly { readonly sequenceNumber: number }[],
  hasMore: boolean,
  order: LogOrder,
  previousCursorValue: number | undefined,
): string | null {
  if (!hasMore || events.length === 0) {
    return null;
  }

  const lastEvent = events[events.length - 1];
  if (!lastEvent || lastEvent.sequenceNumber === previousCursorValue) {
    return null;
  }

  return encodeSequenceCursor(order, lastEvent.sequenceNumber);
}

export function nextTimeCursor<T extends TimedAxiomRecord>(
  records: readonly T[],
  hasMore: boolean,
  order: LogOrder,
  previousCursorTimestamp: string | undefined,
): string | null {
  if (!hasMore || records.length === 0) {
    return null;
  }

  const lastRecord = records[records.length - 1];
  if (!lastRecord) {
    return null;
  }

  const timestamp = exactUtcTimestamp(lastRecord._time);
  if (timestamp === null || timestamp === previousCursorTimestamp) {
    return null;
  }

  return encodeTimeCursor(order, timestamp);
}
