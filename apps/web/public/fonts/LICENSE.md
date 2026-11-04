# Self-hosted fonts

All four faces are SIL Open Font License 1.1, Latin and Latin Extended subsets only (no
Cyrillic, Greek or Vietnamese glyph files are shipped), vendored from the `@fontsource`
packages named in `apps/web/package.json` so the app serves them from its own origin:

- `eb-garamond-latin*.woff2` — EB Garamond (The EB Garamond Project Authors).
- `cinzel-latin-*.woff2` — Cinzel (Natanael Gama).
- `italianno-latin-400-normal.woff2` — Italianno (Sabrina Mariela Lopez).
- `jetbrains-mono-latin-wght-normal.woff2` — JetBrains Mono (JetBrains s.r.o.).

See `apps/web/src/styles/fonts.css` for the `@font-face` rules. Full OFL text:
http://scripts.sil.org/OFL
