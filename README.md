# Qapture

<img src="assets/brand/qapture-mark.svg" alt="" width="72" height="72">

Walk your site once; Qapture performs that walkthrough for as long as the site
lives, and renders it as a narrated, branded video.

Playwright drives a real browser through the steps, ElevenLabs reads the
narration, and ffmpeg assembles the result with captions and intro/outro cards.
Everything about how it looks lives in one `theme.json`.

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
npx qapture init                              # theme.json, flow.json, fonts
npx qapture capture --url https://app.example.com
npx qapture --no-tts                          # free preview, no API key
npx qapture --out out/walkthrough.mp4         # the real thing
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

**The switches on the storyboard are settings.** Narration and subtitles used
to be a choice made afresh every time the window opened, remembered nowhere.
Opening the tool the next day and finding the subtitles off again is how they
came to be missing from a video. Subtitles are `theme.captions.enabled`, which
makes them part of a style: one style can burn them in and another not.
Narration is `flow.narration`, which holds for the project. Flipping a switch
saves it, and the same switch is in the Settings and Styles tabs.

**Narration is generated before the browser starts.** That ordering is the
whole reason the timing works: each line's real duration is known up front, so
the recorder can hold every step on screen for at least as long as it takes to
say. Nothing is estimated after the fact.

**Each step's actual start time is recorded as it happens.** The narration
track is then built by placing every clip at its measured timestamp with
`adelay`, and mixing. Audio is never assumed to run end to end.

A `goto` is stamped once its page is actually there, and "there" is not what
`load` means. On anything built this decade `load` fires at the moment the real
work starts: the shell is up, a fetch is in flight, the content lands a beat
later. So the recorder watches the page instead - it is settled once the DOM has
stopped changing and nothing is still being fetched, for `flow.settleMs`
(600ms by default). A page that was already finished pays exactly that; one
still assembling itself pays until it stops. A request that has been open for
seconds without changing anything stops counting, because a long poll is not
evidence that the picture is about to move.

None of that assembling reaches the video. A page being fetched, parsed and
hydrated is not something anybody wants in a walkthrough, and the browser will
not hold the previous frame across a navigation, so a curtain in the theme's
background colour goes up inside the new document before it has painted and
comes down once the page has settled. A click that navigates is a page load
like any other: it gets the same curtain, and restarts that step's clock. Every
other action is visible as it happens, so it still counts from the start.

And the seconds the curtain covers are then cut off the front, leaving one short
beat for the fade from the intro card to land on. On a real site that is around
three seconds of flat colour nobody would sit through.

Finding *where* to cut is the interesting part. Playwright does not say when it
began capturing, and working it out from the video's duration minus the time the
recorder measured carries about four hundred milliseconds of slop - which lands
on every line of narration, since the timeline has to shift by exactly as much
as the trim. So the video is asked instead: under the curtain the frame is a
solid known colour, and the frame where the page shows through is the moment
both clocks agree on.

That measurement also fixed something that had always been wrong. Narration was
placed at clock seconds into a file whose zero is not the clock's zero, and
measured on a finished render - when the picture changes against when the sound
starts - the drift was **0.96 seconds**. Nothing in the output said so, because
the captions were built from the same timeline and were wrong by exactly the
same amount, so they agreed with the voice and both disagreed with the page.
`test/sync.test.js` measures the two independently on a delivered file and fails
above 0.25s.

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

Chromium is fetched on first run. `qapture setup` does that and
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
qapture ui
```

One window, three tabs. **Storyboard** is where the work happens, **Styles** is
where a video's look is set, and **Settings** holds the voice, the timing and
the passwords. It drives the same pipeline the flags do, so there is nothing it
can produce that the CLI cannot.

The storyboard is a filmstrip of the walkthrough. Every step recorded during
capture kept a screenshot of the page as it stood, so the board shows what each
step is looking at rather than a CSS selector, and somebody who did not do the
recording can still read it. Picking a frame opens that step: its narration and
its hint, both saved to `flow.json` as you type.

Beside each step is how long it will be on screen, and what decides that:

```
ON SCREEN            WHAT SETS IT
5.2 s                What is said        5.2 s
                     Reading the hint    3.5 s
                     Shortest allowed    1.4 s
