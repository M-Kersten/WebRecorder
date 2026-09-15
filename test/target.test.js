'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { framePath, timeoutFor, locate, describeTarget, DEFAULT_TIMEOUT_MS } = require('../src/target');
const { selectorsFor, dismissConsent, KNOWN } = require('../src/consent');
const { runStep } = require('../src/recorder');
const { buildOverlayScript } = require('../src/overlay');
const { launch } = require('../src/browser');
const { deepMerge, DEFAULTS } = require('../src/theme');

// --- the parts that need no browser ------------------------------------------

test('a frame can be named by selector, by url or by name', () => {
  assert.deepStrictEqual(framePath('#checkout'), ['#checkout']);
  assert.deepStrictEqual(framePath('url:stripe.com/v3'), ['iframe[src*="stripe.com/v3"]']);
  assert.deepStrictEqual(framePath('name:payment'), ['iframe[name="payment"]']);
  // Nesting: a widget inside a widget, which is how payment forms are built.
  assert.deepStrictEqual(framePath(['#outer', 'name:inner']),
    ['#outer', 'iframe[name="inner"]']);
  assert.deepStrictEqual(framePath(undefined), []);
});

test('a quote in a frame name cannot break out of the attribute selector', () => {
  const [sel] = framePath('name:pay"] , [id="anything');
  // Only the two quotes this module wrote may stand on their own. Every quote
  // that came from the value has to arrive escaped, or it closes the attribute
  // and whatever follows becomes selector rather than text.
  const bare = sel.replace(/\\./g, '');
  assert.strictEqual((bare.match(/"/g) || []).length, 2, `${sel} closes the attribute early`);
  assert.match(bare, /^iframe\[name="[^"]*"\]$/, `${sel} is no longer one attribute selector`);
});

test('a frame that is not a string is rejected rather than ignored', () => {
  assert.throws(() => framePath(42), /frame/);
  assert.throws(() => framePath(['   ']), /frame/);
});

test('the step decides its own budget, then the flow, then the default', () => {
  assert.strictEqual(timeoutFor({ timeoutMs: 500 }, { timeoutMs: 9000 }), 500);
  assert.strictEqual(timeoutFor({}, { timeoutMs: 9000 }), 9000);
  assert.strictEqual(timeoutFor({}, {}), DEFAULT_TIMEOUT_MS);
  // A zero is a real answer - "do not wait" - and must survive.
  assert.strictEqual(timeoutFor({ timeoutMs: 0 }, { timeoutMs: 9000 }), 0);
});

test('a target reads back the way it was written', () => {
  assert.strictEqual(describeTarget({ selector: '#pay' }), '#pay');
  assert.strictEqual(describeTarget({ selector: '#pay', frame: '#box' }), '#pay in #box');
  assert.strictEqual(describeTarget({}), '');
});

test('the built-in consent list can be extended or switched off', () => {
  assert.ok(KNOWN.includes('#onetrust-accept-btn-handler'));
  assert.strictEqual(selectorsFor({}).length, KNOWN.length);
  assert.deepStrictEqual(selectorsFor({ selectors: ['#mine'] }).slice(-1), ['#mine']);
  assert.deepStrictEqual(selectorsFor({ builtins: false, selectors: ['#mine'] }), ['#mine']);
  assert.deepStrictEqual(selectorsFor({ builtins: false }), []);
});

// --- the parts that need a real browser --------------------------------------

let browser;
test.before(async () => { browser = await launch({ headless: true }); }, { timeout: 120000 });
test.after(async () => { if (browser) await browser.close(); });

const THEME = deepMerge(DEFAULTS, {
  cursor: { enabled: false },
  highlight: { enabled: false },
  hints: { enabled: false },
});
const FLOW = { baseUrl: null, typeDelayMs: 1, settleMs: 0, steps: [] };

async function open(html, overrides = {}) {
  const theme = deepMerge(THEME, overrides);
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  await ctx.addInitScript(buildOverlayScript(theme, []));
  const page = await ctx.newPage();
  // A real navigation, not setContent. setContent replaces the document in
  // place, which throws away the mounted overlay *and* the listeners that would
  // remount it, so the page ends up with no cursor and the test measures the
  // harness rather than the code.
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: 'load' });
  return { page, theme, close: () => ctx.close() };
}

const INNER = '<body style="margin:0"><button id="pay" style="width:120px;height:40px">Pay</button>' +
  '<input id="card" style="width:200px"></body>';
const OUTER = (extra = '') => '<!doctype html><body style="margin:0">' +
  `<iframe id="widget" name="payment" srcdoc='${INNER}' ` +
  'style="position:absolute;left:100px;top:80px;width:400px;height:200px;border:0"></iframe>' +
  `${extra}</body>`;

test('a click reaches a button inside an iframe', async () => {
  const { page, theme, close } = await open(OUTER());
  try {
    await page.frameLocator('#widget').locator('#pay').evaluate((el) => {
      el.addEventListener('click', () => { el.textContent = 'Paid'; });
    });
    // Without a frame, the selector cannot see it at all. That is the gap.
    assert.strictEqual(await page.locator('#pay').count(), 0);

    await runStep(page, { action: 'click', selector: '#pay', frame: '#widget' }, FLOW, theme);
    assert.strictEqual(await page.frameLocator('#widget').locator('#pay').textContent(), 'Paid');
  } finally {
    await close();
  }
});

test('typing inside an iframe lands in the field, not on the page behind it', async () => {
  const { page, theme, close } = await open(OUTER('<input id="card" style="width:200px">'));
  try {
    await runStep(page, {
      action: 'type', selector: '#card', frame: 'name:payment', text: '4242',
    }, FLOW, theme);
    assert.strictEqual(await page.frameLocator('#widget').locator('#card').inputValue(), '4242');
    // The identically-named field on the outer page is untouched.
    assert.strictEqual(await page.locator('#card').inputValue(), '');
  } finally {
    await close();
  }
});

test('a hint can be anchored to something inside a frame, in page coordinates', async () => {
  const { page, theme, close } = await open(OUTER());
  try {
    const rect = await runStep(page, { action: 'click', selector: '#pay', frame: '#widget' },
      FLOW, theme);
    // The iframe sits at 100,80, so a box reported relative to the frame would
    // start at 0,0 and the ring would land in the top-left corner of the video.
    assert.ok(rect, 'the step should report where it acted');
    assert.ok(rect.x >= 100, `x was ${rect.x}, which is the frame's own origin`);
    assert.ok(rect.y >= 80, `y was ${rect.y}, which is the frame's own origin`);
  } finally {
    await close();
  }
});

test('the cursor is not mounted a second time inside an iframe', async () => {
  const { page, close } = await open(OUTER(), { cursor: { enabled: true } });
  try {
    await page.waitForFunction(() => window.__tutOverlayReady === true);
    assert.strictEqual(await page.locator('[data-tut-cursor]').count(), 1);
    assert.strictEqual(
      await page.frameLocator('#widget').locator('[data-tut-cursor]').count(), 0,
      'a second pointer inside the widget would be clipped to its box and offset from the real one'
    );
  } finally {
    await close();
  }
});

test('waitFor holds until the thing arrives, and reports where it is', async () => {
  const { page, theme, close } = await open(
    '<!doctype html><body style="margin:0"><script>' +
    'setTimeout(() => { const d = document.createElement("div");' +
    'd.id = "late"; d.textContent = "Report ready";' +
    'd.style.cssText = "position:absolute;left:50px;top:60px;width:300px;height:40px";' +
    'document.body.appendChild(d); }, 700);' +
    '</script></body>'
  );
  try {
    const started = Date.now();
    const rect = await runStep(page, { action: 'waitFor', selector: '#late' }, FLOW, theme);
    const waited = Date.now() - started;
    assert.ok(waited >= 650, `it returned after ${waited}ms, before the element existed`);
    assert.ok(rect && rect.x >= 50, 'it should report the box so a hint can be anchored');
  } finally {
    await close();
  }
});

test('waitFor can wait for something to go away', async () => {
  const { page, theme, close } = await open(
    '<!doctype html><body style="margin:0"><div id="spinner">Loading</div><script>' +
    'setTimeout(() => document.getElementById("spinner").remove(), 500);' +
    '</script></body>'
  );
  try {
    const rect = await runStep(page, { action: 'waitFor', selector: '#spinner', state: 'detached' },
      FLOW, theme);
    assert.strictEqual(await page.locator('#spinner').count(), 0);
    assert.strictEqual(rect, null, 'there is nothing left to anchor a hint to');
  } finally {
    await close();
  }
});

test('a wait that never comes says what it was waiting for', async () => {
  const { page, theme, close } = await open('<!doctype html><body></body>');
  try {
    await assert.rejects(
      runStep(page, { action: 'waitFor', selector: '#never', timeoutMs: 400 }, FLOW, theme),
      /#never/
    );
  } finally {
    await close();
  }
});

test('a step can be given more time than the flow allows', async () => {
  const { page, theme, close } = await open(
    '<!doctype html><body><script>setTimeout(() => {' +
    'const d = document.createElement("div"); d.id = "slow"; d.textContent = "x";' +
    'document.body.appendChild(d); }, 600);</script></body>'
  );
  try {
    const impatient = { ...FLOW, timeoutMs: 200 };
    await assert.rejects(
      runStep(page, { action: 'waitFor', selector: '#slow' }, impatient, theme), /#slow/);
    await runStep(page, { action: 'waitFor', selector: '#slow', timeoutMs: 5000 }, impatient, theme);
  } finally {
    await close();
  }
});

test('a consent banner is taken down before anything is recorded', async () => {
  const { page, close } = await open(
    '<!doctype html><body style="margin:0">' +
    '<div id="wall" style="position:fixed;inset:0;background:#000">' +
    '<button id="onetrust-accept-btn-handler">Accept</button></div>' +
    '<script>document.getElementById("onetrust-accept-btn-handler")' +
    '.addEventListener("click", () => document.getElementById("wall").remove());</script>' +
    '</body>'
  );
  try {
    const lines = [];
    const hit = await dismissConsent(page, { builtins: true }, { log: (m) => lines.push(m) });
    assert.strictEqual(hit, '#onetrust-accept-btn-handler');
    assert.strictEqual(await page.locator('#wall').count(), 0);
    assert.match(lines.join('\n'), /consent/);
  } finally {
    await close();
  }
});

test('a banner that appears a beat after the page does is still caught', async () => {
  const { page, close } = await open(
    '<!doctype html><body style="margin:0"><script>setTimeout(() => {' +
    'const b = document.createElement("button"); b.id = "onetrust-accept-btn-handler";' +
    'b.textContent = "Accept"; b.onclick = () => b.remove();' +
    'document.body.appendChild(b); }, 500);</script></body>'
  );
  try {
    const hit = await dismissConsent(page, { builtins: true }, { timeoutMs: 3000 });
    assert.strictEqual(hit, '#onetrust-accept-btn-handler');
  } finally {
    await close();
  }
});

test('a page with no banner is not held up, and markup left behind is not clicked', async () => {
  // Every one of these scripts leaves its dialog in the document once the
  // choice has been remembered. Presence is not the test; being on screen is.
  const { page, close } = await open(
    '<!doctype html><body><div style="display:none">' +
    '<button id="onetrust-accept-btn-handler" onclick="window.__clicked = true">Accept</button>' +
    '</div></body>'
  );
  try {
    const started = Date.now();
    const hit = await dismissConsent(page, { builtins: true }, { timeoutMs: 600 });
    const waited = Date.now() - started;
    assert.strictEqual(hit, null);
    assert.strictEqual(await page.evaluate(() => window.__clicked), undefined);
    // One budget for the whole list, not one per selector.
    assert.ok(waited < 2500, `a page with no banner cost ${waited}ms`);
  } finally {
    await close();
  }
});

test('a consent wall inside an iframe can be named and dismissed', async () => {
  const { page, close } = await open(
    '<!doctype html><body style="margin:0">' +
    `<iframe id="cmp" srcdoc='<body><button id="agree" onclick="this.remove()">OK</button></body>' ` +
    'style="width:400px;height:200px"></iframe></body>'
  );
  try {
    const hit = await dismissConsent(page,
      { builtins: false, selectors: ['#agree'], frames: ['#cmp'] }, { timeoutMs: 2000 });
    assert.strictEqual(hit, '#agree');
    assert.strictEqual(await page.frameLocator('#cmp').locator('#agree').count(), 0);
  } finally {
    await close();
  }
});

test('an invalid selector in somebody list does not stop the rest of it', async () => {
  const { page, close } = await open(
    '<!doctype html><body><button id="ok" onclick="this.remove()">OK</button></body>'
  );
  try {
    const hit = await dismissConsent(page,
      { builtins: false, selectors: ['>>> not a selector <<<', '#ok'] }, { timeoutMs: 1000 });
    assert.strictEqual(hit, '#ok');
  } finally {
    await close();
  }
});

test('locate is null for a step with nothing to point at', () => {
  assert.strictEqual(locate({}, { action: 'wait' }), null);
});

test('a step acts on the button a viewer can see, not the one in a closed panel', async () => {
  // The same markup twice is the ordinary case on a responsive site: a mobile
  // menu and a desktop menu, a modal and the page behind it. The hidden copy is
  // usually first in the document, so .first() alone picks the wrong one.
  const { page, theme, close } = await open(
    '<!doctype html><body style="margin:0">' +
    '<div hidden><button class="save" onclick="window.__hit = \'hidden\'">Save</button></div>' +
    '<button class="save" onclick="window.__hit = \'visible\'">Save</button></body>'
  );
  try {
    await runStep(page, { action: 'click', selector: '.save' }, FLOW, theme);
    assert.strictEqual(await page.evaluate(() => window.__hit), 'visible');
  } finally {
    await close();
  }
});

test('waiting for something to disappear looks at every match, not the visible ones', async () => {
  const { page, theme, close } = await open(
    '<!doctype html><body><div id="spinner">Loading</div><script>' +
    'setTimeout(() => { document.getElementById("spinner").hidden = true; }, 400);' +
    '</script></body>'
  );
  try {
    const started = Date.now();
    await runStep(page, { action: 'waitFor', selector: '#spinner', state: 'hidden' }, FLOW, theme);
    assert.ok(Date.now() - started >= 350,
      'it returned before the spinner was hidden, which means it asked the wrong question');
  } finally {
    await close();
  }
});
