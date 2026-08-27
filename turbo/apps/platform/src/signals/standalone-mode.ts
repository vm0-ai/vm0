/**
 * Returns true when the app is running as an installed PWA (standalone display
 * mode).
 */
export function isStandaloneMode(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}
