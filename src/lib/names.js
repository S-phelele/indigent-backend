/**
 * Names, and the initials derived from them.
 *
 * The form used to have one `names` field, which people filled in
 * inconsistently — sometimes a first name, sometimes all of them, sometimes the
 * whole name including the surname. Somebody called Nomsa Thandiwe Sibongile has
 * three given names and a right to have all three recorded, and a municipal
 * letter addressed to the wrong one is a small insult that is entirely
 * avoidable.
 *
 * ## Initials are derived, never stored
 *
 * Two columns holding the same fact are two columns that can disagree, and the
 * one nobody looks at is the one that goes stale. They are computed on read,
 * here, so every screen that shows them shows the same thing.
 */

/** Separators that appear inside real South African names. */
const PART_SPLIT = /[\s]+/;

/**
 * Initials for a set of given names.
 *
 *   'Nomsa Thandiwe'      → 'N.T.'
 *   'Sipho-Lwazi'         → 'S.L.'   a hyphenated name is two names
 *   "N'wamitwa"           → 'N.'     an apostrophe is inside one name
 *   'thabo'               → 'T.'
 *
 * Hyphenated names produce an initial each, because that is how they are
 * written on an identity document. Apostrophes do not: they sit inside a single
 * name rather than joining two.
 */
function initials(fullName) {
  const text = String(fullName ?? '').trim();
  if (!text) return '';

  return text
    .split(PART_SPLIT)
    .flatMap((part) => part.split('-'))
    .map((part) => part.trim())
    .filter(Boolean)
    /**
     * The first *letter*, not the first character.
     *
     * People bracket a preferred name — "Nomsa (Thandiwe)" — and taking the
     * character at position zero would give "(", so the part would be discarded
     * and Thandiwe would lose her initial. Reading past the punctuation keeps
     * her; a part with no letter in it at all still contributes nothing.
     */
    .map((part) => [...part].find((ch) => /\p{L}/u.test(ch)))
    .filter(Boolean)
    .map((ch) => `${ch.toUpperCase()}.`)
    .join('');
}

/**
 * How this person should be addressed on a letter or listed in a queue.
 *
 * Falls back through what is actually present rather than producing "undefined
 * undefined", which is what a municipal letter used to say when a councillor
 * captured a household in a hurry.
 */
function display({ title, fullName, names, surname } = {}) {
  const given = String(fullName || names || '').trim();
  const family = String(surname || '').trim();

  const parts = [title, given, family].map((p) => String(p || '').trim()).filter(Boolean);
  return parts.join(' ') || 'Unnamed';
}

/** Surname first, for a queue that is scanned rather than read. */
function listed({ fullName, names, surname } = {}) {
  const given = String(fullName || names || '').trim();
  const family = String(surname || '').trim();

  if (family && given) return `${family}, ${initials(given)}`;
  return family || given || 'Unnamed';
}

/**
 * Everything a client needs about somebody's name, in one shape.
 *
 * Attached to application responses so the portals and the app do not each
 * re-derive initials from a field they read slightly differently.
 */
function describe(application = {}) {
  const given = application.fullName || application.names || '';
  return {
    fullName: given || null,
    surname: application.surname || null,
    initials: initials(given),
    display: display(application),
    listed: listed(application),
  };
}

module.exports = { initials, display, listed, describe };
