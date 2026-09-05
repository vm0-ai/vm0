import { ProductBrandMarkLink } from "../okou-page/directed-shared.tsx";

export function formatTime(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AuthorizationErrorState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center px-4">
      <div className="flex w-[430px] max-w-full flex-col items-center gap-6 rounded-xl border border-border bg-background px-6 py-10 text-center">
        <ProductBrandMarkLink />
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-medium text-foreground">{title}</h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}
