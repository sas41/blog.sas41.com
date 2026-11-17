# Locally hosted fonts

Source Sans 3, Inter, Source Serif 4, and Atkinson Hyperlegible are distributed
under the SIL Open Font License. Their original license notices are alongside
this file (`*-OFL.txt`).

The unmodified Latin and Latin Extended WOFF2 subsets were obtained from the
Google Fonts CSS API on 2026-11-17. They are served by this site, not loaded from
Google at runtime or downloaded by the build. Variable weights are provided for
the Source families and Inter; Atkinson has regular and bold files. Other scripts
fall back to the reader's system fonts. Italics use browser synthesis.

Each filename contains the first 16 hexadecimal characters of its SHA-256 hash.
When updating a font, use a new content-hashed filename and update
`assets/css/fonts.css`. Do not replace bytes under an immutable filename.