```

Those numbers come from `pacing.js`, which is the same rule `recorder.js`
follows while recording, so the board and the finished file agree. They are
floors: a page that takes four seconds to load makes its step four seconds
longer, and nothing before a render can know that. The bar across the top pane
is the same information laid end to end, one segment per step, as wide as the
step is long and amber where nothing is said yet.

A `flow.json` already on disk is picked up when the window opens, so a
walkthrough recorded yesterday is on screen rather than behind a form asking
for a web address you already gave once.

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

The window has no native dialogs in it, and cannot have any. It opens under
Playwright, which dismisses every dialog when nothing has registered a handler,
so an `alert`, `confirm` or `prompt` never reaches the person and always answers
"no". Anything that needs an answer asks for it in the page. `test/window.test.js`
drives the window in a real browser and fails if a dialog is raised at all.

The server binds to `127.0.0.1` and every action needs a token that only the
window it opened was given. Anything on localhost is otherwise reachable from
any page the browser has open, and this one launches browsers and writes files.

## Styles and settings

Two pages, split by what a thing actually changes.

| Styles | per style file |
| --- | --- |
| Cursor and ring | travel time, easing, click ripple, how fast the ring appears |
| Fades | hint fade, fade between segments |
| Colours | the ring, the pointer and its outline, the ripple, the hint, the colour behind the page |
| Type | hints and subtitles on or off, which bundled font they use, and at what size |
| Opening card | on or off, title, subtitle, their fonts and colours, background, a sound, how long it shows |
| Closing card | the same |
| Music | a track, how loud, how long it fades |
| Frame | size and frame rate |

| Settings | the whole project |
| --- | --- |
| Narration | read out loud or not, the ElevenLabs key, the model, the voice, its expression, speed and language |
| Pacing | shortest a step can be, pause after each one, typing speed, wait after a page loads |
| Passwords | one field per `${VAR}` the walkthrough needs |

The split is not a filing decision, it is the shape of the data: a `theme.` key
is part of a style and there can be several of those, a `flow.` key belongs to
this project whichever style it is rendered in. `settings.js` derives each
field's tab from its key rather than tagging them, so the two can never
disagree.

Frame size sits with the styles rather than with the project because it is part
of what a style is. The shipped `theme-social.json` is 1080x1920; a global size
would quietly flatten it back to landscape.

Colours take a hex, with a swatch beside the field for picking one.

### Sound

Three places a video can make a noise beyond the narration, all set per style:

- **Opening card** and **Closing card** each take a clip, played over that card.
- **Music** plays under everything, cards included.

Clips come from an `audio` folder beside the project, the same way fonts come
from `fonts`. A folder rather than a path typed into a form: the settings screen
is a form, and a form has no business pointing the renderer at an arbitrary file
on the machine. Drop an `.mp3`, `.m4a`, `.wav`, `.ogg`, `.opus`, `.aac` or
`.flac` in and it turns up in the dropdowns, with a play button beside it,
because hearing a clip is the only way to know it is the right one.

A card's length is what the pacing was worked out against, so it does not move
to fit its clip: a longer clip is cut off at the end, with a short fade so it
does not stop dead, and a shorter one leaves silence.

The music goes on last, after the cards are attached, so it plays under those
too. It is looped to reach the end and faded at both ends, and the pass copies
the video stream rather than re-encoding it, so a bed costs an audio encode and
not a second trip over every frame. It is not ducked under the narration, it is
simply quiet; `music.volume` is against a narration of 1, and the mix does not
normalise, so the voice comes out exactly where it went in.

Nothing ships in `audio/`. Music and stings are licensed per use, and guessing
on somebody's behalf is not a favour.

### How the narration is read

```jsonc
"flow": {
  "voiceModel": "eleven_v3",   // v3, multilingual v2, turbo or flash
  "voiceId": "nl_sanne",       // from voices.json
  "voiceLanguage": "nl",       // ISO 639-1; see the table below
  "voiceStyle": 0.26,          // 0 to 1
  "voiceSpeed": 0.9            // 0.7 to 1.2
}
```

`voiceStyle` and `voiceSpeed` ride in the request's `voice_settings`;
`voiceLanguage` is a top-level `language_code`, which pins how numbers and dates
are read.

**Not every model listens to every setting, and the API will not tell you.** It
accepts all of them for all of them and silently drops the ones that model does
not implement, so a slider that does nothing looks exactly like one that works:

| | stability | style | speed | similarity | speaker boost | language code |
| --- | --- | --- | --- | --- | --- | --- |
| Multilingual v2 | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| v3 | ✓ | ✓ | — | — | — | ✓ |
| Turbo v2.5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Flash v2.5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

A setting the chosen model ignores is dropped before the request rather than
sent into a void, a run says out loud which of yours are being ignored, and the
window greys the control with the reason. Dropping matters beyond tidiness:
everything sent is part of the cache key, so moving the speed slider on v3 used
to buy a fresh clip identical to the one already on disk.

The ranges are the ones ElevenLabs accepts, and they are checked before a
request goes out: a 422 three minutes into a render is a bad way to learn that
speed tops out at 1.2. Everything the model does use is part of the cache key,
so changing the speed on a model that has one regenerates the lines rather than
handing back clips read at the old one.

**Every line is handed over as a finished sentence.** ElevenLabs reads prosody
off the punctuation, and a line with no full stop is an unfinished clause: the
voice ends it suspended, as though drawing breath for whatever comes next. A
trailing comma, colon or dash says the same thing in writing. Nobody types a
full stop into a one-line box, so `polishLine` adds one, and replaces a hanging
comma with one.

**And it is told what came before it.** `previous_text` carries the previous
line, so each one is read as part of a walkthrough rather than as an island; a
four-word line on its own gives the model almost nothing to shape a sentence
around. `next_text` exists too and is deliberately not used: it is for chunks
that get butted together, and these are not. They land seconds apart at measured
timestamps, so telling the model something follows immediately is what makes it
lean forward into a sentence the listener will not reach for another three
seconds.

### Fonts

Every `.ttf` and `.otf` in the project's `fonts` folder is offered to every
style, so adding a face is dropping a file in rather than hand-editing JSON. The
folder is the catalogue; a style only declares a font to add one from somewhere
else, or to give one a key of its own, and a key it declares wins.

Keys are the family and the weight: `inter`, `inter-bold`, `space-grotesk`,
`plus-jakarta-sans-bold`, `fraunces`, `jetbrains-mono`. Family names are **read
out of the files**, never guessed from their names. libass matches on the name
inside the file, and a guess that is close but wrong is exactly the failure that
renders a system font instead. The weight comes from the file name, which is the
only place a static instance says which of its family it is.

Fourteen families ship with the project, Regular and Bold of each: Archivo,
Bricolage Grotesque, DM Sans, Figtree, Fraunces, Inter, JetBrains Mono, Manrope,
Outfit, Overused Grotesk, Plus Jakarta Sans, Poppins, Sora and Space Grotesk.

Two weights of one family in one folder is the reason `weight` matters on a
declaration. libass gets a folder and a family name, and picks between Regular
and Bold on the bold flag alone; `captions.js` sets that flag from the weight,
so a caption set in `fraunces-bold` renders in the bold file rather than
silently in the regular one.

The dropdown draws every option in its own face, which a native `<select>`
cannot promise across platforms, so it is a listbox of its own. The faces are
served from the project's `fonts` folder through the window's own `/api/font`
route, falling back to the ones bundled with the tool.

### Why a style is its own layer

The storyboard picks a style and the Styles tab edits one. Both read the same
place:

```jsonc
{
  "style": "theme-rebels.json",        // what the next video is made in
  "flow":  { "minStepMs": 1800 },      // the whole project
  "styles": {                          // one layer per style file
    "theme.json":        { "highlight": { "color": "#00FF00" } },
    "theme-rebels.json": { "intro": { "title": "Q Portal" } }
  }
}
```

Keeping them apart is the point. There used to be one pile of visual settings,
merged over whichever style you chose, and since that pile was captured from the
default style it won every time: picking a different style changed almost
nothing, which read as the styles not applying at all. Now editing one style
leaves the rest exactly as their files wrote them.

A settings file from before the split holds a single top-level `theme` key. It
is read as the default style's layer and rewritten into the new shape the next
time anything is saved.

**New style** copies the file the tab is currently showing, edits included, so a
new style starts where its parent left off and arrives with the comments that
explain it intact. Editing a style and rendering in one are separate choices:
you can tidy up the social style without the next video suddenly coming out
portrait.

These are written to `settings.json`, a thin layer merged over the style and the
flow at load time. `theme.json` is meant to be read and edited by hand and is
full of comments explaining itself; rewriting it from a form would throw all of
that away, so nothing does. The CLI reads the same layer, for the style it was
given:

```bash
qapture --theme theme-rebels.json --settings settings.json
```

Some combinations only break later: switching the opening card on without
giving it a title renders nothing and would stop a run minutes in. The new
values are merged onto the style and checked before anything is written, so the
form says so while you are still looking at it.

Only what the settings list names can be reached from the form. Anything else in
a style, including every field that takes a file path, stays out of its hands.

Passwords go to `.secrets.json`, written `0600` and gitignored. The window is
told which names are set, never what they are, and a value already in the
environment always wins over a saved one, so a CI secret is never quietly
replaced by something typed into a window months ago.

The **ElevenLabs key** lives in the same store, under **Narration**, and is
offered whether or not a flow asks for anything. No flow ever does, and somebody
who wants a spoken video needs somewhere to put one that is not a shell profile.
Saving it asks ElevenLabs whether the key works before keeping it: a key that
comes back rejected is refused with the reason, rather than discovered three
minutes into a render once the browser has already walked the whole site. A
network that cannot be reached is not the key's fault, so that saves the key and
says the check did not happen. Once a key is set the narration switch on the
storyboard unlocks, without reopening the window.

`ELEVENLABS_API_KEY` in the environment still works and still wins. Only the
window counts a saved key; `qapture setup` reports on the
environment, because the CLI has no window to have typed one into.

### Voices

`voices.json`, beside the project, is a list you write yourself:

```jsonc
[
  { "id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel (English, calm)" },
  { "id": "...", "name": "Sanne (Dutch, warm)" }
]
```

The name is yours to choose and is what the dropdown shows, so write whatever
tells one ID apart from the next. IDs come from elevenlabs.io: open Voices, pick
one, copy its ID. Your own cloned voices work the same way.

Deliberately a file rather than a live call. ElevenLabs can list every voice on
an account with a preview of each, which is a better way to go shopping, and it
needs a working key before the dropdown holds anything and puts the network
between somebody and an open window. A list of IDs already decided on opens
instantly and works offline. A missing or empty `voices.json` falls back to the
stock voice, so the dropdown is never empty.

The choice is written to `settings.json` as `flow.voiceId` and merged over the
flow, which is what `--settings` already does for everything else. Changing
voice regenerates every line at ElevenLabs' usual cost: the narration cache is
keyed on the voice, so switching back to one you used before costs nothing.

## Recording a flow

```bash
qapture capture --url https://app.example.com
```

The browser opens with a panel down the right-hand side, wearing the same
light cards and pink action as the window, so the two read as one tool. It sits
in a shadow root; the typeface is the one exception, left to the system stack
rather than inlining 360KB of base64 font into every frame of somebody else's
site for the sake of 13px chrome.

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
qapture --check
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
    { "action": "waitFor","selector": "#report", "narration": "The report arrives." },
    { "action": "click", "selector": "#pay", "frame": "#checkout",
      "narration": "Paying happens in the widget." },
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
| `waitFor` | `selector` | `state`: `visible` (default), `hidden`, `attached`, `detached` |

Every step also accepts `timeoutMs`, which overrides the flow's own
`timeoutMs` for that one step, and `frame`, described below.

### Waiting for the page

`waitFor` holds until the page says it is ready, rather than for a number
somebody guessed once on a fast connection. A saved report, a table that loads
after the shell, a spinner that has to go away: put a `waitFor` in front of the
step that depends on it and the walkthrough stops depending on how fast the
machine is that day.

Anything that acts on an element - `click`, `hover`, `type`, `scroll` - already
waits for it on its own, up to `timeoutMs`. `waitFor` is for the case where what
you are waiting for is not what the next step touches.

Acting steps target the first **visible** match rather than the first match. A
mobile menu and a desktop menu carry the same markup, and the hidden one usually
comes first in the document.

### Frames

A CSS selector only searches the document it runs against. Shadow DOM is not a
problem - Playwright's engine pierces open shadow roots - but an iframe is a
separate document, and checkout widgets, chat bubbles and embedded dashboards
all live in one.

```jsonc
{ "action": "click", "selector": "#pay", "frame": "#checkout" }
{ "action": "type",  "selector": "#card", "text": "4242", "frame": "name:payment" }
{ "action": "click", "selector": "#ok",   "frame": ["#outer", "url:stripe.com/v3"] }
```

`frame` is a CSS selector for the `<iframe>` element, or `name:` / `url:`, which
are shorthand for matching its `name` or `src`. An array descends through nested
frames. Capture mode fills this in for you: click inside an embed while
recording and the step comes out with the frame already on it.

### A page the server refused

A `goto` checks what came back, not just that something did. Playwright resolves
happily on a 403 or a 404 - the navigation worked, the server simply answered
with an error page - and everything after it then runs against that page and
reports itself fine. A rehearsal comes back green; a render produces four
minutes of "Access denied". Any status of 400 or above now stops the step. For a
flow that means to visit one, say so:

```jsonc
{ "action": "goto", "url": "/admin", "allowHttpError": true }
```

### How stable a selector is

Capture mode prefers what a developer put there on purpose - a test id, an id,
an aria-label - and refuses names a bundler made up. That refusal is a
heuristic, and against real sites it is a heuristic with limits: `jtyPqk` and
`sc-d4709398` are caught, `iObqyc` and `as-1r` are not, and nothing in those
strings says which of them somebody typed.

So rather than claim a confidence it does not have, the rehearsal reports what
each step is resting on: a **name** somebody chose, a **class** that may or may
not survive the next deploy, or a **position** that certainly will not. The
storyboard's check card shows the same thing. A step whose selector counts
children is the one to go back and give a `data-testid`.

There is a fourth: **dated**. A selector with a date in it -
`input[aria-label="Holiday, 2026-09-05"]` - is the sturdiest-looking kind there
is and the one that expires, because an aria-label generated from a row's date
is not a name, it is this week's name. It works right up until the week rolls
over, and it is reported whether or not the step passes.

### Cookie banners

Consent dialogs are dismissed before the clock starts, so the banner never
reaches the video and never pushes the narration out of step. The built-in list
covers the platforms that put a stable handle on their accept button - OneTrust,
Cookiebot, Quantcast, TrustArc, Usercentrics, Didomi, Osano, Iubenda, Klaro,
cookieconsent and a couple of WordPress plugins.

```jsonc
"dismiss": false                                   // leave banners alone
"dismiss": ["#my-own-wall button.accept"]          // built-ins, then yours
"dismiss": { "builtins": false, "selectors": ["#agree"], "frames": ["#cmp"] }
```

### Recording at a different size

`viewport` is the window the site is shown in, which is not the frame the video
is delivered in. Recording a responsive site at phone width and delivering 1080p
letterboxes the phone layout onto the theme's background, which is a different
thing from cropping the desktop one.

```jsonc
"viewport": "phone"                                     // or desktop, laptop, tablet
"viewport": { "width": 1280, "height": 720, "deviceScaleFactor": 2 }
```

Every step may carry two optional pieces of text:

- **`narration`** is spoken, and captioned if captions are on.
- **`hint`** is a small block of text drawn on the page while the step plays,
  anchored to whatever the step is acting on. Use it for the thing that is
  awkward to say out loud - a keyboard shortcut, a caveat, a value to notice.
  A step showing a hint is held on screen long enough to read it, even when
  its narration is shorter than that.

`//` and `/* */` comments are allowed in both `flow.json` and `theme.json`.

