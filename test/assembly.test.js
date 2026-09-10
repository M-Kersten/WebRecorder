'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ff = require('../src/ffmpeg');

const ffmpegPath = () => ff.binaries().ffmpeg;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-test-'));
const tmp = (name) => path.join(work, name);
const VIDEO = { width: 320, height: 240, fps: 15 };

test.after(() => fs.rmSync(work, { recursive: true, force: true }));

/** A colour clip with a silent track, matching what the pipeline produces. */
function makeSegment(colour, seconds, out) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=${VIDEO.width}x${VIDEO.height}:r=${VIDEO.fps}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    out,
  ]);
  return out;
}

/** A tone, used to check narration lands where the timeline says it should. */
function makeTone(seconds, out, freq = 900) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`,
    '-ac', '2', '-c:a', 'aac', '-b:a', '128k', out,
  ]);
  return out;
}

/** ffmpeg reports analysis filters on stderr, so read it from there. */
function runCapturingStderr(bin, args) {
  const res = spawnSync(bin, args, { encoding: 'utf8' });
  return `${res.stderr || ''}${res.stdout || ''}`;
}

test('generateSilence produces the exact length asked for', async () => {
  await ff.generateSilence(2.5, tmp('sil.m4a'));
  assert.ok(Math.abs(await ff.probeDuration(tmp('sil.m4a')) - 2.5) < 0.1);
});

test('the concat demuxer joins matching segments and the durations add up', async () => {
  const segs = [
    makeSegment('red', 2, tmp('a.mp4')),
    makeSegment('green', 3, tmp('b.mp4')),
    makeSegment('blue', 2, tmp('c.mp4')),
  ];
  const { method } = await ff.concatSegments(segs, tmp('joined.mp4'), VIDEO, work);
  assert.strictEqual(method, 'demuxer', 'matching segments should stream-copy');
  const total = await ff.probeDuration(tmp('joined.mp4'));
  assert.ok(Math.abs(total - 7) < 0.25, `expected ~7s, got ${total.toFixed(2)}s`);
});

test('the concat filter joins segments the demuxer would refuse', async () => {
  // Different resolution and fps: exactly the mismatch the demuxer rejects.
  const odd = tmp('odd.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=yellow:s=640x480:r=25',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', odd,
  ]);
  const segs = [makeSegment('red', 2, tmp('d.mp4')), odd];

  await ff.concatFilter(segs, tmp('filtered.mp4'), VIDEO);
  const total = await ff.probeDuration(tmp('filtered.mp4'));
  assert.ok(Math.abs(total - 4) < 0.35, `expected ~4s, got ${total.toFixed(2)}s`);

  // And the re-encode normalises everything to the target geometry.
  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', tmp('filtered.mp4'),
  ]).toString().trim();
  assert.strictEqual(probe, `${VIDEO.width},${VIDEO.height}`);
});

test('mismatched segments are detected before the demuxer runs', async () => {
  // This matters because the demuxer does not reliably refuse them: with a
  // different codec it exits 0 and writes a file whose second half will not
  // decode. Catching it up front is the only way to avoid shipping that.
  const mismatched = tmp('mismatch.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=640x480:r=25',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', mismatched,
  ]);
  const segs = [makeSegment('red', 1, tmp('e.mp4')), mismatched];

  const reason = await ff.concatCompatibility(segs);
  assert.ok(reason, 'the mismatch should be reported');
  assert.match(reason, /codec|width|height/);

  const notes = [];
  const { method } = await ff.concatSegments(segs, tmp('fallback.mp4'), VIDEO, work, (m) => notes.push(m));
  assert.strictEqual(method, 'filter', 'must not stream-copy segments that do not match');
  assert.ok(notes.some((n) => /re-encoding/.test(n)), 'the fallback should say why');

  // The re-encoded result must actually be whole and decodable end to end.
  const total = await ff.probeDuration(tmp('fallback.mp4'));
  assert.ok(Math.abs(total - 2) < 0.35, `expected ~2s, got ${total.toFixed(2)}s`);
  const decoded = runCapturingStderr('ffmpeg', [
    '-hide_banner', '-v', 'error', '-i', tmp('fallback.mp4'), '-f', 'null', '-',
  ]);
  assert.strictEqual(decoded.trim(), '', `every frame should decode, ffmpeg said: ${decoded}`);
});

test('matching segments are recognised as safe to stream-copy', async () => {
  const segs = [makeSegment('red', 1, tmp('m1.mp4')), makeSegment('blue', 1, tmp('m2.mp4'))];
  assert.strictEqual(await ff.concatCompatibility(segs), null);
});

test('a single segment is passed through untouched', async () => {
  const only = makeSegment('red', 1, tmp('solo.mp4'));
  const { method } = await ff.concatSegments([only], tmp('solo-out.mp4'), VIDEO, work);
  assert.strictEqual(method, 'copy');
  assert.deepStrictEqual(fs.readFileSync(tmp('solo-out.mp4')), fs.readFileSync(only));
});

test('narration clips land at their recorded timestamps, not end to end', async () => {
  // Two 1s tones placed at 1s and 5s inside an 8s track. If adelay were wrong
  // - or amix concatenated instead of mixing - the second tone would sit at 2s.
  const clips = [
    { file: makeTone(1, tmp('t1.m4a'), 900), startSec: 1 },
    { file: makeTone(1, tmp('t2.m4a'), 900), startSec: 5 },
  ];
  await ff.buildNarrationTrack(clips, 8, tmp('narration.m4a'));

  const total = await ff.probeDuration(tmp('narration.m4a'));
  assert.ok(Math.abs(total - 8) < 0.3, `track should span the whole video, got ${total.toFixed(2)}s`);

  // silencedetect reports the gaps; the loud stretches are what is left.
  // It logs to stderr, so capture that rather than stdout.
  const out = runCapturingStderr('ffmpeg', [
    '-hide_banner', '-i', tmp('narration.m4a'),
    '-af', 'silencedetect=noise=-45dB:d=0.25', '-f', 'null', '-',
  ]);

  const starts = [...out.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));

  // Audio begins silent, so the first silence_end is the first tone's onset.
  assert.ok(ends.length >= 2, `expected at least two silence ends, got ${ends.length}`);
  assert.ok(Math.abs(ends[0] - 1) < 0.2, `first clip should start at 1s, saw ${ends[0]}`);
  assert.ok(Math.abs(ends[1] - 5) < 0.2, `second clip should start at 5s, saw ${ends[1]}`);
  assert.ok(starts.some((s) => Math.abs(s - 2) < 0.25), `first clip should end near 2s, saw ${starts}`);
});

test('an empty narration list still yields a full-length silent track', async () => {
  await ff.buildNarrationTrack([], 3, tmp('empty.m4a'));
  assert.ok(Math.abs(await ff.probeDuration(tmp('empty.m4a')) - 3) < 0.2);
});

test('imageToVideo produces the target geometry with an audio track attached', async () => {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=orange:s=320x240', '-frames:v', '1', tmp('card.png'),
  ]);
  await ff.imageToVideo(tmp('card.png'), 2.5, tmp('card.mp4'), VIDEO);

  assert.ok(Math.abs(await ff.probeDuration(tmp('card.mp4')) - 2.5) < 0.2);
  const streams = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height',
    '-of', 'csv=p=0', tmp('card.mp4'),
  ]).toString().trim().split('\n');
  assert.strictEqual(streams.length, 2, 'a card needs a silent audio track so concat stays consistent');
  assert.ok(streams.some((s) => s.startsWith('video,320,240')));
  assert.ok(streams.some((s) => s.startsWith('audio')));
});

test('a filter option value containing a comma is quoted', () => {
  assert.strictEqual(ff.escapeFilterValue('FontName=A,B'), "'FontName=A,B'");
});

// A Windows path cannot be escaped into a filtergraph reliably: options are
// split on ":", which a drive letter contains, and the graph is unescaped
// twice. Colons are legal in filenames here, so the failure reproduces exactly.
test('captions burn from a folder whose path contains a colon', async () => {
  const drive = path.join(work, 'C:', 'Users', 'GEBRUI~1', 'Temp');
  fs.mkdirSync(drive, { recursive: true });
  const fontsHere = path.join(work, 'C:', 'Users', 'brand fonts');
  fs.mkdirSync(fontsHere, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'fonts', 'OverusedGrotesk-Roman.ttf'),
    path.join(fontsHere, 'OverusedGrotesk-Roman.ttf')
  );

  const captions = require('../src/captions');
  const video = { width: 320, height: 240, fps: 15 };
  const font = {
    family: 'Overused Grotesk', weight: 400, style: 'normal',
    metrics: { lineSpan: 1.35 },
  };
  const style = captions.buildForceStyle({
    enabled: true, font: 'body', fontSize: 20, color: '#FFFFFF',
    backgroundColor: '#000000', backgroundOpacity: 0.6,
    position: 'bottom', marginBottom: 20, outline: true,
  }, font, video);
  const cues = captions.buildCues([{ narration: 'Hello there' }], [{ startSec: 0, endSec: 2 }], 3);
  const { assPath } = captions.writeCaptionFiles(
    cues, style, video,
    path.join(drive, 'captions.srt'), path.join(drive, 'captions.ass'), 42
  );

  const source = makeSegment('blue', 3, path.join(drive, 'in.mp4'));
  const out = path.join(drive, 'out.mp4');
  await ff.burnSubtitles(source, assPath, null, fontsHere, out, { fadeSec: 0.35, durationSec: 3 });

  assert.ok(fs.existsSync(out), 'a video came out the other side');
  assert.ok(Math.abs(await ff.probeDuration(out) - 3) < 0.3);

  // And every frame of it decodes, so the burn really happened.
  const decoded = runCapturingStderr(ffmpegPath(), [
    '-hide_banner', '-v', 'error', '-i', out, '-f', 'null', '-',
  ]);
  assert.strictEqual(decoded.trim(), '', decoded);
});

test('the fonts are placed where libass will look for them', async () => {
  const drive = path.join(work, 'C:', 'second run');
  fs.mkdirSync(drive, { recursive: true });
  const captionFile = path.join(drive, 'captions.ass');
  fs.writeFileSync(captionFile, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 320', 'PlayResY: 240', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Alignment',
    'Style: Caption,Overused Grotesk,30,&H00FFFFFF,2', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,Hello',
  ].join('\n'));

  const source = makeSegment('red', 2, path.join(drive, 'in.mp4'));
  const out = path.join(drive, 'out.mp4');
  await ff.burnSubtitles(source, captionFile, null,
    path.join(__dirname, '..', 'fonts'), out, null);

  const copied = fs.readdirSync(path.join(drive, 'fonts'));
  assert.ok(copied.includes('OverusedGrotesk-Roman.ttf'), `fonts were copied: ${copied}`);
  assert.ok(!copied.some((f) => /\.(md|txt)$/i.test(f)),
    `only font files, got ${copied.join(', ')}`);
});

test('fadeFilters places the fades at both ends', () => {
  const { video, audio } = ff.fadeFilters({ fadeSec: 0.4, durationSec: 10 });
  assert.deepStrictEqual(video, ['fade=t=in:st=0:d=0.400', 'fade=t=out:st=9.600:d=0.400']);
  assert.strictEqual(audio.length, 2, 'audio fades too, so narration does not click');
  assert.match(audio[0], /^afade=t=in/);
});

test('fadeFilters yields nothing when there is no fade to apply', () => {
  assert.deepStrictEqual(ff.fadeFilters(null), { video: [], audio: [] });
  assert.deepStrictEqual(ff.fadeFilters({ fadeSec: 0, durationSec: 10 }), { video: [], audio: [] });
  assert.deepStrictEqual(ff.fadeFilters({ fadeSec: 0.4, durationSec: 0 }), { video: [], audio: [] });
});

test('a fade never swallows a short segment whole', () => {
  // 0.4s of fade at each end of a 0.8s clip would leave no clear frame at all.
  const { video } = ff.fadeFilters({ fadeSec: 0.4, durationSec: 0.8 });
  const inD = Number(video[0].match(/d=([\d.]+)/)[1]);
  const outStart = Number(video[1].match(/st=([\d.]+)/)[1]);
  assert.ok(inD < 0.4, 'the fade is shortened to fit');
  assert.ok(outStart > inD, 'and the two fades do not overlap');
});

/** Mean luma of one frame, 0-255. Used to prove a fade actually darkens. */
function frameBrightness(file, atSec) {
  // -ss before -i, so decoding starts at the timestamp. As an output option it
  // discards frames after the filter graph, and metadata=print has already
  // logged every one of them - the first reading would always be frame 0.
  const out = runCapturingStderr('ffmpeg', [
    '-hide_banner', '-ss', String(atSec), '-i', file,
    '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ]);
  const match = out.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  assert.ok(match, `no luma reading from ${file} at ${atSec}s`);
  return Number(match[1]);
}

test('a faded card really is dark at its edges and bright in the middle', async () => {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x240', '-frames:v', '1', tmp('white.png'),
  ]);
  await ff.imageToVideo(tmp('white.png'), 3, tmp('faded.mp4'), VIDEO, 0.5);

  const opening = frameBrightness(tmp('faded.mp4'), 0.03);
  const middle = frameBrightness(tmp('faded.mp4'), 1.5);
  const closing = frameBrightness(tmp('faded.mp4'), 2.85);

  assert.ok(middle > 200, `the middle should be white, got ${middle}`);
  assert.ok(opening < middle / 2, `the opening should be dark, got ${opening} vs ${middle}`);
  assert.ok(closing < middle / 2, `the close should be dark, got ${closing} vs ${middle}`);
});

test('without a fade the same card stays bright end to end', async () => {
  await ff.imageToVideo(tmp('white.png'), 2, tmp('unfaded.mp4'), VIDEO, 0);
  assert.ok(frameBrightness(tmp('unfaded.mp4'), 0.03) > 200);
  assert.ok(frameBrightness(tmp('unfaded.mp4'), 1.85) > 200);
});

test('the letterbox uses the theme colour rather than black', async () => {
  // A 4:3 source in a 16:9 frame gets pillarboxed; the bars should be themed.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=240x240:r=15',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', tmp('square.mp4'),
  ]);
  await ff.generateSilence(1, tmp('sil2.m4a'));
  await ff.muxAudioVideo(
    tmp('square.mp4'), tmp('sil2.m4a'), tmp('boxed.mp4'),
    { ...VIDEO, backgroundColor: '#FF0000' }
  );
  // Sample the far-left column, which is all pillarbox.
  const rgb = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', tmp('boxed.mp4'),
    '-frames:v', '1', '-vf', 'crop=8:8:0:100', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  assert.ok(rgb[0] > 180, `pillarbox should be red, got rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
  assert.ok(rgb[1] < 70 && rgb[2] < 70, `pillarbox should be red, got rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
});
