export default function RootRedirect() {
  return (
    <div style={{ padding: "50px", textAlign: "center" }}>
      <h1>Root Page Works!</h1>
      <p>Redirecting to /en...</p>
      <script
        dangerouslySetInnerHTML={{ __html: `window.location.href = '/en';` }}
      />
    </div>
  );
}
