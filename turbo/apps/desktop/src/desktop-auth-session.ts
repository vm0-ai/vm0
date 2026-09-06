import { authContract } from "@okouai/api-contracts/contracts/auth";
import type { DesktopProduct } from "@okouai/api-contracts/contracts/client-headers";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";
import type { DesktopAuthState } from "./desktop-bridge";
import type { DesktopAuthCallback } from "./desktop-auth";
import type { DesktopClientHeaderInjector } from "./desktop-client-headers";
import {
  headersWithSessionCookies,
  type DesktopSessionCookieSource,
} from "./desktop-session-cookies";
import { singleFlight } from "./desktop-async-control";

const AUTH_ME_PATH = "/api/auth/me";
const ZERO_ORG_PATH = "/api/org";

interface AuthMeResponse {
  readonly userId: string;
  readonly email: string;
}

interface ZeroOrgResponse {
  readonly id: string;
  readonly name: string;
}

type RunAuthWindow = (
  request: DesktopAuthWindowRequest,
) => Promise<string | null>;

interface DesktopAuthSessionOptions {
  readonly product: DesktopProduct;
  /** Pre-resolved API base URL (`resolveComputerUseApiBaseUrl(platformUrl)`). */
  readonly apiBaseUrl: string;
  /**
   * Existing Zero-only cookie precedence: [webUrl, platformUrl, requestUrl].
   * Okou never reads these cookies, including the API origin cookie jar.
   */
  readonly cookieUrls: readonly URL[];
  readonly cookieSource: DesktopSessionCookieSource;
  readonly addClientHeaders: DesktopClientHeaderInjector;
  /** `buildDesktopAuthTokenUrl(authUrl)`. */
  readonly tokenUrl: string;
  /** `buildDesktopAuthConsumeUrl(authUrl, code, handoffId)`. */
  readonly consumeUrl: (code: string, handoffId: string | null) => string;
  /** `buildDesktopAuthSelectOrgUrl(authUrl, true)`. */
  readonly selectOrgUrl: string;
  readonly runAuthWindow: RunAuthWindow;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  /**
   * Invoked after an interactive consume / org-selection flow completes, so the
   * caller can restart dependent runtimes. Background token refresh does NOT
   * trigger it.
   */
  readonly onAuthCompleted?: (signal: AbortSignal) => Promise<void> | void;
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
  private readonly product: DesktopProduct;
  private readonly apiBaseUrl: string;
  private readonly cookieUrls: readonly URL[];
  private readonly cookieSource: DesktopSessionCookieSource;
  private readonly addClientHeaders: DesktopClientHeaderInjector;
  private readonly tokenUrl: string;
  private readonly consumeUrl: (
    code: string,
    handoffId: string | null,
  ) => string;
  private readonly selectOrgUrl: string;
  private readonly runAuthWindow: RunAuthWindow;
  private readonly onChange: () => void;
  private readonly onAuthCompleted: (
    signal: AbortSignal,
  ) => Promise<void> | void;

  private token: string | null = null;
  private lifetime = new AbortController();
  private appState: DesktopAuthState = signedOutDesktopAuthState();
  private readonly tokenRefresh = singleFlight(() => this.refreshToken());
  private pendingCallback: DesktopAuthCallback | null = null;
  private signingIn = false;
  private restoreEnabled = true;

  constructor(options: DesktopAuthSessionOptions) {
    this.product = options.product;
    this.apiBaseUrl = options.apiBaseUrl;
    this.cookieUrls = options.cookieUrls;
    this.cookieSource = options.cookieSource;
    this.addClientHeaders = options.addClientHeaders;
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
    if (this.signingIn) return null;
    if (!options?.forceRefresh && this.token) {
      return this.token;
    }
    if (!this.restoreEnabled) {
      return null;
    }
    return await this.refresh();
  }

  /**
   * `init` carries the method and body for non-GET calls. Its `headers` are
   * merged under the session headers, which always win, so a caller cannot
   * accidentally drop the cookie or bearer token.
   */
  async fetchWithSessionAuth(
    requestUrl: URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this.product === "okou") {
      return await this.fetchWithAppAuth(requestUrl, init);
    }
    const response = await fetch(requestUrl, {
      ...init,
      headers: await this.headersFor(requestUrl, init?.headers),
    });
    if (response.status !== 401 || !this.token) {
      return response;
    }

