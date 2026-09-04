import { createStore, state } from "ccstate";

interface ClerkWorkerInitialization {
  readonly domain: string | undefined;
  readonly publishableKey: string;
}

interface ClerkWorkerLoad {
  readonly standardBrowser: boolean | undefined;
}

export interface ClerkWorkerMock {
  readonly initializations: ClerkWorkerInitialization[];
  readonly loads: ClerkWorkerLoad[];
  readonly request: (url: string) => string;
  readonly respond: (headers: HeadersInit) => void;
}

interface ClerkRequest {
  url?: string;
}

type BeforeRequest = (request: ClerkRequest) => void;
type AfterResponse = (
  request: ClerkRequest,
  response: { readonly headers: Headers },
) => void;

interface ClerkWorkerBehavior extends ClerkWorkerMock {
  activeInstance: Clerk | null;
}

const activeBehavior$ = state<ClerkWorkerBehavior | null>(null);
const behaviorStore = createStore();

function activeBehavior(): ClerkWorkerBehavior {
  const behavior = behaviorStore.get(activeBehavior$);
  if (!behavior) {
    throw new Error("Clerk worker behavior was not configured");
  }
  return behavior;
}

export function mockClerkWorker(signal: AbortSignal): ClerkWorkerMock {
  const behavior: ClerkWorkerBehavior = {
    activeInstance: null,
    initializations: [],
    loads: [],
    request(url) {
      const request = { url };
      behavior.activeInstance?.applyBeforeRequest(request);
      return request.url ?? url;
    },
    respond(headers) {
      behavior.activeInstance?.applyAfterResponse({
        headers: new Headers(headers),
      });
    },
  };
  behaviorStore.set(activeBehavior$, behavior);
  signal.addEventListener(
    "abort",
    () => {
      if (behaviorStore.get(activeBehavior$) === behavior) {
        behaviorStore.set(activeBehavior$, null);
      }
    },
    { once: true },
  );
  return behavior;
}

export class Clerk {
  readonly session = null;
  readonly beforeRequest: BeforeRequest[] = [];
  readonly afterResponse: AfterResponse[] = [];

  constructor(publishableKey: string, options?: { readonly domain?: string }) {
    const behavior = activeBehavior();
    behavior.activeInstance = this;
    behavior.initializations.push({
      domain: options?.domain,
      publishableKey,
    });
  }

  addListener(): () => void {
    return () => {};
  }

  __internal_onBeforeRequest(callback: BeforeRequest): void {
    this.beforeRequest.push(callback);
  }

  __internal_onAfterResponse(callback: AfterResponse): void {
    this.afterResponse.push(callback);
  }

  load(options: { readonly standardBrowser?: boolean }): Promise<void> {
    activeBehavior().loads.push({
      standardBrowser: options.standardBrowser,
    });
    return Promise.resolve();
  }

  applyBeforeRequest(request: ClerkRequest): void {
    for (const callback of this.beforeRequest) {
      callback(request);
    }
  }

  applyAfterResponse(response: { readonly headers: Headers }): void {
    for (const callback of this.afterResponse) {
      callback({}, response);
    }
  }
}
