export function runAfterDropdownMenuClose(action: () => void): void {
  window.requestAnimationFrame(() => {
    action();
  });
}
