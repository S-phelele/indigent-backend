const chain = require('./approvalChain');
const renewal = require('./renewal');

/**
 * Exports a person can actually read.
 *
 * The old export wrote raw column values: `APPROVED`, `DECEASED_ESTATE`,
 * `2026-08-07T14:22:31.204Z`, `true`. That is a database dump wearing a .csv
 * extension. Somebody opening it in Excel to prepare a council report has to
 * translate every column by hand, and the dates do not even sort properly
 * because Excel reads an ISO timestamp as text.
 *
 * So: headers in words, dates as dates, money as numbers, yes/no as Yes/No, and
 * enums as the labels used everywhere else in the system.
 */

const LABELS = {
  status: { DRAFT: 'Not submitted', PENDING: 'Awaiting decision', APPROVED: 'Approved', DECLINED: 'Not approved' },
  tenure: { OWNER: 'Owner', TENANT: 'Tenant', OCCUPIER: 'Occupier' },
  applicantCategory: {
    STANDARD: 'Standard', PENSIONER: 'Pensioner', DECEASED_ESTATE: 'Deceased estate',
    CHILD_HEADED: 'Child-headed', DISABLED: 'Disability',
  },
  employmentStatus: {
    EMPLOYED: 'Employed', UNEMPLOYED: 'Unemployed', SELF_EMPLOYED: 'Self-employed',
    PENSIONER: 'Pensioner', OTHER: 'Other',
  },
  maritalStatus: {
    SINGLE: 'Single', MARRIED: 'Married', DIVORCED: 'Divorced', WIDOWED: 'Widowed', SEPARATED: 'Separated',
  },
  captureChannel: { SELF: 'Applied themselves', COUNCILLOR: 'Councillor capture', ADMIN: 'Office capture' },
  meansTestResult: { QUALIFIES: 'Qualifies', ABOVE_THRESHOLD: 'Above threshold', INSUFFICIENT_DATA: 'Insufficient data' },
  renewalStatus: {
    NOT_APPLICABLE: '', ACTIVE: 'Active', DUE_SOON: 'Due soon', OVERDUE: 'Overdue', LAPSED: 'Lapsed',
  },
};

const label = (field, value) => (value == null ? '' : (LABELS[field]?.[value] ?? value));

/** `2026-08-07`. Sorts correctly in Excel and is unambiguous internationally. */
const date = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

/** A plain number, so Excel sums the column instead of concatenating it. */
const money = (value) => (value == null || value === '' ? '' : Number(value).toFixed(2));

const yesNo = (value) => (value === true ? 'Yes' : value === false ? 'No' : '');

/**
 * The columns, in the order somebody reading a council report wants them.
 *
 * Reference and name first because that is what a row is identified by; the
 * decision next because that is what the report is about; detail after that.
 */
const APPLICATION_COLUMNS = [
  ['Reference', (a) => a.reference || ''],
  ['Surname', (a) => a.surname || ''],
  ['First names', (a) => a.names || ''],
  ['ID number', (a) => (a.idNumber ? `="${a.idNumber}"` : '')],
  ['Cell number', (a) => (a.cellNumber ? `="${a.cellNumber}"` : '')],
  ['Status', (a) => label('status', a.status)],
  ['Stage', (a) => (a.approvalStage === 'COMPLETE' ? '' : chain.config(a.approvalStage)?.label || '')],
  ['Ward', (a) => a.wardNumber || ''],
  ['Category', (a) => label('applicantCategory', a.applicantCategory)],
  ['Ownership', (a) => label('tenure', a.tenure)],
  ['Municipal account', (a) => (a.municipalAccountNumber ? `="${a.municipalAccountNumber}"` : '')],
  ['Household size', (a) => a.peopleOnProperty ?? ''],
  ['Children under 18', (a) => a.childrenUnder18 ?? ''],
  ['Pensioners over 60', (a) => a.pensionersOver60 ?? ''],
  ['Employment', (a) => label('employmentStatus', a.employmentStatus)],
  ['Marital status', (a) => label('maritalStatus', a.maritalStatus)],
  ['Declared income', (a) => money(a.totalHouseholdIncome)],
  ['Income per person', (a) => money(a.totalIncomePerPerson)],
  ['Assessed income', (a) => money(a.assessedIncome)],
  ['Means test', (a) => label('meansTestResult', a.meansTestResult)],
  ['Threshold applied', (a) => money(a.incomeThresholdApplied)],
  ['How it reached us', (a) => label('captureChannel', a.captureChannel)],
  ['Captured by', (a) => (a.capturedBy ? [a.capturedBy.firstName, a.capturedBy.lastName].filter(Boolean).join(' ') : '')],
  ['Residential address', (a) => a.residentialAddress || ''],
  ['Date applied', (a) => date(a.submittedAt || a.createdAt)],
  ['Date decided', (a) => date(a.reviewedAt)],
  ['Days to decide', (a) => (a.submittedAt && a.reviewedAt
    ? Math.max(0, Math.round((new Date(a.reviewedAt) - new Date(a.submittedAt)) / 86400000))
    : '')],
  ['Signed off by', (a) => a.signedOffName || ''],
  ['Registration expires', (a) => date(a.expiresAt)],
  ['Renewal status', (a) => label('renewalStatus', a.renewalStatus)],
  ['Times renewed', (a) => a.renewalCount ?? 0],
  ['Owns other property', (a) => yesNo(a.ownsOtherProperty)],
  ['Consent given', (a) => yesNo(a.consentSiteVisit && a.consentDataMatching && a.declarationTruthful)],
  ['Review notes', (a) => a.reviewNotes || ''],
];

