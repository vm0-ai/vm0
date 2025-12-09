/**
 * ts-rest API Contracts
 *
 * This module provides type-safe API contracts using ts-rest.
 *
 * IMPORTANT: We use @ts-rest/core@3.53.0-rc.1 (RC version) because:
 * - The stable version (3.52.x) requires Zod v3
 * - This project uses Zod v4 which has breaking type changes
 * - The RC version adds Zod v4 compatibility
 *
 * TODO: Upgrade to stable @ts-rest/core@3.53.0 when released.
 * Track: https://github.com/ts-rest/ts-rest/releases
 */
export { initContract } from "./base";
export { apiErrorSchema, type ApiErrorResponse } from "./errors";
export { secretsContract, type SecretsContract } from "./secrets";
