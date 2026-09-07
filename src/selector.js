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
   * deploy, so a selector built from them is worthless.
   */
  function looksGenerated(name) {
    return (
      /^[0-9]/.test(name) ||                       // starts with a digit
      /^(css|sc|emotion|jsx|makeStyles|MuiBox)-/.test(name) ||
      /^:r[0-9a-z]+:?$/i.test(name) ||             // React useId
      /[a-f0-9]{6,}/i.test(name) && !/[aeiou]{2}/i.test(name) ||  // hash-looking
      /^[a-z]{1,3}[0-9]{4,}$/i.test(name)
    );
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
  function describeElement(target) {
    const el = meaningful(target);
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    const short = text.split('\\n')[0].slice(0, 40);
    return short || el.tagName.toLowerCase();
  }
`;

module.exports = { SELECTOR_SCRIPT };
