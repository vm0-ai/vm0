import type { DesktopAuthState } from "./desktop-bridge";
import {
  headersWithSessionCookies,
  type DesktopSessionCookieSource,
} from "./desktop-session-cookies";

const AUTH_ME_PATH = "/api/auth/me";
const ZERO_ORG_PATH = "/api/zero/org";

interface AuthMeResponse {
  readonly userId: string;
  readonly email: string;
}

interface ZeroOrgResponse {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
}

/**
 * Injected auth-window driver: the core behavior seam, analogous to
 * `ComputerUseHostRuntime`'s `sessionFetch`. The production implementation wraps
 * all the Electron window machinery (create window, navigation policy, wait for
 * the completion navigation, load the URL) and resolves once the window reaches
 * a completion navigation. The token does NOT flow back through here — it is
 * delivered out-of-band via `completeSignIn` (the single global auth IPC).
 */
type RunAuthWindow = (request: {
  readonly url: string;
  readonly visible: boolean;
  readonly allowInteractiveFallbacks: boolean;
}) => Promise<void>;

interface DesktopAuthSessionOptions {
  /** Pre-resolved API base URL (`resolveComputerUseApiBaseUrl(platformUrl)`). */
  readonly apiBaseUrl: string;
  /**
   * Cookie-merge URLs for auth-state requests, in precedence order
   * (`[webUrl, platformUrl]`). The per-request URL is appended internally so
   * its cookies win last, matching the original `[webUrl, platformUrl, requestUrl]`.
   */
  readonly cookieUrls: readonly URL[];
  readonly cookieSource: DesktopSessionCookieSource;
  /** `buildDesktopAuthTokenUrl(webUrl)`. */
  readonly tokenUrl: string;
  /** `buildDesktopAuthConsumeUrl(webUrl, code)`. */
  readonly consumeUrl: (code: string) => string;
  /** `buildDesktopAuthSelectOrgUrl(webUrl, true)`. */
  readonly selectOrgUrl: string;
  readonly runAuthWindow: RunAuthWindow;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  /**
   * Invoked after an interactive consume / org-selection flow completes, so the
   * caller can restart dependent runtimes. Background token refresh does NOT
   * trigger it.
   */
  readonly onAuthCompleted?: () => Promise<void> | void;
}

function signedOutDesktopAuthState(): DesktopAuthState {
  return {
    status: "signed_out",
    user: null,
    organization: null,
  };
}

function signingInDesktopAuthState(): DesktopAuthState {
  return {
    status: "signing_in",
    user: null,
    organization: null,
  };
}

/**
 * Owns the desktop auth token state machine, extracted from `main.ts` and kept
 * free of Electron imports so it can be integration-tested by injecting fakes,
 * mirroring `ComputerUseHostRuntime`'s dependency-injection shape.
 */
export class DesktopAuthSession {
  private readonly apiBaseUrl: string;
  private readonly cookieUrls: readonly URL[];
  private readonly cookieSource: DesktopSessionCookieSource;
  private readonly tokenUrl: string;
  private readonly consumeUrl: (code: string) => string;
  private readonly selectOrgUrl: string;
  private readonly runAuthWindow: RunAuthWindow;
  private readonly onChange: () => void;
  private readonly onAuthCompleted: () => Promise<void> | void;

  private token: string | null = null;
  private tokenRefresh: Promise<string | null> | null = null;
  private pendingCode: string | null = null;
  private signingIn = false;

  constructor(options: DesktopAuthSessionOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.cookieUrls = options.cookieUrls;
    this.cookieSource = options.cookieSource;
    this.tokenUrl = options.tokenUrl;
    this.consumeUrl = options.consumeUrl;
    this.selectOrgUrl = options.selectOrgUrl;
    this.runAuthWindow = options.runAuthWindow;
    this.onChange = options.onChange ?? (() => {});
    this.onAuthCompleted = options.onAuthCompleted ?? (() => {});
  }

