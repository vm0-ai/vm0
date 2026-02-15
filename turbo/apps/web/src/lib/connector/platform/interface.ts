/**
 * Platform abstraction interface for connector providers.
 *
 * This interface allows vm0 to support multiple OAuth provider platforms
 * (self-hosted and Nango Cloud) through a unified API.
 */

/**
 * Platform type identifier
 */
export type PlatformType = "self-hosted" | "nango";

/**
 * Parameters for building an OAuth authorization URL
 */
export interface AuthorizationParams {
  /** Connector type (e.g., "github", "gmail") */
  type: string;
  /** Unique connection ID for this user and provider */
  connectionId: string;
  /** OAuth redirect URI */
  redirectUri: string;
  /** CSRF protection state parameter */
  state: string;
  /** Optional OAuth scopes to request */
  scopes?: string[];
}

/**
 * Parameters for handling OAuth callback
 */
export interface CallbackParams {
  /** Connector type (e.g., "github", "gmail") */
  type: string;
  /** OAuth authorization code */
  code: string;
  /** CSRF protection state parameter */
  state: string;
  /** Unique connection ID for this user and provider */
  connectionId: string;
  /** OAuth redirect URI */
  redirectUri: string;
}

/**
 * Result from OAuth callback handling
 */
export interface ConnectorResult {
  /** External user ID from OAuth provider */
  externalId: string;
  /** External username (nullable) */
  externalUsername: string | null;
  /** External email (nullable) */
  externalEmail: string | null;
  /** Granted OAuth scopes (nullable) */
  oauthScopes: string[] | null;
  /** Access token (for self-hosted platforms) */
  accessToken?: string;
  /** Refresh token (for self-hosted platforms, optional) */
  refreshToken?: string | null;
}

/**
 * User information from OAuth provider
 */
export interface UserInfo {
  /** External user ID */
  externalId: string;
  /** External username (nullable) */
  externalUsername: string | null;
  /** External email (nullable) */
  externalEmail: string | null;
}

/**
 * Platform abstraction for OAuth connector providers.
 *
 * Implementations:
 * - SelfHostedPlatform: Wraps existing GitHub/Notion OAuth implementations
 * - NangoPlatform: Integrates with Nango Cloud for 100+ providers
 */
export interface ConnectorPlatform {
  /** Platform identifier */
  readonly name: PlatformType;

  /**
   * Build OAuth authorization URL for user to visit
   */
  buildAuthorizationUrl(params: AuthorizationParams): Promise<string>;

  /**
   * Handle OAuth callback and exchange code for token
   * Returns normalized connector result
   */
  handleCallback(params: CallbackParams): Promise<ConnectorResult>;

  /**
   * Get access token for a connector (optional)
   * Used by platforms that store tokens externally
   */
  getAccessToken?(connectorId: string): Promise<string>;

  /**
   * Refresh expired access token (optional)
   * Used for platforms that support token refresh
   */
  refreshToken?(connectorId: string): Promise<void>;

  /**
   * Get user information for a connector (optional)
   */
  getUserInfo?(connectorId: string): Promise<UserInfo>;

  /**
   * Delete connection from platform (optional)
   * Used when user deletes connector
   */
  deleteConnection?(connectorId: string): Promise<void>;
}
