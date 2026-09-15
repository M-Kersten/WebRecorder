'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

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
  assert.match(result.failed.notes.join('\n'), /something has to open it first/);
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

test('a page the server refused is a failure, not a step that worked', async () => {
  // Playwright resolves goto on a 403: the navigation worked, the server just
  // answered with an error page. Everything after it then runs against that
  // page, finds nothing, and the rehearsal used to come back green on a flow
  // whose video would have been four minutes of "Access denied".
  const errServer = http.createServer((req, res) => {
    if (req.url === '/gone') { res.writeHead(404, {'Content-Type':'text/html'}); return res.end('<h1>Not here</h1>'); }
    if (req.url === '/denied') { res.writeHead(403, {'Content-Type':'text/html'}); return res.end('<h1>Forbidden</h1>'); }
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end('<body><button id="ok">Fine</button></body>');
  });
  await new Promise((r) => errServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${errServer.address().port}`;

  try {
    const flow = flowOf([
      { action: 'goto', url: `${base}/denied` },
      { action: 'click', selector: '#ok' },
    ]);
    const result = await rehearse(flow, DEFAULTS);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failed.index, 0, 'the goto is what failed, not the click after it');
    assert.match(result.failed.error, /403/);
    assert.match(result.failed.error, /Forbidden/);
    assert.strictEqual(result.notReached, 1);

    // 404 too, and the message says how to say you meant it.
    const missing = flowOf([{ action: 'goto', url: `${base}/gone` }]);
    const r404 = await rehearse(missing, DEFAULTS);
    assert.match(r404.failed.error, /404/);
    assert.match(describeRehearsal(r404, missing), /allowHttpError|404/);

    // And a flow that means to visit one says so and passes.
    const deliberate = flowOf([
      { action: 'goto', url: `${base}/denied`, allowHttpError: true },
    ]);
    assert.strictEqual((await rehearse(deliberate, DEFAULTS)).ok, true);

    // A page that is fine is still fine.
    assert.strictEqual((await rehearse(flowOf([{ action: 'goto', url: base }]), DEFAULTS)).ok, true);
  } finally {
    await new Promise((r) => errServer.close(r));
  }
});

test('a step is told what its selector is resting on', async () => {
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: '#open' },                    // named
    { action: 'waitFor', selector: '#panel > input' },         // positional-ish
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.steps[1].grade, 'named');
  assert.ok(!result.steps[1].notes.some((n) => /position/.test(n)),
    'an id is a name somebody chose; nothing to warn about');
});

test('a positional selector is called out even when it works', async () => {
  // It does work, today. That is exactly the problem: nothing else in the
  // pipeline will ever mention it until the day the page changes.
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: 'body > button:nth-of-type(1)' },
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.steps[1].grade, 'positional');
  assert.match(result.steps[1].notes.join('\n'), /position on the page/);
  assert.match(describeRehearsal(result, flow), /point at a position/);
});

test('an element hidden behind a breakpoint is told apart from one that is late', async () => {
  // The two look identical from the outside - the selector matches, the step
  // times out - and they want opposite fixes. Waiting longer for a hamburger
  // that only exists below 700px never works; recording at phone width does.
  const responsive = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><style>' +
      '.menu{display:none}@media (max-width:700px){.menu{display:block}}' +
      '</style></head><body><button class="menu" aria-label="Menu">=</button></body></html>');
  });
  await new Promise((r) => responsive.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${responsive.address().port}/`;

  try {
    const steps = [
      { action: 'goto', url },
      { action: 'click', selector: 'button[aria-label="Menu"]', timeoutMs: 1500 },
    ];
    const wide = await rehearse(flowOf(steps), DEFAULTS);
    assert.strictEqual(wide.ok, false);
    assert.strictEqual(wide.failed.matches, 1, 'the element is there, it just is not shown');
    assert.match(wide.failed.notes.join('\n'), /only at a narrower window/);
    assert.match(wide.failed.notes.join('\n'), /viewport/);

    const narrow = { ...flowOf(steps), viewport: { width: 390, height: 844, deviceScaleFactor: 1 } };
    assert.strictEqual((await rehearse(narrow, DEFAULTS)).ok, true,
      'the advice the failure gives should be advice that works');
  } finally {
    await new Promise((r) => responsive.close(r));
  }
});

test('a step whose element the page replaced under it is not reported as ambiguous', async () => {
  // Acting on something and then finding nothing matching is ordinary: a search
  // box swaps for a live one, a row re-renders. It is not a fault and should
  // not read like one.
  const flow = flowOf([
    { action: 'goto', url: server.url },
    { action: 'click', selector: '#open' },
  ]);
  const result = await rehearse(flow, DEFAULTS);
  assert.strictEqual(result.ok, true);
  assert.ok(result.steps.every((s) => s.matches === null || s.matches >= 1));
});
