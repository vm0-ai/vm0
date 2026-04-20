import { eq } from "drizzle-orm";
import { cliTokens } from "../../db/schema/cli-tokens";
import { deviceCodes } from "../../db/schema/device-codes";

/**
 * Find a device code by its code string.
 * Returns the device code row or undefined.
 */
export async function findTestDeviceCode(code: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.code, code))
    .limit(1);
  return row;
}

/**
 * Find a CLI token by its token string.
 * Returns the CLI token row or undefined.
 */
export async function findTestCliToken(token: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(eq(cliTokens.token, token))
    .limit(1);
  return row;
}
