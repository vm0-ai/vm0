// Conditional polyfill for AbortSignal.any()
// Only activates when native support is missing (older browsers)

if (typeof AbortSignal.any !== "function") {
  function anySignal(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    function onAbort(reason: unknown): void {
      controller.abort(reason);
    }

    for (const signal of signals) {
      if (signal.aborted) {
        onAbort(signal.reason);
        break;
      }

      signal.addEventListener(
        "abort",
        (event) => {
          const target = event.target as AbortSignal;
          onAbort(target.reason);
        },
        { signal: controller.signal },
      );
    }

    return controller.signal;
  }

  AbortSignal.any = anySignal;
}
