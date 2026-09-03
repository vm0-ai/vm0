import { Button } from "@okouai/ui";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../signals/route-paths.ts";
import { ProductBrandMark } from "./components/product-brand-mark.tsx";
import { Link } from "./router/link.tsx";

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-primary/[0.035] px-6 py-10">
      <div className="pointer-events-none absolute left-1/2 top-1/2 size-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/[0.06] blur-3xl" />

      <section className="relative w-full max-w-[400px] overflow-hidden rounded-[20px] border border-primary/15 bg-background text-center">
        <div className="relative flex h-28 items-center justify-center overflow-hidden bg-primary/10">
          <div className="absolute -right-16 -top-20 size-44 rounded-full bg-primary/10" />
          <div className="absolute -bottom-20 -left-12 size-40 rounded-full border-[24px] border-primary/10" />
          <div className="relative">
            <ProductBrandMark size="small" />
          </div>
        </div>

        <div className="flex flex-col items-center px-6 pb-10 sm:px-10">
          <p className="relative -mt-4 inline-flex h-8 items-center rounded-full border border-primary/20 bg-background px-3 text-xs font-semibold text-brand-text">
            404
          </p>
          <h1 className="mt-7 text-2xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.shared.notFound.title;
            })}
          </h1>
          <p className="mt-2 max-w-72 text-sm leading-6 text-muted-foreground">
            {t(($) => {
              return $.shared.notFound.description;
            })}
          </p>

          <Button
            asChild
            className="mt-7 bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed"
          >
            <Link pathname={ROUTES.home}>
              <ArrowLeft aria-hidden="true" />
              {t(($) => {
                return $.shared.notFound.action;
              })}
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
