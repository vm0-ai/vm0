import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="flex h-full items-center justify-center bg-white px-6">
      <div className="text-center">
        <p className="text-sm font-semibold text-blue-600">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-gray-950">
          {t(($) => {
            return $.shared.notFound.title;
          })}
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          {t(($) => {
            return $.shared.notFound.description;
          })}
        </p>
      </div>
    </main>
  );
}
