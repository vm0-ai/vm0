export default function CliAuthSuccessPage(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md text-center">
        <div className="mb-6 text-6xl">✓</div>

        <h1 className="mb-4 text-2xl font-bold text-gray-900">
          Device Authorized
        </h1>

        <p className="mb-6 text-gray-600">
          Your CLI has been successfully authorized. You can now close this
          window and return to your terminal.
        </p>

        <p className="text-sm text-gray-500">
          The CLI will automatically detect the authorization and complete the
          login process.
        </p>
      </div>
    </div>
  );
}
