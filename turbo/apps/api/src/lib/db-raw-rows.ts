import type { SQLWrapper } from "drizzle-orm";
import { z, type output, type ZodType } from "zod";

type ApiDb = ReturnType<(typeof import("./db"))["db"]>;

type RawSqlExecutor = Pick<ApiDb, "execute">;

export const pgInt8ToSafeIntegerSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(z.int());

export const pgInt8ToBigIntSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => {
    return BigInt(value);
  });

export const pgTimestampWithoutTimezoneToDateSchema = z
  .string()
  .transform((value) => {
    return new Date(`${value}+0000`);
  })
  .pipe(z.date());

export async function executeRawRows<TSchema extends ZodType>(
  executor: RawSqlExecutor,
  query: SQLWrapper,
  rowSchema: TSchema,
): Promise<output<TSchema>[]> {
  const result = await executor.execute(query);
  return result.rows.map((row) => {
    return rowSchema.parse(row);
  });
}
