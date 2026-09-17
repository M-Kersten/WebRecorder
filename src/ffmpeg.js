'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Find a binary, preferring the one shipped with the project.
 *
 * ffmpeg-static and ffprobe-static download a build for this platform during
 * npm install, which is what lets somebody run this without installing ffmpeg
 * themselves. An explicit env var still wins, and a system install is the last
 * resort rather than the first.
 */
function resolveBinary(envVar, packageName, onPath) {
  const explicit = process.env[envVar];
  if (explicit) return explicit;
  try {
    const exported = require(packageName);
    const bin = typeof exported === 'string' ? exported : exported && exported.path;
    if (bin && fs.existsSync(bin)) {
      // The download does not always survive with its exec bit intact.
      try { fs.accessSync(bin, fs.constants.X_OK); } catch { fs.chmodSync(bin, 0o755); }
      return bin;
    }
  } catch {
    // Not installed, or no build for this platform: fall through to PATH.
  }
  return onPath;
}

const FFMPEG = resolveBinary('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg');
const FFPROBE = resolveBinary('FFPROBE_PATH', 'ffprobe-static', 'ffprobe');

/** Where the binaries came from, for the setup report. */
const binaries = () => ({
  ffmpeg: FFMPEG,
  ffprobe: FFPROBE,
  bundled: FFMPEG !== 'ffmpeg' && FFMPEG.includes('node_modules'),
});

/**
 * Run a binary and buffer its output. Rejects with the tail of stderr, which is
 * where ffmpeg puts the one line that actually explains the failure.
 */
