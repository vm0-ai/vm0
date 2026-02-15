/**
 * Platform router - routes connector types to appropriate platform implementation.
 *
 * This module determines which platform (self-hosted or Nango) handles each
 * connector type, and provides singleton instances of platform adapters.
 */

import type { ConnectorPlatform, PlatformType } from "./interface";
import { SelfHostedPlatform } from "./self-hosted";
import { NangoPlatform } from "./nango";

/**
 * Routing configuration: maps connector types to platforms.
 *
 * Self-hosted providers use existing OAuth implementations.
 * All other providers default to Nango Cloud.
 */
const PLATFORM_ROUTING: Record<string, PlatformType> = {
  // Existing self-hosted providers
  github: "self-hosted",
  notion: "self-hosted",
  computer: "self-hosted",

  // New Nango providers
  gmail: "nango",
};

/**
 * Singleton instances of platform adapters
 */
let selfHostedPlatform: SelfHostedPlatform | null = null;
let nangoPlatform: NangoPlatform | null = null;

/**
 * Get the platform type for a connector.
 * Defaults to "nango" for unknown connector types.
 */
export function getPlatformType(type: string): PlatformType {
  return PLATFORM_ROUTING[type] ?? "nango";
}

/**
 * Get the platform adapter for a connector type.
 * Returns singleton instance of the appropriate platform.
 *
 * @throws Error if Nango is not enabled when trying to use a Nango provider
 */
export function getPlatform(type: string): ConnectorPlatform {
  const platformType = getPlatformType(type);
  const env = globalThis.services.env;

  switch (platformType) {
    case "self-hosted": {
      if (!selfHostedPlatform) {
        selfHostedPlatform = new SelfHostedPlatform();
      }
      return selfHostedPlatform;
    }

    case "nango": {
      // Check if Nango is enabled
      if (!env.FEATURE_NANGO_ENABLED) {
        throw new Error(
          `Nango integration is not enabled. Cannot use connector type: ${type}`,
        );
      }

      if (!nangoPlatform) {
        nangoPlatform = new NangoPlatform();
      }
      return nangoPlatform;
    }

    default: {
      const exhaustiveCheck: never = platformType;
      throw new Error(`Unknown platform type: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Build connection ID for Nango providers.
 * Format: "{scopeId}:{connectorType}"
 *
 * This creates a unique identifier for each user-provider combination
 * that can be used to retrieve the connection from Nango.
 */
export function buildConnectionId(scopeId: string, type: string): string {
  return `${scopeId}:${type}`;
}
