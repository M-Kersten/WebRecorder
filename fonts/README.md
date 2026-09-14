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

Every file here is offered to every style, keyed by family and weight. Nothing
has to be declared in a theme first: `fontcatalog.js` reads the folder, takes
each family name out of its file, and takes the weight from the file name. A
theme that declares a key of its own wins over the folder.

| Key | File | Internal family | Weight |
| --- | --- | --- | --- |
| `archivo` | `Archivo-Regular.ttf` | `Archivo` | 400 |
| `archivo-bold` | `Archivo-Bold.ttf` | `Archivo` | 700 |
| `bricolage-grotesque` | `BricolageGrotesque-Regular.ttf` | `Bricolage Grotesque` | 400 |
| `bricolage-grotesque-bold` | `BricolageGrotesque-Bold.ttf` | `Bricolage Grotesque` | 700 |
| `dm-sans` | `DMSans-Regular.ttf` | `DM Sans` | 400 |
| `dm-sans-bold` | `DMSans-Bold.ttf` | `DM Sans` | 700 |
| `figtree` | `Figtree-Regular.ttf` | `Figtree` | 400 |
| `figtree-bold` | `Figtree-Bold.ttf` | `Figtree` | 700 |
| `fraunces` | `Fraunces-Regular.ttf` | `Fraunces` | 400 |
| `fraunces-bold` | `Fraunces-Bold.ttf` | `Fraunces` | 700 |
| `inter` | `Inter-Regular.ttf` | `Inter` | 400 |
| `inter-bold` | `Inter-Bold.ttf` | `Inter` | 700 |
| `jetbrains-mono` | `JetBrainsMono-Regular.ttf` | `JetBrains Mono` | 400 |
| `jetbrains-mono-bold` | `JetBrainsMono-Bold.ttf` | `JetBrains Mono` | 700 |
| `manrope` | `Manrope-Regular.ttf` | `Manrope` | 400 |
| `manrope-bold` | `Manrope-Bold.ttf` | `Manrope` | 700 |
| `outfit` | `Outfit-Regular.ttf` | `Outfit` | 400 |
| `outfit-bold` | `Outfit-Bold.ttf` | `Outfit` | 700 |
| `overused-grotesk` | `OverusedGrotesk-Roman.ttf` | `Overused Grotesk` | 400 |
| `overused-grotesk-bold` | `OverusedGrotesk-Bold.ttf` | `Overused Grotesk` | 700 |
| `plus-jakarta-sans` | `PlusJakartaSans-Regular.ttf` | `Plus Jakarta Sans` | 400 |
| `plus-jakarta-sans-bold` | `PlusJakartaSans-Bold.ttf` | `Plus Jakarta Sans` | 700 |
| `poppins` | `Poppins-Regular.ttf` | `Poppins` | 400 |
| `poppins-bold` | `Poppins-Bold.ttf` | `Poppins` | 700 |
| `sora` | `Sora-Regular.ttf` | `Sora` | 400 |
| `sora-bold` | `Sora-Bold.ttf` | `Sora` | 700 |
| `space-grotesk` | `SpaceGrotesk-Regular.ttf` | `Space Grotesk` | 400 |
| `space-grotesk-bold` | `SpaceGrotesk-Bold.ttf` | `Space Grotesk` | 700 |

All of these are SIL Open Font License 1.1. Overused Grotesk ships its licence
as `OverusedGrotesk-OFL.txt`; the rest come from Google Fonts under the same
terms, which permit bundling and redistribution with attribution.

Two weights of one family sit in this folder together. libass is handed the
folder and a family name and picks between them on the bold flag alone, which
`captions.js` sets from the declared weight. That is what the weight column is
for: without it a caption asking for the bold file gets the regular one.

To add one, drop a `.ttf` or `.otf` in and it turns up in the Styles tab. Name
it `Family-Weight.ttf` so the weight reads correctly (`Bold`, `Medium`,
`Light`, `Italic`); anything unrecognised is treated as 400.