function run(bin, args, { label, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      reject(new Error(`Could not run "${bin}". Is it installed and on PATH?\n${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().split('\n').slice(-12).join('\n');
      reject(new Error(`${label || bin} failed (exit ${code}):\n${tail}`));
    });
  });
}

const ffmpeg = (args, opts) =>
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { label: 'ffmpeg', ...opts });

/** Font files worth handing to libass. */
const FONT_FILE = /\.(ttf|otf|ttc)$/i;

/** Verify ffmpeg/ffprobe exist and carry the features this tool depends on. */
async function checkToolchain() {
  let filters;
  try {
    ({ stdout: filters } = await run(FFMPEG, ['-hide_banner', '-filters']));
  } catch (err) {
    throw new Error(
      `ffmpeg is required but not usable.\n${err.message}\n` +
      'It normally comes with the project; try running "npm install" again, ' +
      'or point FFMPEG_PATH at a build that has libass and libx264.'
    );
  }
  await run(FFPROBE, ['-hide_banner', '-version']).catch(() => {
    throw new Error('ffprobe is required but not usable. It ships with ffmpeg; check FFPROBE_PATH.');
  });

  const missing = [];
  if (!/\bsubtitles\b/.test(filters)) missing.push('the "subtitles" filter (libass) - needed to burn captions');
  const { stdout: encoders } = await run(FFMPEG, ['-hide_banner', '-encoders']);
  if (!/\blibx264\b/.test(encoders)) missing.push('the libx264 encoder - needed to write H.264 video');
  if (missing.length) {
    throw new Error(
      `This ffmpeg build is missing:\n  - ${missing.join('\n  - ')}\n` +
      'Playwright bundles a stripped-down ffmpeg that will not work here; install a full build.'
    );
  }
}

/**
 * Codec and geometry of a file's first video and audio stream.
 * Used to decide whether the concat demuxer can be trusted with a set of
 * segments - see concatSegments for why the exit code alone is not enough.
 */
async function probeStreams(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels',
    '-of', 'json', file,
  ], { label: 'ffprobe' });
  const streams = (JSON.parse(stdout).streams || []);
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  return {
    video: video && {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      pixFmt: video.pix_fmt,
      fps: ratio(video.r_frame_rate),
    },
    audio: audio && {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
    },
  };
}

/**
 * How the picture is encoded at each stage.
 *
 * Measured against a lossless reference of the same frame: the encoder itself
 * costs almost nothing (SSIM 0.9977 at crf 20) and lowering crf barely moves
 * it (0.9983 at crf 12). Chroma subsampling is the one setting that shows, at
 * 0.9981 for 4:2:0 against 0.9996 for 4:4:4 in a single encode, which is what
 * a page of coloured text and hairlines would suggest.
 *
 * It does not follow that 4:4:4 intermediates improve a 4:2:0 delivery, and
 * measuring says they do not: the final subsample discards that chroma anyway,
 * and a 4:4:4 chain and a 4:2:0 chain both land on 0.9840. They are kept at
 * 4:4:4 so that a master, when one is asked for, is 4:4:4 the whole way rather
 * than upsampled from something already thrown away. The delivered file is no
 * worse for it, and crf 14 here keeps the intermediates well clear of the one
 * encode that counts.
 */
const WORKING = {
  pixFmt: 'yuv444p',
  args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14'],
};

/**
 * The file that gets handed out. 4:2:0 because that is what players and
 * hardware decoders can be relied on to read, and tagged BT.709 because an
 * untagged file leaves the player guessing between that and BT.601, which is
 * a visible shift in saturation.
 */
const BT709_TAGS = [
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
];

/**
 * Converting, not just labelling.
 *
 * ffmpeg turns RGB into YUV with BT.601 coefficients unless told otherwise, so
 * everything upstream is 601. Most players assume BT.709 for anything this size
 * and decode it that way, which is where the shift in saturation comes from.
 *
 * Tagging the file 709 without converting it is worse than leaving it untagged:
 * measured against a lossless reference, no tags scores 0.9979, a bare 709 tag
 * 0.9842, and converting then tagging 0.9953. The last one is the only one that
 * is true, and the gap under it is the conversion's own 8-bit rounding.
 */
const TO_709 = 'scale=in_color_matrix=bt601:in_range=tv:out_color_matrix=bt709:out_range=tv';

const DELIVERY = {
  pixFmt: 'yuv420p',
  filter: TO_709,
  args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...BT709_TAGS],
};

/** A master to edit from: no subsampling at all, and near-transparent quality. */
const MASTER = {
  pixFmt: 'yuv444p',
  filter: TO_709,
  args: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', ...BT709_TAGS],
};

const profileFor = (name) => ({ working: WORKING, delivery: DELIVERY, master: MASTER }[name] || WORKING);

function ratio(text) {
  const [num, den] = String(text || '0/1').split('/').map(Number);
  return den ? num / den : num;
}

/**
 * Can these segments be stream-copied together?
 *
 * Returns null when they can, or a sentence saying what differs when they
 * cannot. Checked up front because the demuxer does not reliably fail on a
 * mismatch: given segments with different codecs it can exit 0 and still write
 * a file whose second half will not decode.
 */
async function concatCompatibility(segments) {
  const probes = await Promise.all(segments.map(probeStreams));
  const [first] = probes;
  if (!first.video) return `${segments[0]} has no video stream`;

  for (let i = 1; i < probes.length; i++) {
    const p = probes[i];
    const where = `segment ${i + 1} (${path.basename(segments[i])})`;
    if (!p.video) return `${where} has no video stream`;
    for (const [field, label] of [['codec', 'video codec'], ['width', 'width'],
      ['height', 'height'], ['pixFmt', 'pixel format']]) {
      if (p.video[field] !== first.video[field]) {
        return `${where} has ${label} ${p.video[field]}, first segment has ${first.video[field]}`;
      }
    }
    if (Math.abs(p.video.fps - first.video.fps) > 0.01) {
      return `${where} runs at ${p.video.fps.toFixed(2)}fps, first segment at ${first.video.fps.toFixed(2)}fps`;
    }
    if (!!p.audio !== !!first.audio) {
      return `${where} ${p.audio ? 'has' : 'is missing'} an audio stream, unlike the first segment`;
    }
    if (p.audio && first.audio) {
      for (const [field, label] of [['codec', 'audio codec'], ['sampleRate', 'sample rate'],
        ['channels', 'channel count']]) {
        if (p.audio[field] !== first.audio[field]) {
          return `${where} has ${label} ${p.audio[field]}, first segment has ${first.audio[field]}`;
        }
      }
    }
  }
  return null;
}

/** Duration of a media file in seconds. */
async function probeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { label: 'ffprobe' });
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read a duration from ${file}`);
  return seconds;
}

/**
 * Fade-to-black at both ends of a segment, plus the matching audio fade so the
 * narration does not clip in or out.
 *
 * Returned as filter fragments rather than applied here, so the fade rides along
 * with an encode that was happening anyway instead of costing a second pass.
 * `fade` is { fadeSec, durationSec }; a zero or missing fadeSec yields nothing.
 */
function fadeFilters(fade) {
  if (!fade || !fade.fadeSec || !(fade.durationSec > 0)) return { video: [], audio: [] };
  // Never let the two fades meet in the middle of a very short segment.
  const d = Math.min(fade.fadeSec, fade.durationSec / 2.5);
  if (d <= 0.01) return { video: [], audio: [] };
  const out = Math.max(0, fade.durationSec - d).toFixed(3);
  return {
    video: [`fade=t=in:st=0:d=${d.toFixed(3)}`, `fade=t=out:st=${out}:d=${d.toFixed(3)}`],
    audio: [`afade=t=in:st=0:d=${d.toFixed(3)}`, `afade=t=out:st=${out}:d=${d.toFixed(3)}`],
  };
}

/** Silent AAC of an exact length. Used for --no-tts and for title-card audio. */
async function generateSilence(durationSec, outFile) {
  await ffmpeg([
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', durationSec.toFixed(3),
    '-c:a', 'aac', '-b:a', '128k',
    outFile,
  ]);
  return outFile;
}

/**
 * Lay each narration clip onto one track at its real recorded timestamp.
 * `clips` is [{ file, startSec }]; `totalSec` pads the track to the full video
 * length so the mux does not truncate on a short last clip.
 */
async function buildNarrationTrack(clips, totalSec, outFile) {
  if (!clips.length) return generateSilence(totalSec, outFile);

  const inputs = [];
  const filters = [];
  clips.forEach((clip, i) => {
    inputs.push('-i', clip.file);
    const delayMs = Math.max(0, Math.round(clip.startSec * 1000));
    // adelay needs one value per channel; "all=1" applies it to every channel.
    filters.push(`[${i}:a]aresample=48000,adelay=${delayMs}:all=1[a${i}]`);
  });
  const labels = clips.map((_, i) => `[a${i}]`).join('');
  // A silent bed of the full length keeps amix from ending at the last clip.
  inputs.push('-f', 'lavfi', '-t', totalSec.toFixed(3),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const bed = `[${clips.length}:a]`;
  filters.push(
    `${labels}${bed}amix=inputs=${clips.length + 1}:duration=longest:dropout_transition=0:normalize=0[mixed]`
  );

  await ffmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[mixed]',
    '-t', totalSec.toFixed(3),
    '-c:a', 'aac', '-b:a', '192k',
    outFile,
  ]);
  return outFile;
}

/**
 * Normalise the recorded video to the theme's resolution/fps and attach the
 * narration track. Everything downstream assumes these exact stream settings.
 */
async function muxAudioVideo(videoFile, audioFile, outFile, video, fade, profile = 'working',
  trimSec = 0) {
  const { width, height, fps } = video;
  const p = profileFor(profile);
  const f = fadeFilters(fade);
  // Letterbox in the theme's colour rather than ffmpeg's default black.
  const pad = video.backgroundColor ? `:color=${video.backgroundColor}` : '';
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2${pad}`,
    `fps=${fps}`,
    ...f.video,
    `format=${p.pixFmt}`,
  ];
  const args = [
    // Before -i, so the decoder seeks rather than decoding and discarding, and
    // only on the video: the narration track was built against the trimmed
    // timeline and already starts where it should.
    ...(trimSec > 0 ? ['-ss', trimSec.toFixed(3)] : []),
    '-i', videoFile,
    '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', vf.join(','),
  ];
  if (f.audio.length) args.push('-af', f.audio.join(','));
  args.push(
    ...p.args,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    outFile
  );
  await ffmpeg(args);
  return outFile;
}

/** A still image as a video segment, with the same streams as the main clip. */
async function imageToVideo(imageFile, durationSec, outFile, video, fadeSec, audioFile = null,
  profile = 'working') {
  const { width, height, fps } = video;
  const p = profileFor(profile);
  const f = fadeFilters({ fadeSec, durationSec });
  const vf = [`scale=${width}:${height}`, `fps=${fps}`, ...f.video, `format=${p.pixFmt}`];

  // The card's length is what it is. A clip longer than the card is cut off at
  // the end; a shorter one leaves silence after it rather than stretching the
  // card to fit, so the card and its narration timings stay predictable.
  const audioIn = audioFile
    ? ['-i', audioFile]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
  const af = audioFile
    ? [
      'aresample=48000',
      `atrim=0:${durationSec.toFixed(3)}`,
      'asetpts=N/SR/TB',
      `apad=whole_dur=${durationSec.toFixed(3)}`,
      // Never let a trimmed clip stop dead on the cut.
      `afade=t=out:st=${Math.max(0, durationSec - 0.35).toFixed(3)}:d=0.35`,
    ]
    : null;

  await ffmpeg([
    '-loop', '1', '-i', imageFile,
    ...audioIn,
    '-t', durationSec.toFixed(3),
    '-vf', vf.join(','),
    ...(af ? ['-af', af.join(',')] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/**
 * Lay a music bed under a finished video.
 *
 * Last, so it covers the cards as well as the walkthrough, and video-copy only,
 * so a bed costs an audio encode rather than a second pass over every frame.
 * The track is looped to reach the end and faded at both ends; it is not ducked
 * under the narration, it is simply quiet.
 */
async function addMusicBed(videoFile, musicFile, outFile, { volume, fadeSec, durationSec }) {
  const end = Math.max(0, durationSec - fadeSec);
  const bed = [
    'aresample=48000',
    'aformat=channel_layouts=stereo',
    `volume=${Math.max(0, Math.min(1, volume)).toFixed(3)}`,
    `atrim=0:${durationSec.toFixed(3)}`,
    'asetpts=N/SR/TB',
    ...(fadeSec > 0 ? [`afade=t=in:st=0:d=${fadeSec.toFixed(3)}`] : []),
    ...(fadeSec > 0 ? [`afade=t=out:st=${end.toFixed(3)}:d=${fadeSec.toFixed(3)}`] : []),
  ].join(',');

  await ffmpeg([
    '-i', videoFile,
    // Loop the track rather than letting a two-minute video run out of music.
    '-stream_loop', '-1', '-i', musicFile,
    '-filter_complex',
    `[1:a]${bed}[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]`,
    '-map', '0:v', '-map', '[out]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/**
 * Burn captions. `fontsDir` is what lets libass see the bundled fonts instead
 * of falling back to a system face.
 */
async function burnSubtitles(videoFile, srtFile, forceStyle, fontsDir, outFile, fade,
  profile = 'working') {
  // Both paths this filter takes are made relative and ffmpeg is run from the
  // folder holding them, so no absolute path ever reaches the filter string.
  //
  // A Windows path cannot be escaped into a filtergraph reliably. Options are
  // split on ":", which a drive letter contains, and the graph is unescaped
  // twice: one backslash is eaten by the first pass and the colon then splits
  // the arguments anyway ("No option name near '/Users/...'"), while two
  // backslashes survive parsing on some builds and not others. Relative paths
  // have no colon in them, so there is nothing left to get wrong.
  const workDir = path.dirname(path.resolve(srtFile));
  const opts = [`filename=${path.basename(srtFile)}`];

  if (fontsDir && fs.existsSync(fontsDir)) {
    const localFonts = path.join(workDir, 'fonts');
    fs.mkdirSync(localFonts, { recursive: true });
    for (const name of fs.readdirSync(fontsDir).filter((f) => FONT_FILE.test(f))) {
      fs.copyFileSync(path.join(fontsDir, name), path.join(localFonts, name));
    }
    opts.push('fontsdir=fonts');
  }
  if (forceStyle) opts.push(`force_style=${escapeFilterValue(forceStyle)}`);

  const f = fadeFilters(fade);
  // The fade goes after the burn so the captions fade with the frame.
  const vf = [`subtitles=${opts.join(':')}`, ...f.video];
  const args = ['-i', path.resolve(videoFile), '-vf', vf.join(',')];
  if (f.audio.length) {
    args.push('-af', f.audio.join(','), '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-c:a', 'copy');
  }
  args.push(
    ...profileFor(profile).args,
    '-pix_fmt', profileFor(profile).pixFmt,
    '-movflags', '+faststart',
    path.resolve(outFile)
  );
  await ffmpeg(args, { cwd: workDir });
  return outFile;
}

/**
 * Stream-copy concat. Fast and lossless, but the demuxer refuses anything but
 * an exact codec/timebase match, so callers fall back to concatFilter.
 */
async function concatDemuxer(segments, outFile, workDir) {
  const listFile = path.join(workDir, 'concat-list.txt');
  // Forward slashes even on Windows: the concat demuxer reads a backslash as an
  // escape character, so C:\Users\... arrives mangled.
  const body = segments
    .map((s) => path.resolve(s).replace(/\\/g, '/').replace(/'/g, "'\\''"))
    .map((p) => `file '${p}'`)
    .join('\n');
  fs.writeFileSync(listFile, body + '\n', 'utf8');
  await ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/** Re-encoding concat. Slower, but tolerant of segments that do not line up. */
async function concatFilter(segments, outFile, video, profile = 'working') {
  const { width, height, fps } = video;
  const p = profileFor(profile);
  const inputs = [];
  const pre = [];
  segments.forEach((seg, i) => {
    inputs.push('-i', seg);
    pre.push(`[${i}:v]scale=${width}:${height},fps=${fps},format=${p.pixFmt},setsar=1[v${i}]`);
    pre.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const labels = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  const graph = `${pre.join(';')};${labels}concat=n=${segments.length}:v=1:a=1[v][a]`;
  await ffmpeg([
    ...inputs,
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    ...p.args,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/**
 * Join segments, preferring the stream-copy demuxer and falling back to the
 * re-encoding filter when they will not line up.
 *
 * The demuxer is checked for *before* it runs rather than after. Given segments
 * whose codecs or geometry differ it can exit 0 and still produce a file whose
 * later segments do not decode - a silently broken video, which is worse than a
 * slow one. So compatibility is established by probing, and the result is
 * duration-checked afterwards as a second guard.
 */
async function concatSegments(segments, outFile, video, workDir, log = () => {}, profile = 'working') {
  if (segments.length === 1) {
    fs.copyFileSync(segments[0], outFile);
    return { outFile, method: 'copy' };
  }

  const expectedSec = (await Promise.all(segments.map(probeDuration)))
    .reduce((a, b) => a + b, 0);

  const mismatch = await concatCompatibility(segments);
  if (mismatch) {
    log(`segments do not match, re-encoding instead (${mismatch})`);
    await concatFilter(segments, outFile, video, profile);
    return { outFile, method: 'filter', expectedSec };
  }

  try {
    await concatDemuxer(segments, outFile, workDir);
    const actualSec = await probeDuration(outFile);
    // Half a second of slack covers container rounding, nothing more.
    if (Math.abs(actualSec - expectedSec) > 0.5) {
      throw new Error(
        `stream copy produced ${actualSec.toFixed(2)}s from ${expectedSec.toFixed(2)}s of input`
      );
    }
    return { outFile, method: 'demuxer', expectedSec };
  } catch (err) {
    log(`concat demuxer could not be trusted, re-encoding instead (${firstLine(err.message)})`);
    await concatFilter(segments, outFile, video, profile);
    return { outFile, method: 'filter', expectedSec };
  }
}

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) || '';

/** A filter option value that itself contains commas has to be single-quoted. */
function escapeFilterValue(v) {
  return `'${String(v).replace(/'/g, "\\'")}'`;
}

