'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shots = require('../src/shots');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-shots-'));
  const flowFile = path.join(dir, 'flow.json');
  fs.writeFileSync(flowFile, '{"steps":[]}');
  return { dir, flowFile };
}

function put(flowFile, name) {
  fs.mkdirSync(shots.dirFor(flowFile), { recursive: true });
  fs.writeFileSync(path.join(shots.dirFor(flowFile), name), 'not really a jpeg');
}

test('a flow with no pictures reads as a flow with no pictures', () => {
  const { flowFile } = scratch();
  assert.deepStrictEqual(shots.readManifest(flowFile), []);
  assert.strictEqual(shots.fileFor(flowFile, '1.jpg'), null);
});

test('the manifest lines pictures up with steps, gaps included', () => {
  const { flowFile } = scratch();
  put(flowFile, '1.jpg');
  put(flowFile, '3.jpg');
  shots.writeManifest(flowFile, ['1.jpg', null, '3.jpg']);
  assert.deepStrictEqual(shots.readManifest(flowFile), ['1.jpg', null, '3.jpg']);
  assert.ok(shots.fileFor(flowFile, '3.jpg'), 'the file behind a named step is servable');
});

// Re-recording replaces the walkthrough. Leaving the old pictures behind means
// a later manifest could point at a step that no longer exists.
test('pictures no step refers to are deleted', () => {
  const { flowFile } = scratch();
  put(flowFile, '1.jpg');
  put(flowFile, '2.jpg');
  put(flowFile, '3.jpg');
  shots.writeManifest(flowFile, ['2.jpg']);
  assert.deepStrictEqual(fs.readdirSync(shots.dirFor(flowFile)).sort(), ['2.jpg']);
});

// The manifest is a file on disk. Nothing in it should be able to talk the
// server into handing out something that is not one of these thumbnails.
test('a name that is not a plain thumbnail resolves to nothing', () => {
  const { flowFile, dir } = scratch();
  fs.writeFileSync(path.join(dir, 'secret.json'), 'shh');
  for (const bad of ['../secret.json', '/etc/passwd', 'a/b.jpg', '1.jpg.js', '', null, 42]) {
    assert.strictEqual(shots.fileFor(flowFile, bad), null, `${bad} must not resolve`);
  }
});

test('a manifest holding junk is read as holding nothing', () => {
  const { flowFile } = scratch();
  fs.writeFileSync(shots.manifestFor(flowFile), '{"shots":["../x.jpg",{},"ok.jpg"]}');
  assert.deepStrictEqual(shots.readManifest(flowFile), [null, null, 'ok.jpg']);

  fs.writeFileSync(shots.manifestFor(flowFile), 'not json at all');
  assert.deepStrictEqual(shots.readManifest(flowFile), []);
});

test('a screenshot that cannot be taken costs a thumbnail and nothing else', async () => {
  const { flowFile } = scratch();
  const brokenPage = { screenshot: () => Promise.reject(new Error('navigating')) };
  assert.strictEqual(await shots.grab(brokenPage, flowFile, 1), null);
});