Run `qapture --check` to validate a flow and see what each step
carries, without recording anything.

Run `qapture --rehearse` to walk it through a real browser without
recording. It reports which step broke and why: whether the selector matches
nothing, matches something a panel has not opened yet, or matches something that
only exists in the site's phone layout - it narrows the window and looks, rather
than guessing, because those last two are both `display: none` and want opposite
fixes. It also says how long each step really took, which selectors are
ambiguous, and which rest on a position rather than a name and will therefore
break when the page changes. It stops at the first failure: everything after a step
that did not happen is in an unknown state, and guessing about it would be worse
than saying so. The app window has the same thing as **Check the steps**.

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

  "shape": "arrow",               // arrow | touch, when there is no image
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

With no `image`, `shape` decides what gets drawn. `arrow` is the pointer this
has always drawn. `touch` is the disc a finger leaves, for a walkthrough
recorded at a phone size: give it a bigger `size` and a `hotspot` of `[0.5,
0.5]`, because a disc points from its middle. Both are drawn rather than
loaded, so there is no asset to go missing mid-navigation.

The Styles tab has these as presets, under Cursor and ring. A preset fills in
the boxes below it rather than replacing them, so it is a starting position you
can then change, and the pointer picture is picked the same way a card logo is.

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

### Pictures