/**
 * The one encode that leaves the working chroma behind.
 *
 * Everything before this keeps 4:4:4 so the chain stops throwing away the
 * colour in coloured text four times over. This is where the file becomes
 * something a player and a hardware decoder will read, tagged BT.709 so nobody
 * has to guess, and where the sound is brought to one level.
 *
 * `loudness` is the target in LUFS, or null to leave the audio alone. A
 * walkthrough with no narration and no music is left alone either way: there is
 * nothing in it to normalise.
 */
async function deliver(videoFile, outFile, { profile = 'delivery', loudness = null } = {}) {
  const p = profileFor(profile);
  const args = ['-i', videoFile];
  if (p.filter) args.push('-vf', p.filter);
  args.push(...p.args, '-pix_fmt', p.pixFmt);
  if (loudness === null) {
    args.push('-c:a', 'copy');
  } else {
    // Two-pass would measure first and correct exactly; one pass is within a
    // decibel and does not double the length of a render.
    args.push('-af', `loudnorm=I=${loudness}:TP=-1.5:LRA=11`,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  }
  args.push('-movflags', '+faststart', outFile);
  await ffmpeg(args);
  return outFile;
}

/** Is there anything in this file's audio worth levelling? */
async function hasSound(file) {
  const out = await run(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect',
    '-f', 'null', '-'], { label: 'ffmpeg' }).catch(() => null);
  if (!out) return false;
  const mean = (out.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
  return !!mean && Number(mean[1]) > -70;
}

/**
 * The first frame that has anything in it.
 *
 * Used to find the moment the curtain came down, which is the only reliable
 * bridge between the recorder's clock and the video's own timeline. Playwright
 * does not say when capture began, and the arithmetic - video duration minus
 * the time the recorder measured - carries about four hundred milliseconds of
 * slop, enough to put every line of narration out of step. The picture does not
 * have that problem.
 *
 * It asks whether the frame is *flat*, not whether it matches the stage colour.
 * That distinction is the whole function. Matching the colour worked on a dark
 * theme over a dark site and failed completely on a light one: a #F4F5F7 stage
 * over a white login page differs by eleven per channel, under any tolerance
 * worth having, so the page never "showed through" and the opening stayed in
 * the video. Measured on that exact case, cells-off-the-stage peaked at 2% and
 * never tripped, while the luma spread went 0 -> 48 on the frame the page
 * arrived. A curtain is one colour edge to edge; a page has text in it.
 *
 * Six is where the gap actually is, measured rather than picked: a curtain reads
 * 0.1 to 1.0 across three recordings, and the sparsest page tried - one flat
 * colour with a single small button on it - reads 9.1. A real page with text on
 * it reads 48. A page that genuinely never gains any contrast returns null and
 * nothing is trimmed, which is the safe way round.
 *
 * Decoded small and only for the opening, so this costs a fraction of a second.
 * Returns seconds, or null if the picture never gains any contrast.
 */
async function firstFrameWithDetail(file, { maxSec = 30, fps = 10, minSpread = 6 } = {}) {
  const cols = 24;
  const rows = 14;
  // Through a file rather than a pipe: run() collects stdout by string
  // concatenation, which is right for every other caller and ruinous for raw
  // pixels.
  const scratch = `${file}.opening.rgb`;
  try {
    await ffmpeg([
      '-t', String(maxSec), '-i', file,
      '-vf', `fps=${fps},scale=${cols}:${rows}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', scratch,
    ]);
  } catch {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(scratch);
  } catch {
    return null;
  } finally {
    fs.rmSync(scratch, { force: true });
  }
  if (!raw.length) return null;

  const frameBytes = cols * rows * 3;
  const frames = Math.floor(raw.length / frameBytes);
  const spread = (f) => {
    const at = f * frameBytes;
    let lo = 255;
    let hi = 0;
    for (let px = 0; px < frameBytes; px += 3) {
      const luma = 0.299 * raw[at + px] + 0.587 * raw[at + px + 1] + 0.114 * raw[at + px + 2];
      if (luma < lo) lo = luma;
      if (luma > hi) hi = luma;
    }
    return hi - lo;
  };

  // Two frames running, not one. A single frame can carry a codec artifact or a
  // half-painted swap that reads as content and is gone again next frame, and
  // acting on one of those cuts in the wrong place. A page that has arrived is
  // still there 100ms later, so the cost of asking twice is nothing.
  for (let f = 0; f + 1 < frames; f++) {
    if (spread(f) >= minSpread && spread(f + 1) >= minSpread) return f / fps;
  }
  return null;
}

module.exports = {
  firstFrameWithDetail,
  ffmpeg,
  binaries,
  resolveBinary,
  run,
  checkToolchain,
  probeDuration,
  probeStreams,
  concatCompatibility,
  fadeFilters,
  generateSilence,
  buildNarrationTrack,
  muxAudioVideo,
  imageToVideo,
  addMusicBed,
  deliver,
  hasSound,
  profileFor,
  burnSubtitles,
  concatDemuxer,
  concatFilter,
  concatSegments,
  escapeFilterValue,
};
