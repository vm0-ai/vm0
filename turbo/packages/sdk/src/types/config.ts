/**
 * SDK configuration types
 */

export interface SDKConfig {
  apiUrl: string;
  apiKey: string;
  pollInterval?: number; // milliseconds, default: 1000
  timeout?: number; // milliseconds, default: 60000
}
