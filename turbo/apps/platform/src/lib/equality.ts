type EqualityFn<T> = (previous: T, next: T) => boolean;

export function equalArrays<T>(
  previous: readonly T[],
  next: readonly T[],
  equalItem: EqualityFn<T> = Object.is,
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }
  return previous.every((item, index) => {
    return equalItem(item, next[index]!);
  });
}

export function equalSets<T>(
  previous: ReadonlySet<T>,
  next: ReadonlySet<T>,
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.size !== next.size) {
    return false;
  }
  for (const item of previous) {
    if (!next.has(item)) {
      return false;
    }
  }
  return true;
}
