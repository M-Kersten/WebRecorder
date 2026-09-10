# site-tutorial-video

Turns a `flow.json` into a narrated, branded walkthrough video of a live
website. Playwright drives a real browser through the steps, ElevenLabs reads
the narration, and ffmpeg assembles the result with captions and intro/outro
cards. Everything about how it looks lives in one `theme.json`.

**Not a developer?** Double-click **Start Recorder** (`.command` on macOS,
`.bat` on Windows; on Linux run it from a file manager or `./"Start Recorder.command"`). A window opens: paste a web address, press one
button, and you get a video. Nothing else to install beyond
[Node.js](https://nodejs.org); the first run sets itself up.

For everyone else:

```bash
npm install
npm run demo          # finished video in out/demo.mp4
npm run ui            # the same window, from a terminal
```

That needs no API key and no network: it serves the bundled demo site, uses
timed silence instead of speech, and produces a finished video with an intro
card, a drawn cursor, highlight rings, on-screen hints and fades.

For your own site:

```bash
npx site-tutorial-video init                              # theme.json, flow.json, fonts
npx site-tutorial-video capture --url https://app.example.com
npx site-tutorial-video --no-tts                          # free preview, no API key
npx site-tutorial-video --out out/walkthrough.mp4         # the real thing
```

`capture` opens the site in a browser. Use it the way you would show it to
someone: click through, type into things, and write the narration in the panel
on the right as you go. When you press **Save flow** it writes `flow.json` with
a selector for every step, so nobody has to open devtools and copy one by hand.

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
looks. They are off unless you ask for them.

## Setup

```bash
npm install
export ELEVENLABS_API_KEY=...    # not needed for --no-tts
node src/index.js --flow flow.json --theme theme.json --out out/tutorial.mp4
```

`npm install` brings its own `ffmpeg` and `ffprobe` (via `ffmpeg-static`), built
with **libass** and **libx264**, so neither has to be installed on the machine.
`FFMPEG_PATH` and `FFPROBE_PATH` override them if you would rather use your own;
the stripped-down ffmpeg that ships inside Playwright will not work.

Chromium is fetched on first run. `site-tutorial-video setup` does that and
reports what the machine can do:

```
  video tools   ready (bundled with the project)
  browser       ready
  narration     off (no ELEVENLABS_API_KEY, videos will be silent)
```

`CHROMIUM_EXECUTABLE_PATH` points at an existing Chromium if you already have
one somewhere the tool cannot guess.

## The app window

```bash
site-tutorial-video ui
```

One window, five screens: paste a URL, walk through the site, pick a style,
press **Make the video**, watch it back. It drives the same pipeline the flags
do, so there is nothing it can produce that the CLI cannot.

The **Start Recorder** launchers exist so a colleague never sees a terminal.
They check for Node.js, run `npm install` on the first launch, fetch the
browser, and open the window. If Node is missing they say so and where to get
it. Nothing in that path ever asks somebody to run a command themselves.

What the window handles for you: styles are read from the `theme*.json` files
next to it, one that fails to load is shown greyed out with its reason rather
than silently missing. Narration is switched off and explained when no
ElevenLabs key is set. A missing ffmpeg is flagged before you record rather
than after. Failures are rewritten into something worth reading, so
`Selector "#gone" never became visible` arrives as a suggestion to record the
walkthrough again.

The server binds to `127.0.0.1` and every action needs a token that only the
window it opened was given. Anything on localhost is otherwise reachable from
any page the browser has open, and this one launches browsers and writes files.

## Settings

The app window has a settings screen, grouped into sections:

| | |
| --- | --- |
| Movement | cursor travel time and easing, typing speed, click ripple, highlight fade |
| Pacing | shortest a step can be, pause after each one, hint fade, fade between segments |
| Colours | highlight ring, pointer and its outline, click ripple, hint background and text, the colour behind the page |
| Type | which bundled font the hints and subtitles use, and at what size |
| Opening card | on or off, title, subtitle, their fonts and colours, background, how long it shows |
| Closing card | the same |
| Video | size and frame rate |
| Passwords | one field per `${VAR}` the walkthrough needs |

Font dropdowns offer what the theme declares, by family name. Colours take a
hex, with a swatch beside the field for picking one.

These are written to `settings.json`, a thin layer merged over the theme and the
flow at load time. `theme.json` is meant to be read and edited by hand and is
full of comments explaining itself; rewriting it from a form would throw all of
that away, so nothing does. The CLI reads the same layer:

```bash
site-tutorial-video --settings settings.json
```

```jsonc
{
  "theme": { "cursor": { "moveMs": 700 }, "highlight": { "fadeMs": 300 } },
  "flow":  { "minStepMs": 1800, "typeDelayMs": 30 }
}
```

Some combinations only break later: switching the opening card on without
giving it a title renders nothing and would stop a run minutes in. The new
values are merged onto the theme and checked before anything is written, so the
form says so while you are still looking at it.

Only what the settings list names can be reached from the form. Anything else in
the theme, including every field that takes a file path, stays out of its hands.

Passwords go to `.secrets.json`, written `0600` and gitignored. The window is
told which names are set, never what they are, and a value already in the
environment always wins over a saved one, so a CI secret is never quietly
replaced by something typed into a window months ago.

## Recording a flow

```bash
site-tutorial-video capture --url https://app.example.com
```

The browser opens with a panel down the right-hand side.

- **Every click and everything you type is recorded**, and passed through to the
  page, so the site behaves normally and the flow matches the walk you did.
- **Narration and hints** are typed straight into the panel, per step, whenever
  you like. Both are optional.
- **The dropdown changes what a step does.** Record a click on something you
  only wanted to point at, then switch it to `hover`.
- **Pause** stops recording while you click around to find the next screen.
  **Add page** records the page you are on as a `goto`.
- **Save flow** writes the file and closes the browser.

A password field is never written down. Capture leaves `${PASSWORD}` in its
place, which is read from the environment at record time.

Selectors prefer what somebody put there deliberately: a `data-testid`, then an
id, then an `aria-label` or `name`, then classes that do not look
machine-generated. Only when none of that exists does it fall back to a path by
position, and that path is anchored to the nearest named ancestor and always
states the sibling index. Otherwise clicking a row while a table still says
"loading" gives a selector that is unique for exactly as long as it takes the
real rows to arrive.

Look over what came out before recording:

```bash
site-tutorial-video --check
```

## flow.json

```jsonc
{
  "name": "Dashboard walkthrough",
  "baseUrl": "https://app.example.com",
  "minStepMs": 1400,       // floor per step, so a short line still reads
  "stepPaddingMs": 600,    // beat after the narration ends
  "steps": [
    { "action": "goto",  "url": "/",
      "narration": "This is the dashboard.",
      "hint": "Everything here updates live." },
    { "action": "hover", "selector": ".card",   "narration": "Revenue sits top left." },
    { "action": "type",  "selector": "#search", "text": "hooli",
      "narration": "Start typing to filter.",
      "hint": "Filtering is instant - no submit button." },
    { "action": "click", "selector": "#run",    "narration": "Run rebuilds the numbers." },
    { "action": "scroll","selector": "#cohorts","narration": "Retention is further down." },
    { "action": "wait",  "durationMs": 1500 }
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

Every step may carry two optional pieces of text:

- **`narration`** is spoken, and captioned if captions are on.
- **`hint`** is a small block of text drawn on the page while the step plays,
  anchored to whatever the step is acting on. Use it for the thing that is
  awkward to say out loud - a keyboard shortcut, a caveat, a value to notice.
  A step showing a hint is held on screen long enough to read it, even when
  its narration is shorter than that.

`//` and `/* */` comments are allowed in both `flow.json` and `theme.json`.

Run `site-tutorial-video --check` to validate a flow and see what each step
carries, without recording anything.

### Logging in

Any `${VAR}` in a step's `url` or `text` is replaced from the environment, so a
password never has to be written into `flow.json`. An unset variable stops the
run and names itself; it is never quietly substituted with nothing.

```jsonc
"auth": {
  "stateFile": ".auth/portal.json",   // where the session is kept
  "maxAgeHours": 12,                  // log in again once it is older than this
  "steps": [
    { "action": "goto",  "url": "/login" },
    { "action": "type",  "selector": "#email", "text": "${PORTAL_EMAIL}" },
    { "action": "type",  "selector": "#pw",    "text": "${PORTAL_PASSWORD}" },
    { "action": "click", "selector": "#signin" }
  ]
}
```

These steps run once, in a browser of their own, before recording starts. The
login never appears in the video, and the session they produce is saved and
reused, so later runs skip it. `--relogin` forces a fresh one.

A step whose text came from the environment is treated as a password field from
then on: the console prints dots instead of the value. The state file holds live
session cookies, so it is written `0600` and `.auth/` is in `.gitignore`. Keep it
that way.

### Hiding personal data

A walkthrough of a real, logged-in product is a recording of real data: names,
avatars, customer rows. `mask` says which parts must not reach a frame.

```jsonc
"mask": [
  { "selector": "#greeting", "mode": "text", "text": "Hello, Alex Doe" },
  { "selector": ".avatar",   "mode": "blur", "radius": 14 },
  { "selector": "td.client", "mode": "blur" },
  { "selector": ".invoice-total", "mode": "hide" }
]
```

| Mode | |
| --- | --- |
| `blur` | softens it past reading, `radius` in pixels (default 10) |
| `hide` | makes it invisible while keeping the space it occupied, so nothing reflows |
| `text` | swaps its text for a `text` you choose |

`blur` and `hide` go in as a stylesheet keyed on your own selectors, which is
what makes them stick: a framework re-rendering a table cannot undo a CSS rule
the way it would undo a class or an inline style. Rows that arrive from an API
after the page has loaded are covered from the moment they exist. Text
replacement has no CSS equivalent, so it runs on a MutationObserver and is
reapplied whenever the page writes over it.

The mask is injected before any page script runs, so nothing is captured first
and hidden afterwards.

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

Off by default. Turn them on in the theme, or with `--captions` for one run.

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
"cursor": {
  "enabled": true,
  "color": "#FFFFFF", "strokeColor": "#000000", "size": 28,

  "image": "assets/cursor.png",   // optional: your own pointer
  "hotspot": [0.19, 0.08],        // which point of it lands on the target

  "moveMs": null,                 // null = travel time follows the distance
  "easing": "easeInOut",          // easeInOut | easeOut | linear

  "ripple": true,                 // expanding ring where the click lands
  "rippleColor": null,            // null = use the highlight colour
  "rippleMs": 620
},
"highlight": { "enabled": true, "color": "#6C5CE7", "glow": true,
               "borderWidth": 3, "borderRadius": 10 }
```

The cursor eases to each target rather than jumping, pulses on click, and leaves
a ripple behind it. Its position carries across page loads, so it does not snap
back to the middle of the screen every time the site navigates.

`image` takes a `.png` (with transparency) or `.svg`. It is inlined into the
page, so nothing has to load at record time. `hotspot` is the point that sits on
the target, as a fraction of the image: `[0, 0]` is its top-left corner, `[0.5,
0.5]` its centre. A tip-at-top-left arrow wants roughly `[0.19, 0.08]`.

The ring never travels. It is placed on its target while invisible and faded in
once the cursor has finished moving; showing it first tells the viewer where to
look before the pointer gets there, and the eye goes to the ring instead of
following the movement that is supposed to be carrying the explanation.
`highlight.fadeMs` is how long that fade takes.

`highlight.borderRadius: "auto"` takes the corners from the element being
highlighted and grows them to stay concentric with the ring. On a page built out
of rounded cards of differing radii this is the difference between a highlight
and a slightly wrong rectangle cutting across the corners. A number pins it
instead.

Setting either `enabled: false` removes it from the page entirely and skips the
calls that would drive it.

### `hints`

```jsonc
"hints": {
  "enabled": true,
  "font": "body", "fontSize": 28, "color": "#FFFFFF",
  "backgroundColor": "#1A1D29", "backgroundOpacity": 0.94,
  "accent": "none",           // "bar" for a coloured strip down the left
  "accentColor": "#6C5CE7",   // only used by "bar"
  "borderColor": null,        // null derives a hairline from the text colour
  "borderRadius": 12, "maxWidth": 520, "padding": 20,
  "position": "auto", "offset": 20, "fadeMs": 260
}
```

A hint is a quiet surface: a hairline round the whole block, a soft two-layer
shadow, and nothing else. `accent: "bar"` puts a slab of brand colour down the
left edge if you want it. Leaving `borderColor` unset derives the hairline from
`color`, which contrasts with the surface by definition and so reads correctly
on a dark hint and a light one alike.

An opacity below 1 blurs whatever sits behind the hint. Without that, a hint at
0.95 lets the page's own text read straight through it, which looks like a
rendering fault rather than a translucent card.

`position: "auto"` anchors each hint to the element its step is acting on -
below it, or above when there is no room below, clamped to stay on screen. The
fixed alternatives are `top`/`bottom` crossed with `left`/`center`/`right`, for
a hint that should always sit in the same place.

Hints are drawn in the page, so they use your bundled fonts through an inlined
`@font-face` and appear in the recording like anything else on the page.

### `transitions`

```jsonc
"transitions": { "enabled": true, "fadeSec": 0.4 }
```

Every segment fades in from and out to black, so the video opens cleanly and the
intro, the walkthrough and the outro are separated rather than cutting. The fade
rides along with an encode that was happening anyway, so it costs nothing extra.
A segment too short for the full fade gets a proportionally shorter one instead
of fading to black and straight back.

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
"video": { "width": 1920, "height": 1080, "fps": 30, "backgroundColor": "#0F1115" }
```

Sets the recording viewport and normalises every segment. Both dimensions must
be even — H.264 requires it. Portrait works: `theme-social.json` is a 1080x1920
example with no cards.

`backgroundColor` is painted behind the page before the first navigation, and
used to letterbox a recording that does not fill the frame. Without it the video
opens on a flash of blank white while the browser is still on `about:blank`.

## CLI

```
site-tutorial-video ui                       open the app window
site-tutorial-video setup                    fetch what is missing, then report
site-tutorial-video init                     scaffold theme.json and flow.json here
site-tutorial-video capture --url <url>      record a flow by walking the site
site-tutorial-video [options]
```

| Flag | Default | |
| --- | --- | --- |
| `--flow <path>` | `flow.json` | |
| `--theme <path>` | `theme.json` | |
| `--out <path>` | `out/tutorial.mp4` | |
| `--serve <dir>` | | serve a directory statically and use it as `baseUrl` |
| `--url <url>` | | where `capture` starts |
| `--no-tts` | | timed silence instead of ElevenLabs; free, and the pacing matches |
| `--captions` / `--no-captions` | theme | force captions on or off for one run |
| `--no-hints` | theme | skip the on-screen hint blocks |
| `--no-fades` | theme | skip the fades between segments |
| `--check` | | validate everything, print what each step carries and what is masked, and stop |
| `--relogin` | | log in again even if the saved session is still valid |
| `--headed` | | watch the browser, for debugging a flow |
| `--keep-temp` | | leave the intermediate files behind |
| `--print-theme` | | resolve and print the theme, then exit |
| `-q`, `--quiet` | | only print the result |

The on/off flags override the theme for one run; leaving one out leaves the
theme's own setting alone. There are deliberately no per-field style overrides -
one theme file per look (`theme.json`, `theme-social.json`) is easier to reason
about, and the loaded theme is a single plain object, so adding `--caption-color`
later is a small change.

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
at the timestamps the recorder logged, that durations add up, that a fade
actually darkens the frames it should, and that mismatched segments are caught
before they are stream-copied. A third set drives a real browser to check the
overlay: that a custom pointer is inlined and lands on its hotspot, that the
cursor eases rather than jumps and survives a navigation, that ripples clean
themselves up, and that hints flip above their target when there is no room
below.

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
  overlay.js    the injected cursor/highlight/hint script, built from the theme
  captions.js   cues, .srt, .ass, and the theme-to-ASS style mapping
  titlecard.js  HTML -> screenshot for intro/outro
  ffmpeg.js     narration track, mux, image-to-video, concat, caption burn
  browser.js    finds a usable Chromium
  server.js     static server for --serve
  secrets.js    ${VAR} interpolation, and keeping the value out of the log
  capture.js    the capture session: holds the steps, writes the flow
  capture-panel.js  the panel you fill in while walking the site
  selector.js   picks a selector that will still work next month
  ui.js         the local app: state machine, small HTTP API, window
  preflight.js  checks and fetches what the machine is missing
ui/app.html     the window itself
Start Recorder.command / .bat    double-click launchers
fonts/          bundled .ttf/.otf, see fonts/README.md
theme-rebels.json    a real-world theme: brand colour, Overused Grotesk
assets/         logos and other card artwork
demo/           demo site and flow, used by every test
  portal/       a login plus a dashboard, for the auth and masking examples
```
