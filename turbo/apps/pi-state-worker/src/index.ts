import { verifyCapabilityToken } from "./capability";
import {
  CAPABILITY_HEADER,
  handleThreadRequest,
  jsonResponse,
  ThreadStore,
} from "./thread";
import type { ThreadStoreContext } from "./thread";

interface ThreadObjectId {
  toString(): string;
}

interface ThreadObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface ThreadNamespace {
  idFromName(name: string): ThreadObjectId;
  get(id: ThreadObjectId): ThreadObjectStub;
}

interface Env {
  readonly PI_THREADS: ThreadNamespace;
  readonly TOKEN_PUBLIC_KEY: string;
}

interface DurableObjectStateLike {
  readonly storage: ThreadStoreContext;
}

export class PiThreadDurableObject {
  private readonly store: ThreadStore;

  constructor(state: DurableObjectStateLike) {
    this.store = new ThreadStore(state.storage);
  }

  fetch(request: Request): Promise<Response> {
    return handleThreadRequest(this.store, request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) {
      return jsonResponse(404, { error: "not_found" });
    }
    const authorization = request.headers.get("Authorization");
    if (!authorization || !authorization.startsWith("Bearer ")) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    const claims = await verifyCapabilityToken(
      authorization.slice("Bearer ".length),
      env.TOKEN_PUBLIC_KEY,
      Math.floor(Date.now() / 1000),
    );
    if (!claims) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    headers.set(
      CAPABILITY_HEADER,
      JSON.stringify({ runId: claims.runId, scopes: claims.scopes }),
    );
    const objectId = env.PI_THREADS.idFromName(claims.threadKey);
    return env.PI_THREADS.get(objectId).fetch(
      new Request(request, { headers }),
    );
  },
};
