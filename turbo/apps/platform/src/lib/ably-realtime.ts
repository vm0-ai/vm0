import {
  BaseRealtime,
  FetchRequest,
  WebSocketTransport,
  XHRPolling,
} from "ably/modular";

type AblyRealtimeOptions = Omit<
  ConstructorParameters<typeof BaseRealtime>[0],
  "plugins"
>;

export type AblyRealtime = BaseRealtime;

export function createAblyRealtime(options: AblyRealtimeOptions): AblyRealtime {
  return new BaseRealtime({
    ...options,
    plugins: {
      FetchRequest,
      WebSocketTransport,
      XHRPolling,
    },
  });
}
