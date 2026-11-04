/**
 * The marks for the provider sign-in buttons (D178, redesigned per Cole's note on the generic
 * single-style buttons): Apple's own glyph (currentColor, so it follows `.btn-apple`'s black/white
 * swap between themes), Google's official four-colour "G" (fixed brand colours, never recoloured
 * by a theme), and a neutral mark for the upstream (an arrow going in at a door, drawn for this app,
 * `currentColor` so it reads in ink on the neutral provider surface like the rest of its label).
 * Inline SVG, not `<img>`: one request fewer, and `currentColor` only works inline.
 */

export function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.838 0 2.35.987 3.96.948 1.638-.026 2.676-1.48 3.676-2.948 1.164-1.688 1.64-3.325 1.667-3.428-.039-.013-3.185-1.22-3.185-4.832 0-3.05 2.496-4.52 2.611-4.598-1.432-2.105-3.636-2.34-4.39-2.389-1.9-.142-3.497 1.025-4.669 1.025zm3.63-3.278c.837-1.02 1.4-2.436 1.245-3.843-1.207.052-2.662.818-3.53 1.84-.78.907-1.456 2.355-1.272 3.743 1.345.104 2.72-.68 3.556-1.74z" />
    </svg>
  );
}

export function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.4673-.8059 5.9577-2.1805l-2.9087-2.2581c-.7959.5345-1.8132.8564-3.049.8564-2.3436 0-4.3282-1.5818-5.0373-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z" />
      <path fill="#FBBC05" d="M3.9627 10.71c-.18-.5345-.2823-1.1059-.2823-1.71s.1023-1.1755.2823-1.71V4.9582H.9573C.3477 6.1731 0 7.5477 0 9s.3477 2.8269.9573 4.0418L3.9627 10.71z" />
      <path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9627 7.29C4.6718 5.1618 6.6564 3.5795 9 3.5795z" />
    </svg>
  );
}

export function UpstreamMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5v-2h5V6h-5z" />
      <path d="M5 11h6V7.5l5 4.5-5 4.5V13H5a1 1 0 0 1 0-2z" />
    </svg>
  );
}
