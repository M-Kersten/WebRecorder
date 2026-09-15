'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rehearse, describeRehearsal } = require('../src/rehearse');
const { serveStatic } = require('../src/server');
const { DEFAULTS } = require('../src/theme');

let site, server;

test.before(async () => {
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-rehearse-'));
  fs.writeFileSync(path.join(site, 'index.html'),
    '<!doctype html><body style="margin:0">' +
    '<button id="open" onclick="document.getElementById(\'panel\').hidden = false">Open</button>' +
    '<div id="panel" hidden><input id="name"><button class="save">Save</button></div>' +
    '<button class="save">Save draft</button>' +
    '</body>');
  server = await serveStatic(site);
}, { timeout: 120000 });

test.after(async () => {
  if (server) await server.close();
  if (site) fs.rmSync(site, { recursive: true, force: true });
});

const flowOf = (steps) => ({
  baseUrl: null, steps, settleMs: 0, typeDelayMs: 1, timeoutMs: 1500,
  dismiss: { builtins: false, selectors: [], frames: [] },
});

test('a flow that works reports every step, with a time for each', async () => {
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: '#open' },
    { action: 'waitFor', selector: '#panel' },
    { action: 'type', selector: '#name', text: 'Merijn' },
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, true, JSON.stringify(result.failed));
  assert.strictEqual(result.steps.length, 4);
  assert.strictEqual(result.notReached, 0);
  assert.ok(result.steps.every((s) => s.ok));
  assert.ok(result.steps.every((s) => s.ms >= 0));
  assert.match(describeRehearsal(result, flow), /All 4 steps ran/);
});

test('a renamed selector is named, and the rest is not guessed at', async () => {
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: '#open-v2' },
    { action: 'click', selector: '#name' },
    { action: 'click', selector: '#name' },
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed.index, 1);
  assert.strictEqual(result.failed.matches, 0);
  assert.strictEqual(result.notReached, 2, 'the steps after a failure were not tried');

  const text = describeRehearsal(result, flow);
  assert.match(text, /Step 2 of 4/);
  assert.match(text, /nothing on the page matches/);
  assert.match(text, /2 later steps were not tried/);
});

test('an element that exists but is not ready is told apart from one that is gone', async () => {
  // #name is in the document from the start; it is inside a hidden panel.
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: '#name' },
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed.matches, 1);
  assert.match(result.failed.notes.join('\n'), /waitFor step before this one/);
});

test('a selector that matches more than one element is flagged, not failed', async () => {
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: '.save' },
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, true, 'the recording would still work, using the first');
  assert.strictEqual(result.steps[1].matches, 2);
  assert.match(describeRehearsal(result, flow), /matches 2 elements/);
});

test('a rehearsal leaves no video behind and needs no narration', async () => {
  const flow = flowOf([{ action: 'goto', url: server.url }]);
  const before = fs.readdirSync(site).length;
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.readdirSync(site).length, before);
});
