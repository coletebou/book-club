import { Suspense, lazy, useEffect, useState } from 'react';

const SearchDialog = lazy(() => import('./SearchDialog'));

export function SearchLauncher() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const openOnSlash = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const active = document.activeElement;
      if ((active instanceof HTMLElement && active.isContentEditable) || active?.closest('input, textarea, select') || document.querySelector('[aria-modal=true]')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', openOnSlash);
    return () => window.removeEventListener('keydown', openOnSlash);
  }, []);

  return (
    <>
      <button type="button" className="btn btn-small btn-ghost" aria-keyshortcuts="/" onClick={() => setOpen(true)}>Search</button>
      {open ? <Suspense fallback={null}><SearchDialog onClose={() => setOpen(false)} /></Suspense> : null}
    </>
  );
}