Anything in an `assets` folder beside the project, one level of subfolders
included, turns up in the picture pickers on the Styles tab, which are the card
logos and the pointer. A folder rather than a path typed into a form, for the
same reason the fonts and the audio work that way: the settings screen is a
form, and a form has no business pointing the renderer at an arbitrary file on
the machine.

Every picker has an upload button beside it, so a logo, a sting or a music track
can go in without leaving the window. The bytes are written into the folder that
kind is read from, under a name rebuilt rather than trusted: basename only, a
known extension, and anything else replaced. An upload never overwrites what is
already there - a second `logo.png` lands as `logo-2.png` - because a picker
pointing at a file whose contents changed under it is a confusing way to lose
work. Pictures are capped at 8 MB and clips at 48 MB.

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

The Opening card and Closing card panes each show the card as it would be
rendered, redrawn a moment after you stop typing. It is the same builder the
renderer uses, served into an iframe, so what is on screen there is what lands
in the video rather than an impression of it. A card that is switched off is
previewed anyway, because that is exactly when somebody is deciding. And a
half-typed colour is left out for the moment rather than taking the preview
down.

### `video`

```jsonc
"video": {
  "width": 1920, "height": 1080, "fps": 30,
  "backgroundColor": "#0F1115",
  "curtain": true, "curtainFadeMs": 260,
  "master": false
}
```

