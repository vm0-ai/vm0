import { IconSun, IconMoon } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { theme$, toggleTheme$ } from "../../signals/theme.ts";

export function ThemeToggle() {
  const theme = useGet(theme$);
  const setToggleTheme = useSet(toggleTheme$);

  const handleToggle = () => {
    setToggleTheme();
  };

  return (
    <button
      onClick={handleToggle}
      className="flex items-center justify-center size-9 hover:bg-muted rounded-lg transition-colors"
      aria-label="Toggle theme"
    >
      {theme === "light" ? (
        <IconMoon size={18} stroke={1.5} className="text-foreground" />
      ) : (
        <IconSun size={18} stroke={1.5} className="text-foreground" />
      )}
    </button>
  );
}
