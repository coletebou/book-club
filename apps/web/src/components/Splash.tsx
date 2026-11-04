export function Splash({ label }: { label: string }) {
  return (
    <div className="center-page" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p className="muted">{label}…</p>
    </div>
  );
}