  async getToken(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<string | null> {
    if (!options?.forceRefresh && this.token) {
      return this.token;
    }
    return await this.refresh();
  }

  getCachedToken(): string | null {
    return this.token;
  }

  async getAuthState(): Promise<DesktopAuthState> {
    if (this.signingIn) {
      return signingInDesktopAuthState();
    }

    const state = await this.fetchAuthState();
    if (state.status !== "signed_out") {
      return state;
    }

    const restoredToken = await this.getToken({ forceRefresh: true });
    if (!restoredToken) {
      return state;
    }

    return await this.fetchAuthState();
  }

  private async fetchAuthState(): Promise<DesktopAuthState> {
    const meUrl = new URL(AUTH_ME_PATH, this.apiBaseUrl);
    const meResponse = await this.fetchWithSessionAuth(meUrl);
    if (meResponse.status === 401) {
      return signedOutDesktopAuthState();
    }
    if (!meResponse.ok) {
      throw new Error(`Desktop auth status failed: ${meResponse.status}`);
    }

    const user = (await meResponse.json()) as AuthMeResponse;
    const orgUrl = new URL(ZERO_ORG_PATH, this.apiBaseUrl);
    const orgResponse = await this.fetchWithSessionAuth(orgUrl);
    if (orgResponse.status === 401) {
      return signedOutDesktopAuthState();
    }
    if (orgResponse.status === 404) {
      return { status: "signed_in", user, organization: null };
    }
    if (!orgResponse.ok) {
      throw new Error(
        `Desktop organization status failed: ${orgResponse.status}`,
      );
    }

    const organization = (await orgResponse.json()) as ZeroOrgResponse;
    return {
      status: "signed_in",
      user,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug ?? null,
      },
    };
  }

  completeSignIn(token: string): void {
    this.token = token;
    this.onChange();
  }

  async consumeCode(code: string): Promise<void> {
    this.setSigningIn(true);
    try {
      await this.runAuthWindow({
        url: this.consumeUrl(code),
        visible: false,
        allowInteractiveFallbacks: true,
      });
    } finally {
      this.setSigningIn(false);
    }

    await this.onAuthCompleted();
  }

  async selectOrganization(): Promise<void> {
    await this.runAuthWindow({
      url: this.selectOrgUrl,
      visible: true,
      allowInteractiveFallbacks: true,
    });
    await this.onAuthCompleted();
  }

  queuePendingCode(code: string): void {
    this.pendingCode = code;
  }

  takePendingCode(): string | null {
    const code = this.pendingCode;
    this.pendingCode = null;
    return code;
  }

  private async refresh(): Promise<string | null> {
    if (this.tokenRefresh) {
      return await this.tokenRefresh;
    }

    this.tokenRefresh = (async () => {
      const before = this.token;
      await this.runAuthWindow({
        url: this.tokenUrl,
        visible: false,
        allowInteractiveFallbacks: false,
      });
      const after = this.token;
      // completeSignIn() is the token's only write path. If the refresh window
      // reached a completion navigation without ever delivering a token, the
      // token is unchanged, so surface an explicit null instead of the stale
      // value the 401 retry would otherwise resend.
      return after === before ? null : after;
    })();

    try {
      return await this.tokenRefresh;
    } finally {
      this.tokenRefresh = null;
    }
  }

  private setSigningIn(value: boolean): void {
    if (this.signingIn === value) {
      return;
    }
    this.signingIn = value;
    this.onChange();
  }

  private async fetchWithSessionAuth(requestUrl: URL): Promise<Response> {
    const response = await fetch(requestUrl, {
      headers: await this.headersFor(requestUrl),
    });
    if (response.status !== 401 || !this.token) {
      return response;
    }

    this.token = null;
    return await fetch(requestUrl, {
      headers: await this.headersFor(requestUrl),
    });
  }

  private async headersFor(requestUrl: URL): Promise<Headers> {
    const headers = await headersWithSessionCookies(this.cookieSource, [
      ...this.cookieUrls,
      requestUrl,
    ]);
    if (this.token) {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    return headers;
  }
}
