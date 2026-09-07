'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { interpolate, resolveFlowSecrets, hasPlaceholder, REDACTED } = require('../src/secrets');
const { loadFlow } = require('../src/config');
const { describeStep } = require('../src/recorder');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-secrets-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

let n = 0;
function withFlow(obj) {
  const file = path.join(work, `flow-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return loadFlow(file);
}
const goto = { action: 'goto', url: '/' };

test('placeholders are replaced from the environment', () => {
  assert.strictEqual(interpolate('https://${HOST}/in', { HOST: 'a.test' }, 'x'), 'https://a.test/in');
  assert.strictEqual(interpolate('${A}-${B}', { A: '1', B: '2' }, 'x'), '1-2');
  assert.strictEqual(interpolate('nothing here', {}, 'x'), 'nothing here');
});

test('an unset variable is an error naming the variable and where it was used', () => {
  assert.throws(
    () => interpolate('${PORTAL_PASSWORD}', {}, 'flow.json: steps[3].text'),
    /steps\[3\]\.text uses \$\{PORTAL_PASSWORD\}, but that environment variable is not set/
  );
  // Empty counts as unset: substituting "" would type nothing and fail later,
  // somewhere far less obvious.
  assert.throws(() => interpolate('${X}', { X: '' }, 'x'), /not set/);
});

// A /g regex carries lastIndex between calls, so .test() on a shared one
// alternates true and false on identical input.
test('detecting a placeholder gives the same answer every time', () => {
  assert.deepStrictEqual([1, 2, 3, 4].map(() => hasPlaceholder('${A}')), [true, true, true, true]);
  assert.deepStrictEqual([1, 2].map(() => hasPlaceholder('plain')), [false, false]);
});

test('a flow reports which variables it used', () => {
  const flow = {
    path: 'f.json',
    baseUrl: 'https://${HOST}',
    steps: [{ action: 'type', text: '${PW}' }, { action: 'goto', url: '/x' }],
  };
  const used = resolveFlowSecrets(flow, { HOST: 'a.test', PW: 'hunter2' });
  assert.deepStrictEqual(used.sort(), ['HOST', 'PW']);
  assert.strictEqual(flow.baseUrl, 'https://a.test');
  assert.strictEqual(flow.steps[0].text, 'hunter2');
});

test('auth steps are resolved too', () => {
  const flow = {
    path: 'f.json',
    steps: [{ action: 'goto', url: '/' }],
    auth: { steps: [{ action: 'type', text: '${PW}' }] },
  };
  resolveFlowSecrets(flow, { PW: 'hunter2' });
  assert.strictEqual(flow.auth.steps[0].text, 'hunter2');
  assert.strictEqual(flow.auth.steps[0].secret, true);
});

// The whole point is that the password does not end up written down anywhere.
test('a step whose text came from the environment never prints its value', () => {
  const flow = {
    path: 'f.json',
    steps: [
      { action: 'type', selector: '#pw', text: '${PW}' },
      { action: 'type', selector: '#q', text: 'ordinary' },
    ],
  };
  resolveFlowSecrets(flow, { PW: 'hunter2' });

  const secret = describeStep(flow.steps[0]);
  assert.ok(!secret.includes('hunter2'), `leaked the value: ${secret}`);
  assert.ok(secret.includes(REDACTED));
  assert.ok(secret.includes('#pw'), 'the selector still shows, so the log is useful');

  assert.ok(describeStep(flow.steps[1]).includes('ordinary'), 'ordinary text is not hidden');
});

test('mask rules are validated, and default to blur', () => {
  const flow = withFlow({ steps: [goto], mask: [{ selector: '.name' }] });
  assert.deepStrictEqual(flow.mask, [{ selector: '.name', mode: 'blur', text: '', radius: 10 }]);
  assert.deepStrictEqual(withFlow({ steps: [goto] }).mask, [], 'no mask is fine');
});

test('a mask rule with an unknown mode explains the ones that exist', () => {
  assert.throws(
    () => withFlow({ steps: [goto], mask: [{ selector: '.x', mode: 'pixelate' }] }),
    /mode "pixelate". Use one of: blur, hide, text/
  );
  assert.throws(() => withFlow({ steps: [goto], mask: [{ mode: 'blur' }] }), /needs a CSS "selector"/);
  assert.throws(
    () => withFlow({ steps: [goto], mask: [{ selector: '.x', mode: 'text' }] }),
    /needs a "text" replacement/
  );
});

test('an auth block is validated like the steps it contains', () => {
  const flow = withFlow({
    steps: [goto],
    auth: { steps: [{ action: 'click', selector: '#in' }] },
  });
  assert.strictEqual(flow.auth.stateFile, '.auth/session.json', 'a default place to keep it');
  assert.strictEqual(flow.auth.maxAgeHours, 12);

  assert.throws(() => withFlow({ steps: [goto], auth: { steps: [] } }), /auth\.steps must be a non-empty array/);
  assert.throws(
    () => withFlow({ steps: [goto], auth: { steps: [{ action: 'teleport' }] } }),
    /auth\.steps\[0\] has unknown action "teleport"/
  );
  assert.throws(
    () => withFlow({ steps: [goto], auth: { steps: [{ action: 'click' }] } }),
    /auth\.steps\[0\] \(action "click"\) is missing required field "selector"/
  );
});

test('the portal example flow loads once its variables are set', () => {
  const flow = loadFlow(path.join(__dirname, '..', 'demo', 'portal-flow.json'));
  const used = resolveFlowSecrets(flow, { PORTAL_EMAIL: 'a@b.test', PORTAL_PASSWORD: 'x' });
  assert.deepStrictEqual(used.sort(), ['PORTAL_EMAIL', 'PORTAL_PASSWORD']);
  assert.ok(flow.mask.length >= 3, 'it should demonstrate masking');
  assert.ok(flow.auth.steps.length, 'and logging in');
});
