import type { Column, DriverValueDecoder } from "drizzle-orm";
import type { output, ZodEnum, ZodType } from "zod";

import { pgInt8ToBigIntSchema, pgInt8ToSafeIntegerSchema } from "./db-raw-rows";

function invalidDriverValue(expected: string): never {
  throw new TypeError(`Expected ${expected} from PostgreSQL`);
}

export function zodDriverValueDecoder<TSchema extends ZodType>(
  schema: TSchema,
): DriverValueDecoder<output<TSchema>, unknown> {
  return Object.freeze({
    mapFromDriverValue(value: unknown): output<TSchema> {
      return schema.parse(value);
    },
  });
}

export function zodEnumDriverValueDecoder<
  TValues extends Readonly<Record<string, string | number>>,
>(
  schema: ZodEnum<TValues>,
): DriverValueDecoder<TValues[keyof TValues], unknown> {
  const values = new Map<string | number, TValues[keyof TValues]>();
  for (const option of schema.options) {
    values.set(option, option);
  }
  return Object.freeze({
    mapFromDriverValue(value: unknown): TValues[keyof TValues] {
      if (typeof value !== "string" && typeof value !== "number") {
        return invalidDriverValue("an enum value");
      }
      return values.get(value) ?? invalidDriverValue("an enum value");
    },
  });
}

export const pgTextDecoder: DriverValueDecoder<string, unknown> = Object.freeze(
  {
    mapFromDriverValue(value: unknown): string {
      return typeof value === "string"
        ? value
        : invalidDriverValue("a text value");
    },
  },
);

export const pgBooleanDecoder: DriverValueDecoder<boolean, unknown> =
  Object.freeze({
    mapFromDriverValue(value: unknown): boolean {
      return typeof value === "boolean"
        ? value
        : invalidDriverValue("a boolean value");
    },
  });

export const pgIntegerDecoder: DriverValueDecoder<number, unknown> =
  Object.freeze({
    mapFromDriverValue(value: unknown): number {
      return typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : invalidDriverValue("an integer value");
    },
  });

export const pgNullDecoder: DriverValueDecoder<null, unknown> = Object.freeze({
  mapFromDriverValue(): null {
    return invalidDriverValue("null");
  },
});

export const pgInt8ToSafeIntegerDecoder = zodDriverValueDecoder(
  pgInt8ToSafeIntegerSchema,
);

export const pgInt8ToBigIntDecoder =
  zodDriverValueDecoder(pgInt8ToBigIntSchema);

export function nullableDriverValueDecoder<TColumn extends Column>(
  decoder: TColumn,
): DriverValueDecoder<TColumn["_"]["data"] | null, unknown>;
export function nullableDriverValueDecoder<TData, TDriverParam>(
  decoder: DriverValueDecoder<TData, TDriverParam>,
): DriverValueDecoder<TData | null, TDriverParam>;
export function nullableDriverValueDecoder(
  decoder: DriverValueDecoder<unknown, unknown>,
): DriverValueDecoder<unknown, unknown> {
  return decoder;
}
