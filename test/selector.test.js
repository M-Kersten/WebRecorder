'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SELECTOR_SCRIPT } = require('../src/selector');

/**
 * The selector script is written to run inside a page, so it is evaluated here
 * the same way the browser evaluates it and its internals are handed back.
 */
const inPage = new Function('window', 'document',
  `${SELECTOR_SCRIPT}; return { looksGenerated, tokens, randomLooking };`)({}, {});

/**
 * Class names a build tool made up.
 *
 * The ones marked with a site are real, collected by pointing the tool at that
 * site and asking capture mode what selector it would write. Every one of them
 * changes on the next deploy, and every one of them passed the earlier check,
 * which looked for six hex characters in a row - what a hash looked like when
 * hashes were md5 prefixes.
 */
const GENERATED = [
  'SkipLinks-module-scss-module___IfRCG__skipLink',   // nos.nl
  'SkipLink-module-scss-module__n5hZGa__skipLink',    // nos.nl
  'LSqk9q_root',                                      // linear.app
  '⚙1fpnohr',                                         // docs.stripe.com
  'css-1x2y3z',                                       // emotion
  'sc-bdVaJa',                                        // styled-components
  'styles__Wrapper-sc-1x2y3z',
  'jsx-283749',
  'makeStyles-root-12',
  'svelte-1a2b3c',
  'Tooltip_tooltip__qP3xZ',                           // CSS modules
  '_3xY7kQ',
  'a1b2c3d4',
  'x9Jk2Lm',
  'ZmQ4NTk',
  'hL9kPq2',
  '_1a2B3c',
];

/**
 * And names a person typed. Rejecting one of these is the worse failure: it
 * throws away the only readable handle on the element and drops the selector to
 * a positional path, which breaks the moment anything above it moves.
 */
const AUTHORED = [
  'btn-primary', 'nav-link', 'card', 'SkipLink', 'site-header', 'is-active',
  'col-md-6', 'text-2xl', 'bg-blue-500', 'mw-jump-link', 'u-hidden', 'js-toggle',
  'header__title', 'ProductCard', 'Button', 'searchInput', 'main-content',
  'sidebar', 'tile', 'dropdown-menu', 'form-control', 'visually-hidden',
  'MuiButton', 'accordion-item', 'grid', 'row', 'col', 'active', 'open',
  'selected', 'disabled', 'primary', 'breadcrumb', 'hero', 'cta-button',
  'pagination', 'avatar', 'dataTable', 'userProfile', 'sr-only', 'clearfix',
  'table-striped', 'grid-cols-12', 'base64', 'navbar-brand', 'modal-dialog',
  'list-group-item', 'input-group', 'page-header', 'ProductDetailPage',
  'onboarding-step-3', 'wp-block-button', 'elementor-widget', 'swiper-slide',
];

test('a name a build tool made up is not used as a selector', () => {
  const missed = GENERATED.filter((name) => !inPage.looksGenerated(name));
  assert.deepStrictEqual(missed, [],
    `these would be written into a flow and break on the next deploy: ${missed.join(', ')}`);
});

test('a name a person typed is kept', () => {
  const rejected = AUTHORED.filter((name) => inPage.looksGenerated(name));
  assert.deepStrictEqual(rejected, [],
    `throwing these away drops the selector to a positional path: ${rejected.join(', ')}`);
});

test('a hash is recognised whether or not the camel humps chop it up', () => {
  // "3xY7kQ" splits into "3x", "Y7", "kQ" - three innocent-looking pieces, none
  // of them long enough to judge. The undivided part has to be tested too.
  assert.ok(inPage.tokens('_3xY7kQ').includes('3xY7kQ'));
  assert.ok(inPage.randomLooking('3xY7kQ'));
});

test('overlapping letter-digit changes both count', () => {
  // "q9q" is two changes, not one. Counting them with a consuming match eats
  // the 9 and hides the second, which is what let "LSqk9q" through.
  assert.ok(inPage.randomLooking('LSqk9q'));
});

test('a token too short to judge is left alone rather than guessed at', () => {
  // Four characters is not enough to tell "4kL9" from "4xl", and inventing an
  // answer would start throwing away real class names.
  assert.strictEqual(inPage.randomLooking('4kL9'), false);
  assert.strictEqual(inPage.randomLooking('2xl'), false);
});

test('anything outside plain ASCII was not typed by a person', () => {
  assert.ok(inPage.looksGenerated('⚙1fpnohr'));
  assert.ok(inPage.looksGenerated('aéb'));
});
