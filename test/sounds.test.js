'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sounds = require('../src/sounds');

function project(names = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-sounds-'));
  if (names.length) fs.mkdirSync(sounds.dirFor(dir));
  for (const name of names) fs.writeFileSync(path.join(sounds.dirFor(dir), name), 'pretend audio');
  return dir;
}

test('the folder is the library, and the file name is the label', () => {
  const dir = project(['soft-loop.mp3', 'brand_sting.wav', 'Q Portal outro.m4a', 'notes.txt']);
  try {
    // Sorted the way a person reads a list, not the way ASCII does.
    assert.deepStrictEqual(sounds.scan(dir), [
      { file: 'brand_sting.wav', label: 'Brand sting' },
      { file: 'Q Portal outro.m4a', label: 'Q Portal outro' },
      { file: 'soft-loop.mp3', label: 'Soft loop' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project with no audio folder simply has no clips', () => {
  const dir = project();
  try {
    assert.deepStrictEqual(sounds.scan(dir), []);
    assert.strictEqual(sounds.fileFor(dir, 'anything.mp3'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A clip is named in a theme, and a theme can be edited by hand. A name is all
// it may be: the renderer has no business reading elsewhere on the machine.
test('a name that is not a plain clip in the folder resolves to nothing', () => {
  const dir = project(['ok.mp3']);
  try {
    fs.writeFileSync(path.join(dir, 'secret.json'), 'shh');
    assert.ok(sounds.fileFor(dir, 'ok.mp3'), 'the real one resolves');
    for (const bad of ['../secret.json', '/etc/passwd', 'sub/ok.mp3', 'ok.mp3.js',
      'missing.mp3', '', null, 42]) {
      assert.strictEqual(sounds.fileFor(dir, bad), null, `${bad} must not resolve`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every format ffmpeg can read is offered', () => {
  const dir = project(['a.mp3', 'b.m4a', 'c.wav', 'd.ogg', 'e.opus', 'f.aac', 'g.flac', 'h.mid']);
  try {
    assert.deepStrictEqual(sounds.scan(dir).map((s) => s.file),
      ['a.mp3', 'b.m4a', 'c.wav', 'd.ogg', 'e.opus', 'f.aac', 'g.flac']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A repository using LFS for its audio hands anyone who clones without LFS a
// hundred bytes of text with an .mp3 on the end.
test('a Git LFS pointer is recognised for what it is', () => {
  const dir = project(['real.mp3', 'pointer.mp3']);
  try {
    fs.writeFileSync(path.join(sounds.dirFor(dir), 'pointer.mp3'),
      'version https://git-lfs.github.com/spec/v1\n' +
      'oid sha256:c9daa0abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123\n' +
      'size 214092\n');

    assert.strictEqual(sounds.isPointer(path.join(sounds.dirFor(dir), 'pointer.mp3')), true);
    assert.strictEqual(sounds.isPointer(path.join(sounds.dirFor(dir), 'real.mp3')), false);
    assert.strictEqual(sounds.isPointer('/nowhere/at/all.mp3'), false);

    // It is still offered: the name is right, only the bytes are missing, and
    // the message that says so comes when a style actually names it.
    assert.strictEqual(sounds.scan(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
