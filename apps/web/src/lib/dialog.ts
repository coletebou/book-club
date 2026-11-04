/** A dialog is open over the page (the finished card, a note being written): keys are its, not the page's. */
export function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}
