#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadFlow, ConfigError } = require('./config');
const { loadTheme, describeTheme, deepMerge } = require('./theme');
const { synthesizeAll } = require('./tts');
const { record, describeStep, authenticate, sessionIsFresh, sessionPath } = require('./recorder');
const { resolveFlowSecrets } = require('./secrets');
const captions = require('./captions');
const { renderCard } = require('./titlecard');
const ff = require('./ffmpeg');
const { serveStatic } = require('./server');
const { createWorkDir, removeWorkDir } = require('./workdir');
const { loadSettings, applySecrets, SETTINGS_FILE } = require('./settings');
const { capture } = require('./capture');

const USAGE = `
site-tutorial-video - turn a flow.json into a narrated, themed tutorial video

  site-tutorial-video [options]
  site-tutorial-video init                    scaffold theme.json and flow.json here
  site-tutorial-video ui                      open the app window (no terminal)
  site-tutorial-video setup                   fetch what is missing, then report
  site-tutorial-video capture --url <url>     record a flow by walking the site

Options
  --flow <path>       Flow file describing the steps      (default: flow.json)
  --theme <path>      Theme file                          (default: theme.json)
  --out <path>        Output video                        (default: out/tutorial.mp4)
  --serve <dir>       Serve <dir> statically and use it as the flow's baseUrl
  --url <url>         Where "capture" starts (capture only)
  --settings <path>   Values set from the app window  (default: settings.json)

  --no-tts            Timed silence instead of ElevenLabs. Free, and the
                      pacing comes out the same, so use it while iterating.
  --captions          Burn captions in (they are off unless asked for)
  --no-captions       Force captions off even if the theme enables them
  --no-hints          Skip the on-screen hint blocks
  --no-fades          Skip the fades between segments

  --relogin           Log in again even if a saved session is still valid
  --headed            Watch the browser, for debugging a flow
  --keep-temp         Leave the intermediate files behind
  --print-theme       Resolve and print the theme, then exit
  --check             Validate the flow and theme without recording
  -q, --quiet         Only print the result
  -h, --help          This text

Any \${VAR} in a step's url or text is replaced from the environment, so a
password never has to be written into flow.json.

Environment
  ELEVENLABS_API_KEY    required unless --no-tts
  ELEVENLABS_VOICE_ID   optional, defaults to a stock voice
  ELEVENLABS_MODEL_ID   optional
  CHROMIUM_EXECUTABLE_PATH  optional, if Chromium is somewhere unusual

Examples
  site-tutorial-video ui
  site-tutorial-video init
  site-tutorial-video capture --url https://app.example.com
  site-tutorial-video --no-tts                     # fast, free preview
  site-tutorial-video --captions --out out/v1.mp4  # the real thing
`;

function parseArgs(argv) {
  const args = {
    command: null,
    flow: 'flow.json',
    theme: 'theme.json',
    out: path.join('out', 'tutorial.mp4'),
    tts: true,
    // null means "whatever the theme says"; the flags below force it either way.
    captions: null,
    hints: null,
    fades: null,
    serve: null,
    url: null,
    settings: SETTINGS_FILE,
    headed: false,
    relogin: false,
    keepTemp: false,
    printTheme: false,
    check: false,
    quiet: false,
    help: false,
  };
  const takesValue = {
    '--flow': 'flow', '--theme': 'theme', '--out': 'out', '--serve': 'serve', '--url': 'url',
    '--settings': 'settings',
  };
  const COMMANDS = ['init', 'capture', 'ui', 'setup'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && COMMANDS.includes(arg)) { args.command = arg; continue; }
    if (takesValue[arg]) {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`${arg} needs a value`);
      args[takesValue[arg]] = value;
      continue;
    }
    switch (arg) {
      case '--no-tts': args.tts = false; break;
      case '--captions': args.captions = true; break;
      case '--no-captions': args.captions = false; break;
      case '--hints': args.hints = true; break;
      case '--no-hints': args.hints = false; break;
      case '--fades': args.fades = true; break;
      case '--no-fades': args.fades = false; break;
      case '--relogin': args.relogin = true; break;
      case '--headed': args.headed = true; break;
      case '--keep-temp': args.keepTemp = true; break;
      case '--print-theme': args.printTheme = true; break;
      case '--check': args.check = true; break;
      case '-q': case '--quiet': args.quiet = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        throw new ConfigError(
          `Unknown option "${arg}". Run with --help to see what is available.`
        );
    }
  }
  return args;
}

