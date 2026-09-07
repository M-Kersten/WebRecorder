# site-tutorial-video

Turns a `flow.json` into a narrated, branded walkthrough video of a live
website. Playwright drives a real browser through the steps, ElevenLabs reads
the narration, and ffmpeg assembles the result with captions and intro/outro
cards. Everything about how it looks lives in one `theme.json`.

```
node src/index.js --flow demo/flow.json --serve demo --no-tts --out out/demo.mp4
```

That command needs no API key and no network: it serves the bundled demo site,
uses timed silence instead of speech, and produces a finished video.

## How it fits together

```
flow.json ──┐
            ├─► tts.js ────► narration clips (cached) ──┐
theme.json ─┤                    │ durations            │
            │                    ▼                      │
            ├─► recorder.js ──► video + per-step timestamps
            │                                           │
            ├─► captions.js ──► .srt + .ass ────────────┤
            │                                           ▼
            └─► titlecard.js ─► intro/outro PNGs ──► ffmpeg.js ──► out.mp4
```

**Narration is generated before the browser starts.** That ordering is the
whole reason the timing works: each line's real duration is known up front, so
the recorder can hold every step on screen for at least as long as it takes to
say. Nothing is estimated after the fact.

**Each step's actual start time is recorded as it happens.** The narration
track is then built by placing every clip at its measured timestamp with
`adelay`, and mixing. Audio is never assumed to run end to end.

**Captions are a post-process.** Restyling them regenerates a subtitle file and
re-burns; it never re-records. That matters when you are iterating on how a font
looks.

## Setup

```bash
npm install
export ELEVENLABS_API_KEY=...    # not needed for --no-tts
node src/index.js --flow flow.json --theme theme.json --out out/tutorial.mp4
```

`ffmpeg` and `ffprobe` must be on `PATH`, built with **libass** and **libx264**.
Startup checks for both and says so if either is missing. The stripped-down
ffmpeg that ships inside Playwright will not work.

If Chromium is already installed somewhere the tool cannot guess, point
`CHROMIUM_EXECUTABLE_PATH` at it; otherwise `npx playwright install chromium`.

## flow.json

```jsonc
{
  "name": "Dashboard walkthrough",
  "baseUrl": "https://app.example.com",
  "minStepMs": 1400,       // floor per step, so a short line still reads
  "stepPaddingMs": 600,    // beat after the narration ends
  "steps": [
    { "action": "goto",   "url": "/",             "narration": "This is the dashboard." },
    { "action": "hover",  "selector": ".card",    "narration": "Revenue sits top left." },
    { "action": "type",   "selector": "#search", "text": "hooli",
      "narration": "Start typing to filter." },
    { "action": "click",  "selector": "#run",     "narration": "Run rebuilds the numbers." },
    { "action": "scroll", "selector": "#cohorts", "narration": "Retention is further down." },
    { "action": "wait",   "durationMs": 1500 }
  ]
}
```

| Action | Requires | Also accepts |
| --- | --- | --- |
| `goto` | `url` | — |
| `click` | `selector` | — |
| `type` | `selector`, `text` | `delayMs` (per keystroke, default 55) |
| `hover` | `selector` | — |
| `scroll` | — | `selector` to scroll to, or `to` in px |
| `wait` | — | `durationMs` (default 1000) |

Every step may carry `narration`. Steps without it are silent and uncaptioned.
`//` and `/* */` comments are allowed in both `flow.json` and `theme.json`.

## theme.json

Copy `theme.example.json` to `theme.json` and edit. A missing theme file is an
error rather than a silent fall-back to defaults, the same way `flow.json` is —
a mistyped `--theme` path should never quietly produce an unbranded video. Any
field you leave out does fall back, so a theme can be as short as you like.

### `fonts`

```jsonc
"fonts": {
  "heading": { "family": "Poppins", "file": "fonts/Poppins-Bold.ttf", "weight": 700 },
  "body":    { "family": "Inter",   "file": "fonts/Inter-Regular.ttf", "weight": 400 }
}
```

The key is your name for it, referenced everywhere else in the file, so swapping
a brand font means editing one line. `family` must match the name stored inside
the font file — leave it out and it is read from the file for you. Paths are
relative to `theme.json`. Use `.ttf` or `.otf`; libass cannot read `.woff2`.

### `captions`

| Field | Meaning |
| --- | --- |
| `font` | a key from `fonts` |
| `fontSize` | literal pixels in the output frame, matching CSS `font-size` |
| `color` | text colour |
| `backgroundColor`, `backgroundOpacity` | the box behind the text; opacity `0` turns it off |
| `position` | `"bottom"` or `"top"` |
| `marginBottom` | distance in px from that edge |
| `outline` | see below |

`outline` means different things in the two background modes, because ASS
cannot do both at once. With a background (`backgroundOpacity > 0`) the text
sits in an opaque box and `outline` controls how generously it is padded.
Without one, `outline` draws a stroke around the glyphs in `backgroundColor`.

