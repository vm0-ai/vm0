export function composerInputMinHeightClass(
  singleLineOnMobile: boolean,
): string {
  return singleLineOnMobile ? "min-h-[72px] md:min-h-[96px]" : "min-h-[96px]";
}