/**
 * Where the run's progress goes. The terminal by default; the app window
 * redirects it so the same pipeline can report into a UI without every call
 * site having to know about it.
 */
const toStdout = (msg) => process.stdout.write(`${msg}\n`);
let sink = toStdout;
const write = (msg = '') => sink(msg);

function setOutput(fn) { sink = fn || toStdout; }

/** Timing wrapper, so the console shows where a slow run actually went. */
function stepLogger(quiet) {
  let startedAt = null;
  let label = null;
  const done = () => {
    if (!label) return;
    if (!quiet) write(`  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    label = null;
  };
  return {
    step(text) {
      done();
      label = text;
      startedAt = Date.now();
      if (!quiet) write(text);
    },
    detail(text) { if (!quiet) write(`    ${text}`); },
    finish: done,
    plain: (text) => { if (!quiet) write(text); },
  };
}

/** CLI flags win over the theme; an unset flag leaves the theme alone. */
function applyOverrides(theme, args) {
  if (args.captions !== null) theme.captions.enabled = args.captions;
  if (args.hints !== null) theme.hints.enabled = args.hints;
  if (args.fades !== null) theme.transitions.enabled = args.fades;
  return theme;
}

const SAMPLE_FLOW = {
  name: 'My walkthrough',
  baseUrl: 'http://localhost:3000',
  minStepMs: 1400,
  stepPaddingMs: 600,
  steps: [
    {
      action: 'goto',
      url: '/',
      narration: 'This is the home page.',
      hint: 'Everything starts here.',
    },
    {
      action: 'click',
      selector: 'button',
      narration: 'Clicking through to the next screen.',
    },
  ],
};

/**
 * Scaffold a project so a first run is edit-two-files rather than
 * read-the-docs.
 *
 * The fonts and the pointer image come along with the theme. Writing a
 * theme.json that references files the new directory does not have would make
 * the very first command a new user runs fail on a missing font.
 */
function initProject(cwd) {
  const pkgRoot = path.join(__dirname, '..');
  const created = [];
  const skipped = [];

  const copyIfNew = (from, to, label) => {
    if (fs.existsSync(to)) { skipped.push(label); return; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    created.push(label);
  };

  copyIfNew(path.join(pkgRoot, 'theme.example.json'), path.join(cwd, 'theme.json'), 'theme.json');

  const flowTarget = path.join(cwd, 'flow.json');
  if (fs.existsSync(flowTarget)) {
    skipped.push('flow.json');
  } else {
    fs.writeFileSync(flowTarget, `${JSON.stringify(SAMPLE_FLOW, null, 2)}\n`, 'utf8');
    created.push('flow.json');
  }

  // Everything theme.example.json points at, so the scaffold validates as-is.
  const fontsDir = path.join(pkgRoot, 'fonts');
  if (fs.existsSync(fontsDir)) {
    for (const name of fs.readdirSync(fontsDir).filter((f) => /\.(ttf|otf)$/i.test(f))) {
      copyIfNew(path.join(fontsDir, name), path.join(cwd, 'fonts', name), `fonts/${name}`);
    }
  }
  const cursorSource = path.join(pkgRoot, 'assets', 'cursor.png');
  if (fs.existsSync(cursorSource)) {
    copyIfNew(cursorSource, path.join(cwd, 'assets', 'cursor.png'), 'assets/cursor.png');
  }

  write('');
  if (created.length) write(`created  ${created.join('\n         ')}`);
  if (skipped.length) write(`kept     ${skipped.join(', ')}  (already there)`);
  write('');
  write('Next:');
  write('  1. point flow.json at your site and describe the steps');
  write('  2. edit theme.json - fonts, colours, intro/outro text');
  write('  3. site-tutorial-video --no-tts     free preview, no API key needed');
  write('');
  write('  site-tutorial-video --check         validate without recording');
  write('  site-tutorial-video --help          every option');
  write('');
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { write(USAGE); return 0; }
  if (args.command === 'init') return initProject(process.cwd());
  if (args.command === 'capture') return captureFlow(args);
  if (args.command === 'ui') return runUi();
  if (args.command === 'setup') return runSetup();

  // Values set from the app window sit in their own file and are merged over
  // the theme and the flow here, so theme.json is never rewritten from a form.
  const settings = loadSettings(args.settings);

  const theme = applyOverrides(deepMerge(loadTheme(args.theme), settings.theme), args);
  if (args.printTheme) { write(describeTheme(theme)); return 0; }

  const flow = Object.assign(loadFlow(args.flow), settings.flow);
  // Passwords saved from the window, for anything the environment has not set.
  applySecrets(path.dirname(path.resolve(args.settings)));
  const secretsUsed = resolveFlowSecrets(flow);
  if (args.check) {
    write(describeTheme(theme));
    write('');
    write(`flow: ${flow.path}`);
    flow.steps.forEach((step, i) => {
      const marks = [
        step.narration ? 'narration' : null,
        step.hint ? 'hint' : null,
      ].filter(Boolean);
      write(`  ${String(i + 1).padStart(2)}. ${describeStep(step)}${marks.length ? `  [${marks.join(', ')}]` : ''}`);
    });
    if (flow.mask.length) {
      write('');
      write('masked before recording:');
      for (const rule of flow.mask) {
        write(`  ${rule.mode.padEnd(5)} ${rule.selector}` +
          (rule.mode === 'text' ? `  -> "${rule.text}"` : ''));
      }
    }
    if (flow.auth) {
      write('');
      write(`auth: ${flow.auth.steps.length} login steps, session in ${flow.auth.stateFile}` +
        `${sessionIsFresh(flow) ? ' (saved session still valid)' : ' (will log in)'}`);
    }
    if (secretsUsed.length) {
      write('');
      write(`from the environment: ${secretsUsed.join(', ')}`);
    }
    write('');
    write('flow and theme are valid.');
    return 0;
  }

  await ff.checkToolchain();
  if (args.serve && !fs.existsSync(args.serve)) {
    throw new ConfigError(`--serve points at "${args.serve}", which is not a directory that exists`);
  }

  const outFile = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const workDir = createWorkDir();
  const ui = stepLogger(args.quiet);
  const startedAt = Date.now();

  let server = null;
  try {
    if (args.serve) {
      server = await serveStatic(args.serve);
      flow.baseUrl = server.url;
    }

    if (!args.quiet) {
      write(`flow   ${flow.path}  (${flow.steps.length} steps)`);
      write(`theme  ${theme.path}`);
      if (server) write(`serve  ${path.resolve(args.serve)} at ${server.url}`);
      if (flow.mask.length) write(`mask   ${flow.mask.length} selector(s)`);
      if (secretsUsed.length) write(`env    ${secretsUsed.join(', ')}`);
      write('');
    }

    // Log in first, in a browser of its own, so the login never reaches the
    // video. The saved session is reused until it goes stale.
    let storageState = null;
    if (flow.auth) {
      if (!args.relogin && sessionIsFresh(flow)) {
        storageState = sessionPath(flow);
        ui.plain(`using the saved session in ${flow.auth.stateFile}`);
      } else {
        ui.step('logging in');
        storageState = await authenticate(flow, { headless: !args.headed, log: ui.detail });
      }
    }

    // 1. Narration first. Durations have to exist before the browser starts,
    //    because they decide how long each step stays on screen.
    ui.step(args.tts ? 'narration' : 'narration (silent, --no-tts)');
    const audio = await synthesizeAll(flow.steps, {
      noTts: !args.tts,
      cacheDir: path.join(process.cwd(), '.tts-cache'),
      log: ui.detail,
    });

    // 2. Record.
    ui.step('recording');
    const { videoPath, timeline, totalSec } = await record(flow, theme, audio, {
      outDir: workDir,
      headless: !args.headed,
      log: ui.detail,
      storageState,
    });

    // 3. Narration track: each clip at the timestamp its step actually started.
    ui.step('narration track');
    const clips = [];
    audio.forEach((clip, i) => {
      if (clip && timeline[i]) clips.push({ file: clip.file, startSec: timeline[i].startSec });
    });
    const audioTrack = await ff.buildNarrationTrack(clips, totalSec, path.join(workDir, 'narration.m4a'));

    // 4. Mux, normalising to the theme's resolution and fps. The fade rides
    //    along with whichever encode is this segment's last, rather than
    //    costing another pass.
    const fadeSec = theme.transitions.enabled ? theme.transitions.fadeSec : 0;
    const willBurn = theme.captions.enabled;
    ui.step('assembling');
    let main = await ff.muxAudioVideo(
      videoPath, audioTrack, path.join(workDir, 'main.mp4'), theme.video,
      willBurn ? null : { fadeSec, durationSec: totalSec }
    );

    // 5. Captions, as a post-process, so restyling never means re-recording.
    if (willBurn) {
      const font = theme.captions.font ? theme.fonts[theme.captions.font] : null;
      const mainSec = await ff.probeDuration(main);
      const cues = captions.buildCues(flow.steps, timeline, mainSec);
      if (cues.length) {
        const style = captions.buildForceStyle(theme.captions, font, theme.video);
        const maxChars = captions.lineBudget(theme.captions, theme.video);
        const { srtPath, assPath } = captions.writeCaptionFiles(
          cues, style, theme.video,
          path.join(workDir, 'captions.srt'),
          path.join(workDir, 'captions.ass'),
          maxChars
        );
        // Keep the .srt next to the video: it is useful on its own.
        const srtOut = `${outFile.replace(/\.[^.]+$/, '')}.srt`;
        fs.copyFileSync(srtPath, srtOut);
        ui.step(`captions (${font ? `"${font.family}"` : 'default font'}, ${cues.length} cues)`);
        main = await ff.burnSubtitles(
          main, assPath, null, theme.fontsDir, path.join(workDir, 'captioned.mp4'),
          { fadeSec, durationSec: mainSec }
        );
      } else {
        ui.detail('no narration to caption');
      }
    }

    // 6. Intro/outro cards, then join.
    const segments = [];
    if (theme.intro.enabled) {
      ui.step('intro card');
      segments.push(await buildCardSegment('intro', theme, workDir, fadeSec));
    }
    segments.push(main);
    if (theme.outro.enabled) {
      ui.step('outro card');
      segments.push(await buildCardSegment('outro', theme, workDir, fadeSec));
    }

    if (segments.length > 1) ui.step(`joining ${segments.length} segments`);
    const { method } = await ff.concatSegments(segments, outFile, theme.video, workDir, ui.detail);
    ui.finish();

    const finalSec = await ff.probeDuration(outFile);
    const sizeMb = fs.statSync(outFile).size / (1024 * 1024);
    write('');
    write(`  ${outFile}`);
    write(`  ${finalSec.toFixed(1)}s  ${theme.video.width}x${theme.video.height}  ` +
      `${theme.video.fps}fps  ${sizeMb.toFixed(1)} MB` +
      `${segments.length > 1 ? `  (${method} concat)` : ''}`);
    write(`  built in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
    write('');
    return 0;
  } finally {
    // Nothing in here may throw. This runs after a successful render too, and
    // an exception raised now would replace the result the caller is about to
    // get - a finished video reported as a failure because a temp folder would
    // not delete.
    try { ui.finish(); } catch { /* the run already has its answer */ }
    if (server) await server.close().catch(() => {});
    if (args.keepTemp) write(`temp kept: ${workDir}`);
    else removeWorkDir(workDir, (m) => write(`  ${m}`));
  }
}

/**
 * Fetch anything missing, then say what the machine can do.
 *
 * Run by the launchers before the window opens, so nobody is ever shown an
 * instruction to go and install something themselves.
 */
async function runSetup() {
  const { ensureReady, describe } = require('./preflight');
  write('');
  try {
    const report = await ensureReady({ log: write });
    write('');
    write(describe(report));
    write('');
    if (!report.ffmpeg.ok) {
      write('  The video tools did not come through. Try "npm install" again.');
      write('');
      return 1;
    }
    return 0;
  } catch (err) {
    write('');
    write(`  ${err.message}`);
    write('');
    return 1;
  }
}

/**
 * Open the app window and keep the process alive while it is in use.
 *
 * For anyone who should not have to know that a terminal exists. The window
 * drives the same pipeline the flags do.
 */
async function runUi() {
  // Do the fetching before the window appears, with the progress visible in
  // whatever terminal the launcher opened.
  const { ensureReady } = require('./preflight');
  await ensureReady({ log: write }).catch((err) => {
    write('');
    write(`  ${err.message}`);
    write('  Opening anyway; recording may not work until that is sorted.');
    write('');
  });

  const { createApp, openWindow } = require('./ui');
  const app = createApp({ projectDir: process.cwd() });
  const url = await app.listen();

  write('');
  write('  Walkthrough Recorder is running.');
  write(`  If no window opened, go to: ${url}`);
  write('  Close the window, or press Ctrl+C here, to stop.');
  write('');

  const window = await openWindow(url, write);
  await new Promise((resolve) => {
    if (window.context) window.context.on('close', resolve);
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });

  await window.close();
  await app.close();
  return 0;
}

/**
 * Walk the site, and write down what you did as a flow.
 *
 * Deliberately does not touch the theme: capture is about what happens, not
 * what it looks like, and a half-finished theme should not stop you recording.
 */
async function captureFlow(args) {
  const url = args.url;
  if (!url) {
    throw new ConfigError(
      'capture needs a starting page:\n' +
      '  site-tutorial-video capture --url https://app.example.com'
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ConfigError(`--url must start with http:// or https:// (got "${url}")`);
  }

  const outFile = args.flow === 'flow.json' && args.out !== path.join('out', 'tutorial.mp4')
    ? args.out
    : args.flow;

  if (fs.existsSync(outFile)) {
    write(`note: ${outFile} already exists and will be overwritten when you save.`);
  }
  write(`capturing from ${url}`);

  const { flow, reason } = await capture({ url, outFile, log: write });

  write('');
  if (reason === 'closed' && flow.steps.length <= 1) {
    write('Browser closed with nothing recorded. Nothing written.');
    return 1;
  }
  write(`wrote ${path.resolve(outFile)}  (${flow.steps.length} steps)`);
  write('');
  write('Next:');
  write(`  site-tutorial-video --flow ${outFile} --check     look it over`);
  write(`  site-tutorial-video --flow ${outFile} --no-tts    a free preview`);
  write('');
  return 0;
}

async function buildCardSegment(which, theme, workDir, fadeSec) {
  const card = theme[which];
  const png = await renderCard(card, theme, path.join(workDir, `${which}.png`));
  return ff.imageToVideo(
    png, card.durationSec, path.join(workDir, `${which}.mp4`), theme.video, fadeSec
  );
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Config and theme problems are the user's to fix, so show the message
      // alone. Anything else is a bug here and deserves a stack.
      process.stderr.write(err instanceof ConfigError ? `\n${err.message}\n\n` : `\n${err.stack}\n\n`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, applyOverrides, initProject, captureFlow, setOutput };
