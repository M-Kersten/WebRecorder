# Bundled fonts

Referenced from a theme by relative path. Two rendering paths consume them, and
they disagree about how a font is named:

- **libass** (burned captions) matches on the family name stored *inside* the
  file, and silently falls back to a system font when it does not match.
- **Chromium** (intro/outro cards, hint blocks) uses whatever `@font-face`
  declares, and the file is inlined as a data URI so there is no network or CORS
  involved.

`theme.js` reads the internal name out of the file and refuses to start when
`family` in the theme disagrees with it, so the libass fallback cannot happen
quietly. Leave `family` out entirely and it is read from the file.

| File | Internal family | Weight | Licence |
| --- | --- | --- | --- |
| `OverusedGrotesk-Roman.ttf` | `Overused Grotesk` | 400 | SIL OFL 1.1 |
| `OverusedGrotesk-Bold.ttf` | `Overused Grotesk` | 700 | SIL OFL 1.1 |
| `Inter-Regular.ttf` | `Inter` | 400 | SIL OFL 1.1 |
| `Poppins-Bold.ttf` | `Poppins` | 700 | SIL OFL 1.1 |

Overused Grotesk is by Bao Nguyen (RandomMaerks),
<https://github.com/RandomMaerks/Overused-Grotesk>, licence in
`OverusedGrotesk-OFL.txt`. Its 400 weight is called **Roman**, not Regular;
there is no file by that name. Both weights report the same family, so libass
picks between them by the weight the theme asks for.

Only static instances are bundled. The project also ships a variable font, but
libass cannot set a variable axis and would render its default instance for
every weight.

To add your own, drop the `.ttf`/`.otf` in here and declare it under `fonts{}`.
Check the internal name first:

    fc-scan --format "%{family}\n" fonts/YourFont.ttf

`.woff` and `.woff2` do not work; libass cannot read them.
