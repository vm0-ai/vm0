import { Button } from "@okouai/ui";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../signals/route-paths.ts";
import { ProductBrandMark } from "./components/product-brand-mark.tsx";
import { Link } from "./router/link.tsx";

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-gray-50 px-6 py-10 dark:bg-gray-100">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />

      <section className="relative flex w-full max-w-[430px] flex-col items-center rounded-[20px] border border-border bg-background px-6 py-10 text-center sm:px-12 sm:py-12">
        <ProductBrandMark />

        <div className="mt-10 flex flex-col items-center">
          <div className="relative">
            <p className="select-none text-[5rem] font-semibold leading-none tracking-[-0.08em] text-foreground sm:text-8xl">
              404
            </p>
            <span className="absolute -right-2 top-0 size-3 rounded-full bg-primary" />
          </div>
          <h1 className="mt-7 text-xl font-medium text-foreground">
            {t(($) => {
              return $.shared.notFound.title;
            })}
          </h1>
          <p className="mt-2 max-w-72 text-sm leading-6 text-muted-foreground">
            {t(($) => {
              return $.shared.notFound.description;
            })}
          </p>
        </div>

        <Button
          asChild
          className="mt-8 bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
        >
          <Link pathname={ROUTES.home}>
            <ArrowLeft aria-hidden="true" />
            {t(($) => {
              return $.shared.notFound.action;
            })}
          </Link>
        </Button>
      </section>
    </main>
  );
}
