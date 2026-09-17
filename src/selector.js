'use strict';

/**
 * Selector generation, as a string to run inside the page.
 *
 * This is the whole point of capture mode: nobody should have to open devtools
 * and hand-copy a selector for every step. What it produces has to survive a
 * rebuild of the site, so it prefers what a developer put there on purpose -
 * a test id, an id, an aria-label - over anything a framework generated or
 * anything derived from position in the tree.
 */
const SELECTOR_SCRIPT = `
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

  /**
   * Class and id names that a build tool made up. They change on the next
   * deploy, so a selector built from them is worthless - and worse than
   * worthless, because it works today and fails in a month with no clue why.
   *
   * The earlier version of this looked for a run of six hex characters, which
   * is what a hash looked like when hashes were md5 prefixes. Pointed at real
   * sites it let all of these through:
   *
   *   SkipLink-module-scss-module__n5hZGa__skipLink   (CSS modules)
   *   LSqk9q_root                                     (Linaria)
   *   ⚙1fpnohr                                        (Stripe's build)
   *
   * None of them contain six hex characters in a row. So the test is no longer
   * "does it look like a hash" but "does this contain a token no person would
   * have typed" - checked per token, because the giveaway is usually one
   * segment of an otherwise readable name.
   */
  function looksGenerated(name) {
    if (/^[0-9]/.test(name)) return true;                 // starts with a digit
    if (/[^\u0020-\u007e]/.test(name)) return true;        // nobody types ⚙ into a class
    // Anywhere in the name, not just at the front: styled-components writes
    // "MainNavItemLogo-style__StyledLink-sc-d4709398-1", where the readable
    // half is a decoy and the componentId after it is the part that moves.
    if (/(^|-)(css|sc|emotion|jsx|makeStyles|MuiBox)-/.test(name)) return true;
    if (/^:r[0-9a-z]+:?$/i.test(name)) return true;       // React useId
    // CSS modules and friends: a double underscore around a hash segment, or
    // the literal word "module" a bundler inserted.
    if (/__[A-Za-z0-9]{4,}__/.test(name)) return true;
    if (/-module[-_]/.test(name)) return true;
    return tokens(name).some(randomLooking);
  }

  /**
   * Split on separators and camel humps, keeping both halves of the answer.
   *
   * The whole separator-delimited part matters as much as its camel pieces: a
   * hash like "3xY7kQ" splits into "3x", "Y7", "kQ", every one of them too
   * short to judge, and looks perfectly innocent piece by piece.
   */
  function tokens(name) {
    const parts = String(name).split(/[-_]+/).filter(Boolean);
    const out = parts.slice();
    for (const part of parts) {
      for (const hump of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        if (hump && hump !== part) out.push(hump);
      }
    }
    return out;
  }

  /**
   * A token no person would have typed.
   *
   * Three signals, each of which a hand-written name almost never has and a
   * base-36 hash almost always does: letters and digits interleaved, case
   * changing back and forth mid-word, and hardly any vowels.
   */
  function randomLooking(token) {
    if (token.length < 5 || token.length > 24) return false;
    if (/^[0-9]+$/.test(token)) return false;             // a plain number is a column, not a hash
    const letters = token.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) return false;

    // Letters and digits taking turns. One or two changes is a version number
    // or a grid column; half a dozen is base 36.
    // Lookahead, so overlapping changes both count: in "q9q" the match must
    // not eat the 9 and hide the second one.
    const swaps = (token.match(/[A-Za-z](?=[0-9])|[0-9](?=[A-Za-z])/g) || []).length;
    if (swaps >= 3) return true;
    const digitInside = swaps >= 2;
    // Two or more case changes after the first character: "n5hZGa", "IfRCG".
    // One is ordinary camelCase, which people write all the time.
    const flips = (token.slice(1).match(/(?<=[a-z])[A-Z]|(?<=[A-Z])[a-z]/g) || []).length;
    const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
    // Not one vowel in five or more characters. Words have vowels; base-36
    // hashes such as "jtyPqk" routinely do not, and an abbreviation that long
    // without one is not something anybody types.
    if (vowels === 0) return true;
    const vowelStarved = vowels / letters.length < 0.22;

    return (digitInside ? 1 : 0) + (flips >= 3 ? 1 : 0) + (vowelStarved ? 1 : 0) >= 2;
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\\\]/g, '\\\\$&');
  }

  const unique = (selector, el) => {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch (e) { return false; }
  };

  /**
   * Climb from whatever was clicked to the thing worth naming. Clicking the
   * label inside a button should record the button, not the span.
   */
  function meaningful(el) {
    const interactive = el.closest(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"]'
    );
    if (interactive) return interactive;
    for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      if (TEST_ID_ATTRS.some((a) => node.getAttribute && node.getAttribute(a))) return node;
    }
    return el;
  }

  function bestSelector(target) {
    const el = meaningful(target);

    for (const attr of TEST_ID_ATTRS) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value) {
        const sel = '[' + attr + '="' + cssEscape(value) + '"]';
        if (unique(sel, el)) return sel;
      }
    }

    if (el.id && !looksGenerated(el.id)) {
      const sel = '#' + cssEscape(el.id);
      if (unique(sel, el)) return sel;
    }

    const label = el.getAttribute && el.getAttribute('aria-label');
    if (label && label.length < 60) {
      const sel = el.tagName.toLowerCase() + '[aria-label="' + cssEscape(label) + '"]';
      if (unique(sel, el)) return sel;
    }

    const name = el.getAttribute && el.getAttribute('name');
    if (name && !looksGenerated(name)) {
      const sel = el.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
      if (unique(sel, el)) return sel;
    }

    // Classes the author wrote, at most three of them, longest first so the
    // most specific one leads.
    const classes = (el.className && typeof el.className === 'string' ? el.className : '')
      .split(/\\s+/).filter((c) => c && !looksGenerated(c))
      .sort((a, b) => b.length - a.length).slice(0, 3);
    if (classes.length) {
      const sel = el.tagName.toLowerCase() + '.' + classes.map(cssEscape).join('.');
      if (unique(sel, el)) return sel;
      const scoped = scopeToAncestor(el, sel);
      if (scoped) return scoped;
    }

    return structuralPath(el);
  }

  /** Prefix a selector with the nearest named ancestor to make it unique. */
  function scopeToAncestor(el, selector) {
    for (let node = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      let prefix = null;
      for (const attr of TEST_ID_ATTRS) {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value) { prefix = '[' + attr + '="' + cssEscape(value) + '"]'; break; }
      }
      if (!prefix && node.id && !looksGenerated(node.id)) prefix = '#' + cssEscape(node.id);
      if (!prefix) continue;
      const combined = prefix + ' ' + selector;
      if (unique(combined, el)) return combined;
    }
    return null;
  }

  /** A stable name for a node, if it has one: a test id or an authored id. */
  function anchorFor(node) {
    for (const attr of TEST_ID_ATTRS) {
      const value = node.getAttribute && node.getAttribute(attr);
      if (value) return '[' + attr + '="' + cssEscape(value) + '"]';
    }
    if (node.id && !looksGenerated(node.id)) return '#' + cssEscape(node.id);
    return null;
  }

  /**
   * Position among siblings of the same tag, always stated even when there is
   * only one right now.
   *
   * Leaving the index off an only child looks tidier and is a trap: a table
   * showing one "loading" row gives "#rows tr > td", which stops being unique
   * the moment the real rows arrive. Lists growing is the normal case on a
   * dashboard, so the index is never optional.
   */
  function positional(node) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent || tag === 'html' || tag === 'body') return tag;
    const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
    return tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
  }

  /**
   * Last resort: a path by position, rooted at the nearest ancestor that has a
   * real name.
   *
   * Stopping at the first selector that happens to be unique is a trap. Click a
   * cell while a table still says "loading" and "td:nth-of-type(2)" is unique -
   * right up until the rows arrive and it matches four. Anchoring to a named
   * ancestor survives that.
   */
  function structuralPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 8; node = node.parentElement) {
      const anchor = anchorFor(node);
      if (anchor && node !== el) {
        const anchored = anchor + ' ' + parts.join(' > ');
        if (unique(anchored, el)) return anchored;
      }
      parts.unshift(positional(node));
      if (anchor && node === el && unique(anchor, el)) return anchor;
    }

    // Nothing named anywhere above it. Take the shortest path that resolves,
    // but never a single generic tag, which is unique only by accident.
    const grown = [];
    for (let node = el; node && node.nodeType === 1 && grown.length < 6; node = node.parentElement) {
      grown.unshift(positional(node));
      if (grown.length >= 2 && unique(grown.join(' > '), el)) return grown.join(' > ');
    }
    return grown.join(' > ');
  }

  /** A short human label for the step list. */
  /**
   * A short human label for the step list.
   *
   * A form field is named by what is written *beside* it, never by what is
   * inside it. Reading el.value back gave the storyboard "types into
   * merijn.kersten@rebels.io" for an email box and "types into true" for a
   * checkbox - the contents described, the control not. It also wrote whatever
   * happened to be in the field into flow.json, which is a way to leak
   * somebody's data into a file they then share.
   */
  function describeElement(target) {
    const el = meaningful(target);
    if (el.matches && el.matches('input, textarea, select')) {
      const named = el.getAttribute('aria-label')
        || labelFor(el)
        || el.getAttribute('placeholder')
        || el.getAttribute('name')
        || (el.id && !looksGenerated(el.id) ? el.id : '');
      return trimLabel(named) || ((el.type || 'text') + ' field');
    }
    return trimLabel(el.innerText || el.getAttribute('aria-label') || '')
      || el.tagName.toLowerCase();
  }

  /** The <label> tied to a field, by for= or by wrapping it. */
  function labelFor(el) {
    try {
      if (el.labels && el.labels.length) return el.labels[0].innerText || '';
      const wrap = el.closest && el.closest('label');
      return wrap ? wrap.innerText || '' : '';
    } catch (e) { return ''; }
  }

  function trimLabel(text) {
    return String(text || '').trim().split('\\n')[0].trim().slice(0, 40);
  }
`;

module.exports = { SELECTOR_SCRIPT };
