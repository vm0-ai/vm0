export function runAfterDropdownMenuClose(action: () => void): void {
  // Opening a sibling modal while Radix is closing a menu can leave body pointer events locked.
  window.requestAnimationFrame(() => {
    action();
  });
}