Sets the recording viewport and normalises every segment. Both dimensions must
be even — H.264 requires it. Portrait works: `theme-social.json` is a 1080x1920
example with no cards.

`backgroundColor` is the stage. It is what Chromium paints where no document has
painted yet, what the curtain is made of, and what letterboxes a recording that
does not fill the frame.

`curtain` holds that colour over a page while it loads and fades it away once
the page has settled, so the video never shows a site assembling itself. Turn it
off only if watching the load is the point. `curtainFadeMs` is how long the fade
takes; 0 cuts straight.

`master` writes a second file beside the delivered one with no chroma
subsampling, to edit from.

`fps` is a ceiling, not a promise. Playwright records at 25; asking for more
produces a file that repeats frames and claims to be smoother than it is, so the
source rate is measured and the theme capped to it.

## CLI

```
qapture ui                       open the app window
qapture setup                    fetch what is missing, then report
qapture init                     scaffold theme.json and flow.json here
qapture capture --url <url>      record a flow by walking the site
qapture [options]
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
| `--rehearse` | | walk the flow through a real browser without recording, and report what no longer works |
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

## Three things worth knowing

All three were found by rendering and measuring rather than reasoning, and all
three fail *silently* if you get them wrong.

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

**Tagging a video BT.709 without converting it makes the picture worse.**
ffmpeg turns RGB into YUV with BT.601 coefficients unless it is told otherwise,
while every player assumes BT.709 for HD. An untagged file is therefore wrong in
a way most players quietly correct for; a file tagged 709 but encoded 601 is
wrong in a way nothing corrects. Measured against a lossless reference: no tags
scores 0.9979 SSIM, a bare `-colorspace bt709` scores **0.9842**, and converting
with `scale=out_color_matrix=bt709` before tagging scores 0.9953. The delivery
and master profiles convert, then tag.

Two related measurements, in case they save somebody the same afternoon: 4:4:4
intermediates buy nothing at all if the delivery is 4:2:0 (both chains score
0.9840), and `crf` is not the lever it looks like - 20 and 12 score 0.9977 and
0.9983 on the same source. Chroma subsampling is where the loss is, which is why
the pipeline stays 4:4:4 internally and subsamples exactly once, at the end.

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

A fourth set drives the app window itself, because it runs under Playwright
like everything else here and that is exactly what makes a native dialog in it
useless. A fifth checks the parts that make this work on a site it has not seen:
that a click lands inside an iframe and still reports where it acted in page
coordinates, that a wait holds until the page is ready and gives up saying what
it was waiting for, that a cookie wall is dismissed while a page without one is
not held up, and that a rehearsal tells a renamed selector apart from one whose
element was simply not ready yet.

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

That is what caught all three of the problems above.

## Layout

```
src/
  index.js      CLI entry and pipeline order
  config.js     flow.json loading and validation
  target.js     turns a step into a locator: frames, and the wait budget
  consent.js    cookie walls, taken down before the clock starts
  rehearse.js   walks a flow without recording, and reports what broke
  theme.js      theme.json loading, font resolution, validation
  fontname.js   reads family names and metrics out of a font file
  tts.js        ElevenLabs, caching, --no-tts silence
  recorder.js   Playwright run, step timing, timestamp logging
  overlay.js    the injected cursor/highlight/hint script, built from the theme
  captions.js   cues, .srt, .ass, and the theme-to-ASS style mapping
  titlecard.js  HTML -> screenshot for intro/outro
  ffmpeg.js     narration track, mux, image-to-video, music bed, concat, caption burn
  browser.js    finds a usable Chromium
  server.js     static server for --serve
  secrets.js    ${VAR} interpolation, and keeping the value out of the log
  capture.js    the capture session: holds the steps, writes the flow
  capture-panel.js  the panel you fill in while walking the site
  selector.js   picks a selector that will still work next month
  ui.js         the local app: state machine, small HTTP API, window
  pacing.js     how long a step is on screen; read by the recorder and the board
  voices.js     the voices.json list, and the stock voice to fall back on
  sounds.js     the audio folder: stings and music, by name
  images.js     the assets folder: logos and pointers, by name
  uploads.js    writing a file into one of those folders from the window
  fontcatalog.js  reads a fonts folder into theme-shaped declarations
  shots.js      the per-step screenshots the storyboard is built from
  settings.js   the fields the Style tab shows, and where they are saved
  workdir.js    temp folders, and cleaning them up on Windows
  preflight.js  checks and fetches what the machine is missing
ui/app.html     the window itself: storyboard and style, in one page
Start Recorder.command / .bat    double-click launchers
fonts/          bundled .ttf/.otf, see fonts/README.md
audio/          stings and music for the cards and the bed, see audio/README.md
theme-rebels.json    a real-world theme: brand colour, Overused Grotesk
voices.json     the ElevenLabs voices this project can narrate in
assets/         logos, pointers and other card artwork
demo/           demo site and flow, used by every test
  portal/       a login plus a dashboard, for the auth and masking examples
```
