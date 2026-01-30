import { IconSun, IconMoon } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { theme$, toggleTheme$ } from "../../signals/theme.ts";

export function ThemeToggle() {
  const theme = useGet(theme$);
  const setToggleTheme = useSet(toggleTheme$);

  const handleToggle = () => {
    setToggleTheme();
  };

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleToggle}
            className="icon-button"
            aria-label="Toggle theme"
          >
            {theme === "light" ? (
              <IconMoon size={18} className="text-foreground" />
            ) : (
              <IconSun size={18} className="text-foreground" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            {theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
