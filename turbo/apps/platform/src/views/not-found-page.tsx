export function NotFoundPage() {
  return (
    <main className="flex h-screen items-center justify-center bg-white px-6">
      <div className="text-center">
        <p className="text-sm font-semibold text-blue-600">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-gray-950">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          The page you are looking for does not exist.
        </p>
      </div>
    </main>
  );
}
