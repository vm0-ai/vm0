/**
 * Minimal Web API type declarations for environment-agnostic contracts.
 * These types exist in both browser and Node.js 18+ environments.
 */

declare global {
  /** Web standard FormData interface (minimal declaration for type references) */
  interface FormData {
    append(name: string, value: string | Blob): void;
  }

  /** Web standard Blob interface (minimal declaration for type references) */
  interface Blob {
    readonly size: number;
    readonly type: string;
  }
}

export {};
