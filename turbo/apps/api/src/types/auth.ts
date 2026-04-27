import { ZeroCapability } from "@vm0/api-contracts";

export type ApiOrgRole = "admin" | "member";

type SessionAuthContext =
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
    };

type PatAuthContext =
  | {
      readonly tokenType: "pat";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | {
      readonly tokenType: "pat";
      readonly userId: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
    };

interface SandboxAuthContext {
  readonly tokenType: "sandbox";
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}

export interface ZeroAuthContext {
  readonly tokenType: "zero";
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: ApiOrgRole;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}

export type AuthContext =
  | SessionAuthContext
  | PatAuthContext
  | SandboxAuthContext
  | ZeroAuthContext;

export type AuthTokenType = AuthContext["tokenType"];

export interface CliTokenRecord {
  readonly userId: string;
  readonly orgId: string;
}

export interface SandboxAuth {
  readonly userId: string;
  readonly runId: string;
  readonly orgId: string;
}

export interface ZeroAuth {
  readonly userId: string;
  readonly runId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}

export interface CliAuth {
  readonly userId: string;
  readonly orgId: string;
  readonly tokenId: string;
}

export interface ComposeJobAuth {
  readonly userId: string;
  readonly jobId: string;
}
