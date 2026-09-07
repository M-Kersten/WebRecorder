'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/**
 * Run a binary and buffer its output. Rejects with the tail of stderr, which is
 * where ffmpeg puts the one line that actually explains the failure.
 */
function run(bin, args, { label } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Verify ffmpeg/ffprobe exist and carry the features this tool depends on. */
async function checkToolchain() {
  let filters;
  try {
    ({ stdout: filters } = await run(FFMPEG, ['-hide_banner', '-filters']));
  } catch (err) {
    throw new Error(
      `ffmpeg is required but not usable.\n${err.message}\n` +
      'Install it (e.g. "apt-get install ffmpeg" or "brew install ffmpeg"), ' +
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
async function muxAudioVideo(videoFile, audioFile, outFile, video) {
  const { width, height, fps } = video;
  await ffmpeg([
    '-i', videoFile,
    '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
           `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/** A still image as a video segment, with the same streams as the main clip. */
async function imageToVideo(imageFile, durationSec, outFile, video) {
  const { width, height, fps } = video;
  await ffmpeg([
    '-loop', '1', '-i', imageFile,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', durationSec.toFixed(3),
    '-vf', `scale=${width}:${height},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
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
async function burnSubtitles(videoFile, srtFile, forceStyle, fontsDir, outFile) {
  const opts = [`filename=${escapeFilterPath(srtFile)}`];
  if (fontsDir) opts.push(`fontsdir=${escapeFilterPath(fontsDir)}`);
  if (forceStyle) opts.push(`force_style=${escapeFilterValue(forceStyle)}`);
  await ffmpeg([
    '-i', videoFile,
    '-vf', `subtitles=${opts.join(':')}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/**
 * Stream-copy concat. Fast and lossless, but the demuxer refuses anything but
 * an exact codec/timebase match, so callers fall back to concatFilter.
 */
async function concatDemuxer(segments, outFile, workDir) {
  const listFile = path.join(workDir, 'concat-list.txt');
  const body = segments
    .map((s) => `file '${path.resolve(s).replace(/'/g, "'\\''")}'`)
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
async function concatFilter(segments, outFile, video) {
  const { width, height, fps } = video;
  const inputs = [];
  const pre = [];
  segments.forEach((seg, i) => {
    inputs.push('-i', seg);
    pre.push(`[${i}:v]scale=${width}:${height},fps=${fps},format=yuv420p,setsar=1[v${i}]`);
    pre.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const labels = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  const graph = `${pre.join(';')};${labels}concat=n=${segments.length}:v=1:a=1[v][a]`;
  await ffmpeg([
    ...inputs,
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outFile,
  ]);
  return outFile;
}

/**
 * Join segments, preferring the stream-copy demuxer and falling back to the
 * filter when the segments will not line up.
 */
async function concatSegments(segments, outFile, video, workDir, log = () => {}) {
  if (segments.length === 1) {
    fs.copyFileSync(segments[0], outFile);
    return { outFile, method: 'copy' };
  }
  try {
    await concatDemuxer(segments, outFile, workDir);
    return { outFile, method: 'demuxer' };
  } catch (err) {
    log(`concat demuxer refused the segments, re-encoding instead (${firstLine(err.message)})`);
    await concatFilter(segments, outFile, video);
    return { outFile, method: 'filter' };
  }
}

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) || '';

/** ffmpeg filter args: ':' and '\' are structural, and Windows drive colons bite. */
function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** A filter option value that itself contains commas has to be single-quoted. */
function escapeFilterValue(v) {
  return `'${String(v).replace(/'/g, "\\'")}'`;
}

module.exports = {
  ffmpeg,
  run,
  checkToolchain,
  probeDuration,
  generateSilence,
  buildNarrationTrack,
  muxAudioVideo,
  imageToVideo,
  burnSubtitles,
  concatDemuxer,
  concatFilter,
  concatSegments,
  escapeFilterPath,
  escapeFilterValue,
};
