const retention = require('./retention');

/**
 * The privacy notice, and the governance records POPIA requires behind it.
 *
 * Two things live here.
 *
 * The **processing register**: what personal information this system holds, why,
 * on what lawful basis, and who it goes to. POPIA does not demand a document in
 * a particular format, but section 17 requires notification of processing and
 * section 18 requires the data subject to be told the purpose, the recipients
 * and whether supplying it is voluntary. You cannot tell somebody those things
 * if nobody has written them down.
 *
 * The **Information Officer**: section 55 makes the head of a public body the
 * Information Officer by default, and section 56 allows deputies. A registered
 * name and a working contact address are a statutory requirement, not a nicety —
 * they are where a data subject sends a request and where the Regulator writes.
 *
 * ## Why this is code rather than a PDF
 *
 * A privacy notice in a Word document on somebody's laptop drifts out of date
 * the first time a field is added. This is generated from the same constants the
 * system runs on, so the notice cannot promise something the code does not do.
 */

/**
 * Set these for the real municipality. They are deliberately unset by default
 * so the notice says so loudly rather than publishing a plausible-looking
 * placeholder as though it were a real appointment.
 */
const OFFICER = {
  municipality: process.env.MUNICIPALITY_NAME || null,
  informationOfficer: process.env.INFORMATION_OFFICER_NAME || null,
  informationOfficerEmail: process.env.INFORMATION_OFFICER_EMAIL || null,
  deputy: process.env.DEPUTY_INFORMATION_OFFICER_NAME || null,
  deputyEmail: process.env.DEPUTY_INFORMATION_OFFICER_EMAIL || null,
  postalAddress: process.env.MUNICIPALITY_POSTAL_ADDRESS || null,
  telephone: process.env.MUNICIPAL_HELP_LINE || null,
};

/** How long the municipality gives itself to answer a request. */
const RESPONSE_DAYS = Number(process.env.SUBJECT_REQUEST_RESPONSE_DAYS || 30);

/**
 * What is collected, why, and on what basis.
 *
 * Each entry names a lawful ground from section 11. Most of this register runs
 * on 11(1)(c) — processing necessary to comply with an obligation imposed by law
 * — because administering indigent relief is a statutory function under the
 * Municipal Systems Act, not something the municipality does by consent. That
 * matters: a household cannot be asked to consent to something the municipality
 * is obliged to do anyway, and pretending otherwise would make the consent
 * meaningless.
 *
 * The two entries that genuinely rest on consent say so, and those are the two
 * a household can refuse without losing their application.
 */
const PROCESSING_REGISTER = [
  {
    category: 'Identity',
    items: ['Name', 'ID number', 'Date of birth', 'Age', 'Sex'],
    purpose: 'To identify the household and prevent one household being registered twice.',
    basis: 'POPIA s11(1)(c) — a statutory function under the Municipal Systems Act.',
    voluntary: false,
    recipients: ['Municipal officials handling the application'],
  },
  {
    category: 'Contact',
    items: ['Cell number', 'Email address', 'Postal address'],
    purpose: 'To tell the household what is happening with their application.',
    basis: 'POPIA s11(1)(c).',
    voluntary: false,
    recipients: ['The SMS gateway that delivers the message'],
  },
  {
    category: 'Household and income',
    items: [
      'People living on the property', 'Household members\' names, ages and income',
      'Salary, pensions, grants and other income', 'Employment status',
    ],
    purpose: 'To apply the means test that decides whether the household qualifies.',
    basis: 'POPIA s11(1)(c).',
    voluntary: false,
    recipients: ['Municipal officials handling the application'],
  },
  {
    category: 'Property',
    items: [
      'Residential address', 'Municipal and Eskom account numbers',
      'Meter numbers', 'Ownership or tenancy', 'Other property owned',
    ],
    purpose: 'To apply the relief to the correct account and confirm the property qualifies.',
    basis: 'POPIA s11(1)(c).',
    voluntary: false,
    recipients: ['The municipal finance department, to apply the relief'],
  },
  {
    /**
     * Named separately from the address because it is the most sensitive thing
     * held: coordinates to seven decimal places locate a specific dwelling.
     */
    category: 'Location of your home',
    items: ['GPS coordinates of the property'],
    purpose: 'To find the property for a verification visit, and to report demand by area. '
      + 'Many properties have no street address, so coordinates are often the only way to locate them.',
    basis: 'POPIA s11(1)(a) — your consent. You can apply without giving them.',
    voluntary: true,
    recipients: ['Municipal officials handling the application', 'The mapping service used to look up an address'],
    special: true,
  },
  {
    /**
     * Health information is "special personal information" under section 26 and
     * needs a section 27 ground. Consent is the applicable one here, which is
     * why the six questions can be left blank without affecting the outcome.
     */
    category: 'Health and functioning',
    items: ['Answers to the six functioning questions', 'Disability status'],
    purpose: 'To report on how many households the register reaches who have a disability, '
      + 'and to identify households that may need extra help.',
    basis: 'POPIA s27(1)(a) — your consent, as this is special personal information under s26. '
      + 'You can leave every one of these questions blank.',
    voluntary: true,
    recipients: ['Municipal officials handling the application'],
    special: true,
  },
  {
    category: 'Supporting documents',
    items: ['ID copy', 'Proof of income or grant', 'Bank statements', 'Affidavit', 'Proof of ownership or lease'],
    purpose: 'To verify what the household declared.',
    basis: 'POPIA s11(1)(c).',
    voluntary: false,
    recipients: ['Municipal officials handling the application'],
  },
  {
    category: 'Verification checks',
    items: ['Results of checks against SARS, UIF, SASSA, credit bureaux and the deeds office'],
    purpose: 'To confirm the declared income and property are accurate.',
    basis: 'POPIA s11(1)(a) — your consent, given when you applied. Verification cannot proceed without it.',
    voluntary: true,
    recipients: ['The organisation the check is run against'],
  },
];

