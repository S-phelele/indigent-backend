/**
 * South African postal addresses.
 *
 * The South African Post Office sorts on parts, not on a sentence: a street or
 * box line, an optional second line, the suburb, the town or city, and a
 * four-digit postal code on its own line at the end. Storing all of that in one
 * free-text box means the postal code cannot be validated, addresses cannot be
 * grouped by area for a delivery run, and a missing suburb is invisible until
 * the letter comes back.
 *
 * ## Why the code is always four digits
 *
 * South African postal codes are exactly four digits — 0001 Pretoria, 8001 Cape
 * Town, 1900 Vanderbijlpark. Leading zeros are significant, so the code is a
 * string. Stored as a number, 0001 becomes 1 and the address is wrong in a way
 * nobody notices until the post stops arriving.
 *
 * ## Why "same as residential" stores nothing
 *
 * When a household says their postal address is where they live, the parts are
 * left empty and the residential address is used at the point of printing.
 * Copying it would leave two answers to keep in step, and they would drift the
 * first time one was corrected — which is exactly the case where getting it
 * wrong matters, because somebody has moved.
 */

/** A South African postal code: exactly four digits, leading zeros meaningful. */
const CODE_PATTERN = /^\d{4}$/;

/**
 * PO Box and Private Bag are addresses in their own right.
 *
 * Recognised so the form can stop insisting on a suburb for a box at a post
 * office, which has none.
 */
const BOX_PATTERN = /^\s*(p\.?\s*o\.?\s*box|post\s*office\s*box|private\s*bag|postnet\s*suite)\b/i;

const isBox = (line1) => BOX_PATTERN.test(String(line1 || ''));

const tidy = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
};

/**
 * Check the parts a household filled in.
 *
 * Returns a list of problems in the order somebody reads the form, so the first
 * message they see is about the first field they got wrong. An empty address is
 * not a problem here — the postal address is optional, and a half-filled one is
 * caught at submission rather than while somebody is still typing.
 */
function problems(parts = {}) {
  const line1 = tidy(parts.postalLine1);
  const suburb = tidy(parts.postalSuburb);
  const city = tidy(parts.postalCity);
  const code = tidy(parts.postalCode);

  // Nothing entered at all is fine; the field is optional.
  if (!line1 && !suburb && !city && !code) return [];

  const found = [];

  if (!line1) {
    found.push('Please give the street address, or the PO Box or Private Bag number.');
  }

  // A box has no suburb, so only a street address is held to that.
  if (!isBox(line1) && !suburb) {
    found.push('Please give the suburb or township.');
  }

  if (!city) found.push('Please give the town or city.');

  if (!code) {
    found.push('Please give the four-digit postal code.');
  } else if (!CODE_PATTERN.test(code)) {
    found.push('A South African postal code is exactly four digits, for example 1900.');
  }

  return found;
}

/**
 * Assemble the parts into the block that goes on an envelope.
 *
 * The Post Office's layout: address lines, then suburb, then town, then the code
 * alone on the last line. Returned as one string with newlines, which is what
 * the printable form and the exports want.
 */
function compose(parts = {}) {
  const lines = [
    tidy(parts.postalLine1),
    tidy(parts.postalLine2),
    tidy(parts.postalSuburb),
    tidy(parts.postalCity),
    tidy(parts.postalCode),
  ].filter(Boolean);

  return lines.length ? lines.join('\n') : null;
}

/** The same thing on one line, for a table cell or a CSV column. */
const composeInline = (parts = {}) => {
  const block = compose(parts);
  return block ? block.replace(/\n/g, ', ') : null;
};

/**
 * Work out what to store, given the checkbox.
 *
 * Returns the fields to write. When the address is the same as residential the
 * parts are cleared rather than filled in, so there is exactly one answer on
 * file and no copy to fall out of step.
 */
function resolve({ sameAsResidential, residentialAddress, ...parts } = {}) {
  if (sameAsResidential) {
    return {
      postalSameAsResidential: true,
      postalLine1: null,
      postalLine2: null,
      postalSuburb: null,
      postalCity: null,
      postalCode: null,
      // Composed for print and export, where a blank postal address would look
      // like something nobody asked rather than something answered once.
      postalAddress: tidy(residentialAddress),
    };
  }

  const tidied = {
    postalLine1: tidy(parts.postalLine1),
    postalLine2: tidy(parts.postalLine2),
    postalSuburb: tidy(parts.postalSuburb),
    postalCity: tidy(parts.postalCity),
    postalCode: tidy(parts.postalCode),
  };

  return {
    postalSameAsResidential: false,
    ...tidied,
    postalAddress: compose(tidied),
  };
}

/** For display: the address to actually use, whichever way it was given. */
const forDisplay = (application = {}) => {
  if (application.postalSameAsResidential) return tidy(application.residentialAddress);
  return compose(application) || tidy(application.postalAddress);
};

module.exports = {
  CODE_PATTERN,
  problems,
  compose,
  composeInline,
  resolve,
  forDisplay,
  isBox,
  tidy,
};
