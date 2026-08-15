export function parseBoundedLogCount(
  value: string,
  optionName: string,
  min: number,
  max: number,
): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${optionName} must be between ${min} and ${max}`);
  }

  const count = Number(trimmed);
  if (!Number.isSafeInteger(count) || count < min || count > max) {
    throw new Error(`${optionName} must be between ${min} and ${max}`);
  }

  return count;
}