Sizes are literal pixels rather than a fraction of the frame. Scaling them off
`video.height` looks tidier until the video is portrait, where a 1080x1920 frame
would take its type size from the 1920 side and render captions that swallow the
page. Side margins do follow the width, and lines are wrapped to whatever fits
across the frame at that size, capped at the ~42 characters subtitling
convention allows.

A `.srt` sidecar is written next to the output video.

### `cursor` and `highlight`

```jsonc
"cursor":    { "enabled": true, "color": "#FFFFFF", "strokeColor": "#000000", "size": 28 },
"highlight": { "enabled": true, "color": "#6C5CE7", "glow": true,
               "borderWidth": 3, "borderRadius": 10 }
```

A drawn cursor glides to each target and pulses on click; a ring marks the
element being acted on. Setting either `enabled: false` removes it from the
page entirely and skips the calls that would drive it.

### `intro` and `outro`

```jsonc
"intro": {
  "enabled": true,
  "durationSec": 3,
  "backgroundColor": "#0F1115",
  "backgroundGradient": ["#0F1115", "#1A1D29"],   // optional, wins over backgroundColor
  "logo": "assets/logo.png",                       // optional
  "title": "Acme",           "titleFont": "heading",
  "subtitle": "Product Walkthrough", "subtitleFont": "body",
  "titleColor": "#FFFFFF",   "subtitleColor": "#A0A6B8"
}
```

Cards are rendered as HTML in the browser and screenshotted, not drawn with
ffmpeg's `drawtext`, which cannot do `@font-face`, gradients or logo layout.
Type scales off `video.height`, so one card design works at any resolution.

### `video`

```jsonc
"video": { "width": 1920, "height": 1080, "fps": 30 }
```

Sets the recording viewport and normalises every segment. Both dimensions must
be even — H.264 requires it. Portrait works: `theme-social.json` is a 1080x1920
example with no cards.

## CLI

| Flag | Default | |
| --- | --- | --- |
| `--flow <path>` | `flow.json` | |
| `--theme <path>` | `theme.json` | |
| `--out <path>` | `out/tutorial.mp4` | |
| `--no-tts` | | timed silence instead of ElevenLabs; free, and the pacing matches |
| `--no-captions` | | skip burning captions |
| `--serve <dir>` | | serve a directory statically and use it as `baseUrl` |
| `--headed` | | watch the browser, for debugging a flow |
| `--keep-temp` | | leave the intermediate files behind |
| `--print-theme` | | resolve and print the theme, then exit |

There are deliberately no per-field style overrides. One theme file per look
(`theme.json`, `theme-social.json`) is easier to reason about. The loaded theme
is a single plain object, so adding `--caption-color` later is a small change.

`ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID` override the defaults. Audio is
cached under `.tts-cache/`, keyed by a hash of the text, voice, model and voice
settings, so re-runs cost nothing unless a line actually changed.

## Two things worth knowing

Both were found by rendering frames and looking at them, and both fail
*silently* if you get them wrong.

**libass matches fonts by the name inside the file.** Not the filename, and not
the string you write in `theme.json`. When they disagree it falls back to a
system face and renders perfectly happily, so the only symptom is a video that
does not look like your brand. `theme.js` reads the font's name table and
refuses to start on a mismatch:

```
theme.json: fonts.body declares family "Intr", but Inter-Regular.ttf calls
itself "Inter". libass matches on the name inside the file, so it would
silently fall back to a system font. Set "family" to "Inter" or drop the field.
```

**The concat demuxer does not reliably refuse mismatched segments.** Given
segments with different codecs it can exit 0 and still write a file whose later
segments will not decode. So compatibility is established by probing each
segment first, and the joined duration is checked afterwards; anything that does
not line up goes through the re-encoding concat filter instead. Matching
segments — the normal case — still stream-copy.

## Tests

```bash
npm test
```

Unit tests cover the ASS colour conversion (`&HAABBGGRR`: alpha first, BGR
order, and alpha inverted), the theme validation and its error messages, and
flow parsing. Integration tests drive real ffmpeg to check that narration lands
at the timestamps the recorder logged, that durations add up, and that
mismatched segments are caught before they are stream-copied.

For anything visual, render frames and look at them:

```bash
ffmpeg -i out/demo.mp4 -vf fps=1 out/frames/f%02d.png
```

That is what caught both of the problems above.

## Layout

```
src/
  index.js      CLI entry and pipeline order
  config.js     flow.json loading and validation
  theme.js      theme.json loading, font resolution, validation
  fontname.js   reads family names and metrics out of a font file
  tts.js        ElevenLabs, caching, --no-tts silence
  recorder.js   Playwright run, step timing, timestamp logging
  overlay.js    the injected cursor/highlight script, built from the theme
  captions.js   cues, .srt, .ass, and the theme-to-ASS style mapping
  titlecard.js  HTML -> screenshot for intro/outro
  ffmpeg.js     narration track, mux, image-to-video, concat, caption burn
  browser.js    finds a usable Chromium
  server.js     static server for --serve
fonts/          bundled .ttf/.otf, see fonts/README.md
assets/         logos and other card artwork
demo/           demo site and flow, used by every test
```