    this.token = null;
    const withCookies = await fetch(requestUrl, {
      ...init,
      headers: await this.headersFor(requestUrl, init?.headers),
    });
    if (withCookies.status !== 401) {
      return withCookies;
    }

    // The token is short-lived, and a call made minutes after the last one —
    // the click track uploaded after a long video — arrives with an expired
    // bearer and cookies that no longer answer either. Delivering a recording
    // must not depend on the token still being the one minted at sign-in:
    // mint a fresh one and try once more. A refresh that yields nothing means
    // the sign-in itself is gone, and the 401 stands.
    const refreshed = await this.getToken({ forceRefresh: true });
    if (!refreshed) {
      return withCookies;
    }
    return await fetch(requestUrl, {
      ...init,
      headers: await this.headersFor(requestUrl, init?.headers),
    });
  }

  getCachedToken(): string | null {
    return this.token;
  }

  async getAuthState(): Promise<DesktopAuthState> {
    if (this.signingIn) {
      return signingInDesktopAuthState();
    }
    if (!this.restoreEnabled) {
      return signedOutDesktopAuthState();
    }

    if (this.product === "okou") {
      return await this.getAppAuthState();
    }

    // With a cached token, a rejected request already refreshes and retries
    // inside fetchWithSessionAuth; a second hidden refresh here would only
    // open the window again for the same answer.
    const hadToken = this.token !== null;
    const state = await this.fetchAuthState();
    if (state.status !== "signed_out" || hadToken) {
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
      },
    };
  }

  signOut(): void {
    this.lifetime.abort();
    this.token = null;
    this.appState = signedOutDesktopAuthState();
    this.tokenRefresh.clear();
    this.pendingCallback = null;
    this.signingIn = false;
    this.restoreEnabled = false;
    this.onChange();
  }

  async consumeCode(
    code: string,
    handoffId: string | null = null,
  ): Promise<void> {
    this.tokenRefresh.clear();
    await this.authenticate(this.consumeUrl(code, handoffId), true, false);
  }

  async selectOrganization(): Promise<void> {
    this.tokenRefresh.clear();
    await this.authenticate(this.selectOrgUrl, true, true);
  }

  /**
   * Fire-and-forget consume of a parsed auth callback, so callers just hand
   * the session a callback instead of re-implementing the consume plumbing.
   */
  consumeCallback(
    callback: DesktopAuthCallback,
    onError: (error: unknown) => void,
  ): void {
    void this.consumeCode(callback.code, callback.handoffId).catch(onError);
  }

  queuePendingCallback(callback: DesktopAuthCallback): void {
    this.pendingCallback = callback;
  }

  takePendingCallback(): DesktopAuthCallback | null {
    const callback = this.pendingCallback;
    this.pendingCallback = null;
    return callback;
  }

  private async refresh(): Promise<string | null> {
    return await this.tokenRefresh();
  }

  private async refreshToken(): Promise<string | null> {
    try {
      return await this.authenticate(this.tokenUrl, false, false);
    } catch (error) {
      // A failed App restoration requires explicit sign-in, never another
      // identity source. Interactive failures still reject to the caller.
      if (this.product === "okou") return null;
      throw error;
    }
  }

  private async authenticate(
    url: string,
    interactive: boolean,
    visible: boolean,
  ): Promise<string | null> {
    this.lifetime.abort();
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    this.restoreEnabled = true;
    this.token = null;
    this.appState = signedOutDesktopAuthState();
    this.setSigningIn(interactive);
    // The lifetime also owns validation requests after the window closes.
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      const token = await this.runAuthWindow({
        url,
        visible,
        allowInteractiveFallbacks: interactive,
        signal,
      });
      signal.throwIfAborted();
      if (!token) return null;
      if (this.product === "okou") {
        const state = await this.readAppIdentity(token, signal);
        signal.throwIfAborted();
        if (state.status !== "signed_in") return null;
        this.appState = state;
      }
      this.token = token;
      this.onChange();
      if (interactive) {
        this.setSigningIn(false);
        await this.onAuthCompleted(lifetime.signal);
        lifetime.signal.throwIfAborted();
      }
      return token;
    } catch (error) {
      if (this.lifetime === lifetime) {
        this.token = null;
        this.appState = signedOutDesktopAuthState();
      }
      if (!interactive && signal.aborted) return null;
      throw error;
    } finally {
      if (this.lifetime === lifetime) this.setSigningIn(false);
    }
  }

  private async appRequest(
    requestUrl: URL,
    token: string,
    signal: AbortSignal,
    init?: RequestInit,
  ): Promise<Response> {
    if (requestUrl.origin !== new URL(this.apiBaseUrl).origin) {
      throw new Error("Invalid Desktop API origin");
    }
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${token}`);
    this.addClientHeaders(headers);
    const response = await fetch(requestUrl, {
      ...init,
      headers,
      credentials: "omit",
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
    signal.throwIfAborted();
    return response;
  }

  private async readAppIdentity(
    token: string,
    signal: AbortSignal,
  ): Promise<DesktopAuthState> {
    const me = await this.appRequest(
      new URL(AUTH_ME_PATH, this.apiBaseUrl),
      token,
      signal,
    );
    if (me.status === 401) return signedOutDesktopAuthState();
    if (!me.ok) throw new Error(`Desktop auth status failed: ${me.status}`);
    const user = authContract.me.responses[200].parse(await me.json());
    signal.throwIfAborted();
    if (!user.userId || !user.orgId) return signedOutDesktopAuthState();
    // Both reads use the identical server-verified bearer; never refresh only
    // the second half of the user/workspace pair.
    const org = await this.appRequest(
      new URL(ZERO_ORG_PATH, this.apiBaseUrl),
      token,
      signal,
    );
    if (org.status === 401 || org.status === 404)
      return signedOutDesktopAuthState();
    if (!org.ok)
      throw new Error(`Desktop organization status failed: ${org.status}`);
    const organization: unknown = await org.json();
    signal.throwIfAborted();
    if (
      typeof organization !== "object" ||
      organization === null ||
      !("id" in organization) ||
      organization.id !== user.orgId ||
      !("name" in organization) ||
      typeof organization.name !== "string"
    ) {
      return signedOutDesktopAuthState();
    }
    return {
      status: "signed_in",
      user: { userId: user.userId, email: user.email },
      organization: { id: user.orgId, name: organization.name },
    };
  }

  private async getAppAuthState(): Promise<DesktopAuthState> {
    if (!this.token) {
      await this.getToken();
      return this.appState;
    }
    const lifetime = this.lifetime;
    try {
      const state = await this.readAppIdentity(this.token, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (state.status === "signed_in") return state;
      await this.getToken({ forceRefresh: true });
      return this.appState;
    } catch (error) {
      if (lifetime.signal.aborted) return signedOutDesktopAuthState();
      throw error;
    }
  }

  private async fetchWithAppAuth(
    requestUrl: URL,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await this.getToken();
    if (!token || token !== this.token)
      return new Response(null, { status: 401 });
    const lifetime = this.lifetime;
    const response = await this.appRequest(
      requestUrl,
      token,
      lifetime.signal,
      init,
    );
    if (response.status !== 401) return response;
    // No cookie-only retry. One App refresh and at most one authenticated retry.
    const refreshed = await this.getToken({ forceRefresh: true });
    if (!refreshed || refreshed !== this.token) return response;
    const retried = await this.appRequest(
      requestUrl,
      refreshed,
      this.lifetime.signal,
      init,
    );
    if (retried.status === 401) {
      this.token = null;
      this.appState = signedOutDesktopAuthState();
      this.onChange();
    }
    return retried;
  }

  private setSigningIn(value: boolean): void {
    if (this.signingIn === value) {
      return;
    }
    this.signingIn = value;
    this.onChange();
  }

  private async headersFor(
    requestUrl: URL,
    extraHeaders?: HeadersInit,
  ): Promise<Headers> {
    const headers = await headersWithSessionCookies(
      this.cookieSource,
      [...this.cookieUrls, requestUrl],
      extraHeaders,
    );
    if (this.token) {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    this.addClientHeaders(headers);
    return headers;
  }
}
