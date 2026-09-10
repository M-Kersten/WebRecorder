'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkDir, removeWorkDir } = require('../src/workdir');

test('a work directory is made under the system temp folder', () => {
  const dir = createWorkDir();
  try {
    assert.ok(fs.existsSync(dir));
    assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())) || dir.startsWith(os.tmpdir()));
    assert.match(path.basename(dir), /^tutvid-/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing one takes its contents with it', () => {
  const dir = createWorkDir();
  fs.mkdirSync(path.join(dir, 'raw-video'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'raw-video', 'clip.webm'), 'x');
  assert.strictEqual(removeWorkDir(dir), true);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('removing something that is already gone is fine', () => {
  assert.strictEqual(removeWorkDir(path.join(os.tmpdir(), 'tutvid-never-existed')), true);
  assert.strictEqual(removeWorkDir(null), true);
  assert.strictEqual(removeWorkDir(''), true);
});

test('it asks Node to retry, which is what makes it work on Windows', () => {
  // A browser or ffmpeg that just exited can still hold a handle inside for a
  // moment; Node retries on exactly those errors when told to.
  const dir = createWorkDir();
  const real = fs.rmSync;
  let options = null;
  fs.rmSync = (target, opts) => { options = opts; return real(target, opts); };
  try {
    removeWorkDir(dir);
  } finally {
    fs.rmSync = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(options.maxRetries > 0, 'retries are requested');
  assert.ok(options.retryDelay > 0, 'with a wait between them');
  assert.strictEqual(options.recursive, true);
});

// This is the one that matters. It runs in a finally, after the video is
// already finished, so an exception here would replace the result.
test('a cleanup that cannot succeed reports false instead of throwing', () => {
  const real = fs.rmSync;
  const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  fs.rmSync = () => { throw denied; };
  const said = [];
  try {
    let result;
    assert.doesNotThrow(() => { result = removeWorkDir('/some/locked/folder', (m) => said.push(m)); });
    assert.strictEqual(result, false);
  } finally {
    fs.rmSync = real;
  }
  assert.strictEqual(said.length, 1, 'it says so once');
  assert.match(said[0], /EPERM/);
  assert.match(said[0], /deleted by hand/, 'and tells the user what they can do about it');
});

// The bug this all comes from: on Windows the delete came back EPERM, and
// because it ran in a finally with nothing catching it, the exception replaced
// the result. The video was on disk and the run reported a failure.
test('a finished video survives a cleanup that fails', async (t) => {
  const { main, setOutput } = require('../src/index');
  const { serveStatic } = require('../src/server');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-eperm-'));
  const server = await serveStatic(path.join(__dirname, '..', 'demo', 'portal'), 8277);
  const outFile = path.join(dir, 'video.mp4');

  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
    intro: { enabled: false }, outro: { enabled: false },
    captions: { enabled: false }, hints: { enabled: false },
    transitions: { enabled: false },
    video: { width: 640, height: 360, fps: 15 },
  }));
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify({
    baseUrl: server.url,
    minStepMs: 400,
    stepPaddingMs: 0,
    steps: [{ action: 'goto', url: '/dashboard.html?auth=1' }],
  }));

  const real = fs.rmSync;
  const said = [];
  setOutput((m) => said.push(m));
  // Refuse to delete the work directory, exactly as Windows did.
  fs.rmSync = (target, opts) => {
    if (String(target).includes('tutvid-') && !String(target).includes('tutvid-eperm-')) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return real(target, opts);
  };

  let code;
  try {
    code = await main([
      '--flow', path.join(dir, 'flow.json'),
      '--theme', path.join(dir, 'theme.json'),
      '--out', outFile, '--no-tts',
    ]);
  } finally {
    fs.rmSync = real;
    setOutput(null);
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.strictEqual(code, 0, `the run should still succeed:\n${said.join('\n')}`);
  assert.ok(said.some((m) => /could not clean up/.test(m)),
    'and should mention the folder it left behind');
});