/**
 * Escape one field.
 *
 * The `="..."` wrapper on ID and account numbers is deliberate: Excel otherwise
 * reads a 13-digit ID as a number and renders it as 9.20220E+12, which destroys
 * the one column a municipality most needs to be exact.
 */
function escape(value) {
  const s = String(value ?? '');
  if (s === '') return '';
  // A leading =, +, - or @ is executed by Excel as a formula. Prefixing our own
  // deliberate ="..." is fine; anything else that starts that way is neutralised.
  const injectable = /^[=+\-@\t\r]/.test(s) && !s.startsWith('="');
  const safe = injectable ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Applications as CSV, with a byte-order mark so Excel opens it as UTF-8. */
function applicationsCsv(applications) {
  const header = APPLICATION_COLUMNS.map(([name]) => escape(name)).join(',');
  const rows = applications.map((a) => APPLICATION_COLUMNS.map(([, get]) => escape(get(a))).join(','));
  // Without the BOM, Excel on Windows renders "Khumalo" fine but mangles any
  // name with a diacritic.
  return `﻿${[header, ...rows].join('\r\n')}\r\n`;
}

/** A filename that sorts chronologically and says what it is. */
const filename = (prefix, extra = '') =>
  `${prefix}${extra ? `-${extra}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`;

/**
 * Everything the printable application form needs, in display order.
 *
 * Returned as sections so the print view renders headings without knowing the
 * shape of the record — and so the same structure can drive a PDF later without
 * rewriting the layout.
 */
function printableSections(application, { meansTest = null } = {}) {
  const a = application;
  const full = [a.names, a.surname].filter(Boolean).join(' ') || 'Not stated';
  const money2 = (v) => (v == null ? 'Not stated' : `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`);
  const or = (v) => (v == null || v === '' ? 'Not stated' : v);

  return [
    {
      title: 'Applicant',
      fields: [
        ['Full name', full],
        ['ID number', or(a.idNumber)],
        ['Cell number', or(a.cellNumber)],
        ['Marital status', label('maritalStatus', a.maritalStatus) || 'Not stated'],
        ['Employment', label('employmentStatus', a.employmentStatus) || 'Not stated'],
        ['Ward', or(a.wardNumber)],
        ['Household category', label('applicantCategory', a.applicantCategory)],
      ],
    },
    {
      title: 'Property',
      fields: [
        ['Residential address', or(a.residentialAddress)],
        ['Postal address', or(a.postalAddress)],
        ['Ownership', label('tenure', a.tenure) || 'Not stated'],
        ['Municipal account', or(a.municipalAccountNumber)],
        ['Eskom account', or(a.eskomAccountNumber)],
        ['Water meter', or(a.waterMeterNumber)],
        ['Electricity meter', or(a.electricityMeterNumber)],
        ['Owns other property', a.ownsOtherProperty ? (a.otherPropertyDetails || 'Yes') : 'No'],
      ],
    },
    {
      title: 'Household',
      fields: [
        ['People on the property', or(a.peopleOnProperty)],
        ['Children under 18', or(a.childrenUnder18)],
        ['Adults', or(a.adults)],
        ['Pensioners over 60', or(a.pensionersOver60)],
      ],
      table: (a.household || []).length
        ? {
            head: ['Name', 'Relationship', 'Age', 'Own income'],
            rows: a.household.map((m) => [
              m.fullName, m.relationship || '—', m.age ?? '—', m.monthlyIncome ? money2(m.monthlyIncome) : '—',
            ]),
          }
        : null,
    },
    {
      title: 'Household income',
      fields: [
        ['Salary or wages', money2(a.salary)],
        ['Old age pension', money2(a.oldAgePension)],
        ['Disability pension', money2(a.disabilityPension)],
        ['Business income', money2(a.businessIncome)],
        ['Rental income', money2(a.rentingIncome)],
        ['Total household income', money2(a.totalHouseholdIncome)],
        ['Income per person', money2(a.totalIncomePerPerson)],
        ['Income excluded', or(a.incomeExclusions)],
      ],
    },
    ...(meansTest
      ? [{
          title: 'Means test',
          fields: [
            ['Result', label('meansTestResult', meansTest.result)],
            ['Assessed income', money2(meansTest.assessedIncome)],
            ['Per person', money2(meansTest.perPerson)],
            ['Threshold applied', money2(meansTest.threshold)],
            ['Assessed by', or(a.assessedByName)],
            ['Assessment notes', or(a.assessmentNotes)],
          ],
        }]
      : []),
    {
      title: 'Declaration and consent',
      fields: [
        ['Consented to a site visit', yesNo(a.consentSiteVisit)],
        ['Consented to data checks', yesNo(a.consentDataMatching)],
        ['Declared the information true', yesNo(a.declarationTruthful)],
        ['Consent given on', date(a.consentGivenAt) || 'Not recorded'],
      ],
    },
    {
      title: 'Decision',
      fields: [
        ['Status', label('status', a.status)],
        ['Reference', or(a.reference)],
        ['Submitted', date(a.submittedAt) || 'Not submitted'],
        ['Decided', date(a.reviewedAt) || 'Not yet decided'],
        ['Registration expires', date(a.expiresAt) || 'Not applicable'],
        ['Renewal status', label('renewalStatus', a.renewalStatus) || 'Not applicable'],
        ['Notes', or(a.reviewNotes)],
      ],
    },
  ];
}

module.exports = {
  APPLICATION_COLUMNS,
  applicationsCsv,
  printableSections,
  filename,
  escape,
  label,
  date,
  money,
  yesNo,
  LABELS,
};
