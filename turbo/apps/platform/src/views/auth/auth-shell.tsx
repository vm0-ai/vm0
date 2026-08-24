import { Moon, Sun } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  platformVm0LogoDarkImg,
  platformVm0LogoImg,
} from "../../lib/static-assets.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";
import { setTheme$, theme$ } from "../../signals/theme.ts";

interface AuthShellProps {
  authBrand: AuthBrandContext;
  children: ReactNode;
}

export function AuthShell({ authBrand, children }: AuthShellProps) {
  const { t } = useTranslation();
  const theme = useGet(theme$);
  const setTheme = useSet(setTheme$);

  return (
    <div
      className="relative flex h-full min-h-0 overflow-x-hidden overflow-y-auto bg-background p-6"
      data-testid="app-auth-layout"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.06)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.06)_1px,transparent_1px)] bg-[size:3rem_3rem]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />
      <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-[#FFC8B0]/15 blur-3xl" />
      <div className="pointer-events-none absolute top-1/2 left-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#A6DEFF]/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-40 -bottom-40 h-96 w-96 rounded-full bg-[#FFE7A2]/15 blur-3xl" />

      <button
        onClick={() => {
          setTheme(theme === "dark" ? "light" : "dark");
        }}
        className="fixed right-[calc(1.5rem+var(--sar))] top-[calc(1.5rem+var(--sat))] z-50 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-card-hover"
        aria-label={t(($) => {
          return $.auth.toggleTheme;
        })}
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      <a
        href={authBrand.homeUrl}
        className="absolute left-6 top-6 flex items-center gap-2"
      >
        {authBrand.brandName === "Okou" ? (
          <span className="text-xl font-semibold tracking-tight">
            {authBrand.brandName}
          </span>
        ) : (
          <img
            src={theme === "dark" ? platformVm0LogoImg : platformVm0LogoDarkImg}
            alt={t(($) => {
              return $.appShell.logoAlt;
            })}
            crossOrigin="anonymous"
            width={82}
            height={20}
          />
        )}
      </a>

      <div className="relative z-10 m-auto flex w-full min-w-0 justify-center">
        {children}
      </div>
    </div>
  );
}
