'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uploads = require('../src/uploads');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-uploads-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

let n = 0;
const project = () => {
  const dir = path.join(work, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * The bytes are whatever was sent. The name decides where they land, so the
 * name is rebuilt rather than checked: everything below is one shape of the
 * same question, which is whether anything can escape the folder.
 */
test('a name is rebuilt, not trusted', () => {
  const cases = [
    ['logo.png', 'logo.png'],
    // The extension comes back lowercase, so "logo.PNG" and "logo.png" cannot
    // both sit in the folder looking like two different pictures.
    ['My Logo.PNG', 'My Logo.png'],
    ['../../etc/passwd.png', 'passwd.png'],
    ['C:\\Windows\\evil.png', 'evil.png'],
    ['a/b/../c.svg', 'c.svg'],
    ['/absolute/mark.svg', 'mark.svg'],
    ['h\u00e9llo w\u00f6rld!.png', 'h-llo w-rld.png'],
    ['....png', 'upload.png'],
  ];
  for (const [sent, want] of cases) {
    assert.strictEqual(uploads.safeName(sent, 'image'), want, sent);
  }
});

test('a name with nothing usable in it is refused, not guessed at', () => {
  for (const bad of ['', '.hidden', 'notes.txt', 'script.js', 'logo.png.exe']) {
    assert.throws(() => uploads.safeName(bad, 'image'), /is not a picture this can use/, bad);
  }
});

test('the kinds do not overlap', () => {
  assert.throws(() => uploads.safeName('sting.mp3', 'image'), /not a picture/);
  assert.throws(() => uploads.safeName('logo.png', 'sound'), /not a clip/);
  assert.strictEqual(uploads.safeName('sting.mp3', 'sound'), 'sting.mp3');
});

test('each kind lands in the folder that kind is read from', () => {
  const dir = project();
  assert.strictEqual(uploads.save(dir, 'image', 'logo.png', Buffer.from('x')), 'logo.png');
  assert.strictEqual(uploads.save(dir, 'sound', 'sting.mp3', Buffer.from('x')), 'sting.mp3');
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'logo.png')));
  assert.ok(fs.existsSync(path.join(dir, 'audio', 'sting.mp3')));
});

// A picker pointing at a file whose contents changed underneath it is a
// confusing way to lose work.
test('an upload steps aside rather than replacing what is there', () => {
  const dir = project();
  assert.strictEqual(uploads.save(dir, 'image', 'logo.png', Buffer.from('first')), 'logo.png');
  assert.strictEqual(uploads.save(dir, 'image', 'logo.png', Buffer.from('second')), 'logo-2.png');
  assert.strictEqual(uploads.save(dir, 'image', 'logo.png', Buffer.from('third')), 'logo-3.png');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'assets', 'logo.png'), 'utf8'), 'first');
});

test('an empty file and an oversized one are both turned away', () => {
  const dir = project();
  assert.throws(() => uploads.save(dir, 'image', 'logo.png', Buffer.alloc(0)), /was empty/);
  assert.throws(
    () => uploads.save(dir, 'image', 'logo.png', Buffer.alloc(9 * 1024 * 1024)),
    /9\.0 MB, and the limit is 8 MB/
  );
  assert.throws(() => uploads.save(dir, 'font', 'x.ttf', Buffer.from('x')), /nowhere to put/);
  assert.ok(!fs.existsSync(path.join(dir, 'assets', 'logo.png')));
});

// The whole point of the rebuild: whatever was sent, the file is in the folder.
test('nothing written lands outside the folder for its kind', () => {
  const dir = project();
  for (const sent of ['../../../tmp/x.png', '..\\..\\x.png', '/etc/x.png', './../x.png']) {
    const name = uploads.save(dir, 'image', sent, Buffer.from('x'));
    const landed = path.resolve(dir, 'assets', name);
    assert.ok(landed.startsWith(path.resolve(dir, 'assets') + path.sep), `${sent} -> ${landed}`);
  }
  assert.deepStrictEqual(
    fs.readdirSync(dir).sort(), ['assets'],
    'nothing was created beside the assets folder'
  );
});
