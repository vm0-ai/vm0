export { PENDING_TELEGRAM_USER_ID } from "../../lib/zero/telegram/handlers/shared";

// Re-exports: DB-direct seeders
export {
  createTestTelegramInstallation,
  insertTestTelegramMessages,
  createTelegramInstallationForCompose,
  insertTestTelegramInstallation,
  insertTestTelegramUserLink,
  createTelegramInstallation,
  insertTelegramMessage,
  createTelegramPendingLinkInstallation,
  createTelegramCallbackInstallation,
  createTelegramThreadSession,
  insertTestOfficialTelegramUserLink,
  seedTestTelegramUserAgentPreference,
  signTestConnectParams,
} from "../db-test-seeders/telegram";

// Re-exports: read-only assertions
export {
  countTestTelegramMessages,
  countTelegramUserLinkRows,
  findTestTelegramUserLinksByVm0UserId,
  findTestTelegramInstallationsByOwner,
  findTestOfficialTelegramUserLink,
  findTestOfficialTelegramUserLinksByVm0UserId,
  findTestTelegramUserAgentPreference,
  getTestTelegramBotToken,
  telegramUserLinkExists,
  telegramThreadSessionExists,
} from "../db-test-assertions/telegram";
