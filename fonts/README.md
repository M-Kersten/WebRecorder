# Bundled fonts

Referenced from `theme.json` by relative path. Two rendering paths consume
them, and they disagree about how a font is named:

- **libass** (burned captions) matches on the family name stored *inside* the
  file, and silently falls back to a system font when it does not match.
- **Chromium** (intro/outro cards) uses whatever `@font-face` declares, and the
  file is inlined as a data URI so there is no network or CORS involved.

`theme.js` reads the internal name out of the file and refuses to start when
`family` in `theme.json` disagrees with it, so the libass fallback cannot
happen quietly. Leave `family` out entirely and it is read from the file.

| File | Internal family | Licence |
| --- | --- | --- |
| `Inter-Regular.ttf` | `Inter` | SIL Open Font License 1.1 |
| `Poppins-Bold.ttf` | `Poppins` | SIL Open Font License 1.1 |

To add your own, drop the `.ttf`/`.otf` in here and declare it under `fonts{}`.
Check the internal name first:

    fc-scan --format "%{family}\n" fonts/YourFont.ttf

`.woff` and `.woff2` do not work - libass cannot read them.