/** The notice itself, assembled for publication on both portals. */
function notice() {
  const configured = Boolean(OFFICER.informationOfficer && OFFICER.informationOfficerEmail);

  return {
    municipality: OFFICER.municipality || 'This municipality',

    /**
     * Said plainly when the statutory appointment has not been recorded. A
     * privacy notice with no Information Officer is not a compliant notice, and
     * a placeholder that looks real is worse than an obvious gap.
     */
    informationOfficer: configured
      ? {
          name: OFFICER.informationOfficer,
          email: OFFICER.informationOfficerEmail,
          deputy: OFFICER.deputy,
          deputyEmail: OFFICER.deputyEmail,
          postalAddress: OFFICER.postalAddress,
          telephone: OFFICER.telephone,
        }
      : null,
    informationOfficerWarning: configured
      ? null
      : 'No Information Officer has been recorded for this municipality. POPIA section 55 requires one, '
        + 'and data subjects have nowhere to send a request until it is set. '
        + 'Configure INFORMATION_OFFICER_NAME and INFORMATION_OFFICER_EMAIL.',

    whyWeCollectIt:
      'This municipality administers indigent relief — reduced or free basic services for households that cannot '
      + 'afford them. Deciding who qualifies requires knowing who lives in the household and what they live on. '
      + 'We collect nothing beyond what that decision needs.',

    processing: PROCESSING_REGISTER,

    /** The two things a household can decline without losing their application. */
    whatIsOptional: PROCESSING_REGISTER
      .filter((p) => p.voluntary)
      .map((p) => ({ category: p.category, note: p.basis })),

    retention: retention.publish(),

    yourRights: [
      { right: 'To be told what we hold about you', section: 'POPIA s23', how: 'Ask us for a copy from your profile page.' },
      { right: 'To have wrong information corrected', section: 'POPIA s24', how: 'Ask us to correct it from your profile page.' },
      { right: 'To have information deleted when it is no longer needed', section: 'POPIA s24', how: 'Ask us from your profile page.' },
      { right: 'To object to how we process your information', section: 'POPIA s11(3)', how: 'Ask us from your profile page.' },
      { right: 'To complain to the Information Regulator', section: 'POPIA s74', how: 'complaints.IR@justice.gov.za' },
    ],

    responseStandard: `We answer requests within ${RESPONSE_DAYS} days.`,

    regulator: {
      name: 'Information Regulator (South Africa)',
      email: 'complaints.IR@justice.gov.za',
      note: 'You may complain to the Regulator at any time, including before asking us.',
    },
  };
}

/**
 * Whether the governance records are complete enough to operate lawfully.
 *
 * Surfaced to administrators rather than buried, because an unset Information
 * Officer is not a cosmetic gap — it is the address a data subject's request has
 * to go to.
 */
function readiness() {
  const gaps = [];

  if (!OFFICER.municipality) gaps.push('The municipality\'s name is not set (MUNICIPALITY_NAME).');
  if (!OFFICER.informationOfficer) gaps.push('No Information Officer has been recorded (INFORMATION_OFFICER_NAME).');
  if (!OFFICER.informationOfficerEmail) gaps.push('The Information Officer has no contact address (INFORMATION_OFFICER_EMAIL).');
  if (!OFFICER.postalAddress) gaps.push('No postal address is recorded for written requests (MUNICIPALITY_POSTAL_ADDRESS).');

  return { ready: gaps.length === 0, gaps, responseDays: RESPONSE_DAYS };
}

module.exports = { notice, readiness, PROCESSING_REGISTER, OFFICER, RESPONSE_DAYS };
