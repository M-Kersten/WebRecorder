'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { verifyKey, estimateDuration } = require('../src/tts');

/** A stand-in for fetch that answers however the test needs it to. */
const answers = (result) => (url, init) => {
  answers.lastUrl = url;
  answers.lastKey = init && init.headers && init.headers['xi-api-key'];
  return typeof result === 'function' ? result() : Promise.resolve(result);
};

test('a key ElevenLabs accepts comes back accepted', async () => {
  const check = await verifyKey('sk_good', answers({ ok: true, status: 200 }));
  assert.strictEqual(check.state, 'accepted');
  assert.strictEqual(answers.lastKey, 'sk_good', 'sent as the api key header, not in the url');
  assert.ok(!String(answers.lastUrl).includes('sk_good'), 'and never in the url');
});

test('a key it turns down is rejected, and says so', async () => {
  for (const status of [401, 403]) {
    const check = await verifyKey('sk_bad', answers({ ok: false, status }));
    assert.strictEqual(check.state, 'rejected');
    assert.match(check.reason, new RegExp(String(status)));
  }
});

test('an empty box is rejected without asking anyone', async () => {
  const never = () => { throw new Error('should not have been called'); };
  assert.strictEqual((await verifyKey('', never)).state, 'rejected');
  assert.strictEqual((await verifyKey(null, never)).state, 'rejected');
});

// Being offline is not the key's fault. Answering "rejected" here would leave
// somebody on a locked-down network unable to set a key up at all.
test('a network that cannot be reached leaves the verdict open', async () => {
  const offline = await verifyKey('sk_maybe', answers(() => Promise.reject(new Error('fetch failed\nENOTFOUND'))));
  assert.strictEqual(offline.state, 'unchecked');
  assert.strictEqual(offline.reason, 'fetch failed', 'the first line, not a stack');

  const wobbly = await verifyKey('sk_maybe', answers({ ok: false, status: 503 }));
  assert.strictEqual(wobbly.state, 'unchecked');
});

// The recorder holds a step for as long as its line takes to say, so this
// number and the one the storyboard shows have to be the same number.
test('the spoken-length estimate is the shared one', () => {
  const { estimateDuration: shared } = require('../src/pacing');
  assert.strictEqual(estimateDuration, shared);
});
