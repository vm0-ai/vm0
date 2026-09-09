/** Drain in-flight storage operations before propagating the first failure. */
export async function forEachConcurrent<T>(
  items: Iterable<T> | AsyncIterable<T>,
  concurrency: number,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  async function* source() {
    yield* items;
  }
  const iterator = source();
  let failure: { readonly error: unknown } | undefined;
  async function worker() {
    while (!failure) {
      try {
        const next = await iterator.next();
        if (next.done || failure) return;
        await visit(next.value);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await iterator.return(undefined);
  if (failure) throw failure.error;
}
