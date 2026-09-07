#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadFlow, ConfigError } = require('./config');
const { loadTheme, describeTheme } = require('./theme');
const { synthesizeAll } = require('./tts');
const { record } = require('./recorder');
const captions = require('./captions');
const { renderCard } = require('./titlecard');
const ff = require('./ffmpeg');
const { serveStatic } = require('./server');

const USAGE = `
site-tutorial-video - turn a flow.json into a narrated, themed tutorial video

  node src/index.js [options]

Options
  --flow <path>       Flow file describing the steps      (default: flow.json)
  --theme <path>      Theme file                          (default: theme.json)
  --out <path>        Output video                        (default: out/tutorial.mp4)
  --no-tts            Use timed silence instead of calling ElevenLabs.
                      Free and fast; pacing matches a real run.
  --no-captions       Skip burning captions.
  --serve <dir>       Serve <dir> statically and use it as the flow's baseUrl.
  --headed            Run the browser headed (for debugging a flow).
  --keep-temp         Leave the intermediate files behind.
  --print-theme       Resolve and print the theme, then exit.
  -h, --help          This text.

Environment
  ELEVENLABS_API_KEY    required unless --no-tts
  ELEVENLABS_VOICE_ID   optional, defaults to a stock voice
  ELEVENLABS_MODEL_ID   optional
`;

function parseArgs(argv) {
  const args = {
    flow: 'flow.json',
    theme: 'theme.json',
    out: path.join('out', 'tutorial.mp4'),
    tts: true,
    captions: true,
    serve: null,
    headed: false,
    keepTemp: false,
    printTheme: false,
    help: false,
  };
  const takesValue = { '--flow': 'flow', '--theme': 'theme', '--out': 'out', '--serve': 'serve' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (takesValue[arg]) {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`${arg} needs a value`);
      args[takesValue[arg]] = value;
      continue;
    }
    switch (arg) {
      case '--no-tts': args.tts = false; break;
      case '--no-captions': args.captions = false; break;
      case '--headed': args.headed = true; break;
      case '--keep-temp': args.keepTemp = true; break;
      case '--print-theme': args.printTheme = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        throw new ConfigError(`Unknown option "${arg}"\n${USAGE}`);
    }
  }
  return args;
}

const log = (msg = '') => process.stdout.write(`${msg}\n`);

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { log(USAGE); return 0; }

  const theme = loadTheme(args.theme);
  if (args.printTheme) { log(describeTheme(theme)); return 0; }

  await ff.checkToolchain();
  const flow = loadFlow(args.flow);

  const outFile = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-'));

  let server = null;
  try {
    if (args.serve) {
      server = await serveStatic(args.serve);
      flow.baseUrl = server.url;
      log(`serving ${path.resolve(args.serve)} at ${server.url}`);
    }

    log(`flow:  ${flow.path} (${flow.steps.length} steps)`);
    log(`theme: ${theme.path}`);
    log('');

    // 1. Narration first. Durations have to exist before the browser starts,
    //    because they decide how long each step stays on screen.
    log(args.tts ? 'generating narration...' : 'generating timed silence (--no-tts)...');
    const audio = await synthesizeAll(flow.steps, {
      noTts: !args.tts,
      cacheDir: path.join(process.cwd(), '.tts-cache'),
      log,
    });

    // 2. Record.
    log('recording...');
    const { videoPath, timeline, totalSec } = await record(flow, theme, audio, {
      outDir: workDir,
      headless: !args.headed,
      log,
    });
    log(`  recorded ${totalSec.toFixed(1)}s`);

    // 3. Narration track: each clip at the timestamp its step actually started.
    log('building narration track...');
    const clips = [];
    audio.forEach((clip, i) => {
      if (clip && timeline[i]) clips.push({ file: clip.file, startSec: timeline[i].startSec });
    });
    const audioTrack = await ff.buildNarrationTrack(clips, totalSec, path.join(workDir, 'narration.m4a'));

    // 4. Mux, normalising to the theme's resolution and fps.
    log('muxing...');
    let main = await ff.muxAudioVideo(videoPath, audioTrack, path.join(workDir, 'main.mp4'), theme.video);

    // 5. Captions, as a post-process, so restyling never means re-recording.
    if (args.captions && theme.captions.enabled) {
      const font = theme.captions.font ? theme.fonts[theme.captions.font] : null;
      const cues = captions.buildCues(flow.steps, timeline, await ff.probeDuration(main));
      if (cues.length) {
        const style = captions.buildForceStyle(theme.captions, font, theme.video);
        const { srtPath, assPath } = captions.writeCaptionFiles(
          cues, style, theme.video,
          path.join(workDir, 'captions.srt'),
          path.join(workDir, 'captions.ass')
        );
        // Keep the .srt next to the video: it is useful on its own.
        fs.copyFileSync(srtPath, outFile.replace(/\.[^.]+$/, '') + '.srt');
        log(`burning captions (${font ? `"${font.family}"` : 'default font'}, ${cues.length} cues)...`);
        main = await ff.burnSubtitles(main, assPath, null, theme.fontsDir, path.join(workDir, 'captioned.mp4'));
      } else {
        log('no narration to caption, skipping captions');
      }
    }

    // 6. Intro/outro cards, then join.
    const segments = [];
    if (theme.intro.enabled) {
      log('rendering intro card...');
      segments.push(await buildCardSegment('intro', theme, workDir));
    }
    segments.push(main);
    if (theme.outro.enabled) {
      log('rendering outro card...');
      segments.push(await buildCardSegment('outro', theme, workDir));
    }

    const { method } = await ff.concatSegments(segments, outFile, theme.video, workDir, (m) => log(`  ${m}`));
    if (segments.length > 1) log(`  joined ${segments.length} segments via concat ${method}`);

    const finalSec = await ff.probeDuration(outFile);
    log('');
    log(`done: ${outFile}`);
    log(`      ${finalSec.toFixed(2)}s, ${theme.video.width}x${theme.video.height} @ ${theme.video.fps}fps`);
    return 0;
  } finally {
    if (server) await server.close();
    if (args.keepTemp) log(`temp kept: ${workDir}`);
    else fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function buildCardSegment(which, theme, workDir) {
  const card = theme[which];
  const png = await renderCard(card, theme, path.join(workDir, `${which}.png`));
  return ff.imageToVideo(png, card.durationSec, path.join(workDir, `${which}.mp4`), theme.video);
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

module.exports = { main, parseArgs };
