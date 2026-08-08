const prisma = require('./prisma');
const retention = require('./retention');
const functioning = require('./functioning');

/**
 * Answering "what do you hold about me?"
 *
 * POPIA section 23 gives a data subject the right to be told, on request, what
 * personal information a responsible party holds about them and who it has been
 * given to. Section 24 gives them the right to have it corrected or, where it is
 * no longer needed, deleted.
 *
 * A municipality that handles data carefully but cannot answer that question is
 * still not compliant. This module produces the answer.
 *
 * ## What "everything" means
 *
 * Not a dump of the applications table. A subject access response has to be
 * intelligible to the person reading it, which means every enum turned into
 * words, every derived value explained, and the disclosures — who else has seen
 * this — listed, because that is the part people actually want and the part
 * systems usually cannot produce.
 *
 * ## What is deliberately withheld
 *
 * Section 63(2) permits refusing access where it would reveal another person's
 * information. So a household member's own ID number is not disclosed to the
 * applicant, and the internal review notes of individual officers are summarised
 * as "assessed by a municipal official" rather than named. The applicant's own
 * information is complete; other people's is not theirs to receive.
 */

const money = (v) => (v == null ? null : `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

const LABEL = {
  status: { DRAFT: 'Not submitted', PENDING: 'Awaiting a decision', APPROVED: 'Approved', DECLINED: 'Not approved' },
  tenure: { OWNER: 'Owner', TENANT: 'Tenant', OCCUPIER: 'Occupier' },
  sex: { FEMALE: 'Female', MALE: 'Male' },
  difficulty: {
    NO_DIFFICULTY: 'No difficulty', SOME_DIFFICULTY: 'Some difficulty',
    A_LOT_OF_DIFFICULTY: 'A lot of difficulty', CANNOT_DO_AT_ALL: 'Cannot do at all',
  },
};
const say = (map, value) => (value == null ? null : (LABEL[map]?.[value] ?? value));

/**
 * Assemble everything held about one person.
 *
 * Returns a structure meant to be read, not parsed — section headings, plain
 * labels, and an explanation attached to anything derived.
 */
async function compile(userId, client = prisma) {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, firstName: true, lastName: true, cellNumber: true,
      idNumber: true, role: true, isVerified: true, ward: true,
      createdAt: true, updatedAt: true, registeredById: true,
    },
  });
  if (!user) return null;

  const applications = await client.application.findMany({
    where: { userId },
    include: {
      household: true,
      documents: { select: { name: true, type: true, status: true, uploadedAt: true, fileName: true } },
      siteVisits: { orderBy: { attempt: 'asc' } },
      checks: { orderBy: { checkedAt: 'asc' } },
      approvalSteps: { orderBy: { sequence: 'asc' } },
      changes: { orderBy: { createdAt: 'desc' }, take: 200 },
    },
    orderBy: { createdAt: 'asc' },
  });

  const [notifications, messages, auditRows] = await Promise.all([
    client.notification.findMany({
      where: { userId },
      select: { type: true, title: true, body: true, createdAt: true, readAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    client.smsMessage.findMany({
      where: { userId },
      select: { toNumber: true, purpose: true, body: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    client.auditLog.findMany({
      where: { OR: [{ userId }, { entityId: userId }] },
      select: { action: true, details: true, createdAt: true, userRole: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
  ]);

  return {
    preparedAt: new Date(),
    about: {
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      idNumber: user.idNumber,
      cellNumber: user.cellNumber,
      emailAddress: user.email.endsWith('@cell.indigent.local') ? null : user.email,
      accountCreated: day(user.createdAt),
      accountCreatedBy: user.registeredById
        ? 'A municipal official created this account on your behalf'
        : 'You registered this account yourself',
    },

    applications: applications.map((a) => ({
      reference: a.reference || 'Not yet issued',
      status: say('status', a.status),
      submitted: day(a.submittedAt),
      decided: day(a.reviewedAt),
      registrationExpires: day(a.expiresAt),

      whatYouToldUs: {
        residentialAddress: a.residentialAddress,
        postalAddress: a.postalAddress,
        ward: a.wardNumber,
        ownership: say('tenure', a.tenure),
        municipalAccount: a.municipalAccountNumber,
        peopleOnTheProperty: a.peopleOnProperty,
        totalHouseholdIncome: money(a.totalHouseholdIncome),
        employmentStatus: a.employmentStatus,
        ownsOtherProperty: a.ownsOtherProperty,
      },

      /**
       * Anything the system worked out rather than being told, with the
       * explanation attached. POPIA s23 covers the information held, and a
       * derived figure somebody cannot account for is the kind that goes wrong
       * quietly.
       */
      whatWeWorkedOut: {
        dateOfBirth: {
          value: day(a.dateOfBirth),
          derivedFrom: 'The first six digits of your ID number',
        },
        age: { value: a.age, derivedFrom: 'Your date of birth' },
        sex: { value: say('sex', a.sex), derivedFrom: 'The sequence digits of your ID number' },
        incomePerPerson: {
          value: money(a.totalIncomePerPerson),
          derivedFrom: 'Household income divided by the number of people on the property',
        },
        ...(a.hasDisability !== null
          ? {
              disabilityIdentifier: {
                value: a.hasDisability ? 'Yes' : 'No',
                derivedFrom: 'Your answers to the six functioning questions, using the Washington Group standard',
              },
            }
          : {}),
      },

      /** Coordinates are the most sensitive thing held, so they are named plainly. */
      ...(a.addressLatitude
        ? {
            locationHeld: {
              coordinates: `${a.addressLatitude}, ${a.addressLongitude}`,
              howItWasObtained: a.addressSource === 'DEVICE'
                ? 'Captured from a device at the property'
                : a.addressSource === 'SEARCH'
                  ? 'Looked up from the address you gave'
                  : 'Entered manually',
              whenCaptured: day(a.addressVerifiedAt),
            },
          }
        : {}),

      functioning: functioning.DOMAINS
        .filter((d) => a[d.field])
        .map((d) => ({ question: d.question, yourAnswer: say('difficulty', a[d.field]) })),

      /**
       * Other people in the household are listed by name and relationship only.
       * Their ID numbers and income are their information, and s63(2) permits
       * withholding another person's details.
       */
      householdMembersYouListed: a.household.map((m) => ({
        name: m.fullName,
        relationship: m.relationship,
        age: m.age,
        note: 'This person\'s own ID number and income are withheld — they are that person\'s information, not yours.',
      })),

      documentsYouGaveUs: a.documents
        .filter((d) => d.status === 'Uploaded')
        .map((d) => ({ document: d.name, fileName: d.fileName, uploaded: day(d.uploadedAt) })),

      /**
       * Who has looked at it. The disclosure list is the part of a subject access
       * response people most want, and the part most systems cannot produce.
       */
      whoHasHandledIt: a.approvalSteps.map((s) => ({
        stage: s.stage.replace(/_/g, ' ').toLowerCase(),
        // Named because a decision on public money is accountable, not anonymous.
        official: s.actorName || 'A municipal official',
        role: s.actorRole ? s.actorRole.replace(/_/g, ' ').toLowerCase() : null,
        when: day(s.decidedAt || s.startedAt),
      })),

      visitsToYourProperty: a.siteVisits.map((v) => ({
        attempt: v.attempt,
        outcome: v.outcome.replace(/_/g, ' ').toLowerCase(),
        when: day(v.visitedAt),
        officer: v.officerName,
      })),

      /**
       * Third parties your information was checked against. This is a disclosure
       * under s23(1)(b) and has to be listed — the findings are summarised rather
       * than quoted, because the raw note may name a third party's staff.
       */
      externalChecksRunOnYou: a.checks.map((c) => ({
        organisation: c.source.replace(/_/g, ' '),
        outcome: c.outcome,
        when: day(c.checkedAt),
        basis: 'You consented to external verification when you applied',
      })),

      changesMadeToYourRecord: a.changes.map((c) => ({
        field: c.field,
        from: c.oldValue,
        to: c.newValue,
        by: c.actorName || 'A municipal official',
        when: day(c.createdAt),
      })),

      ...(a.anonymisedAt
        ? {
            retentionNote: `The identifying details on this application were removed on ${day(a.anonymisedAt)} `
              + `under the municipality's retention policy (${a.anonymisedUnder}).`,
          }
        : {}),
    })),

    messagesWeSentYou: messages.map((m) => ({
      to: m.toNumber, about: m.purpose, message: m.body, delivery: m.status, when: day(m.createdAt),
    })),

    notificationsInThePortal: notifications.map((n) => ({
      title: n.title, message: n.body, when: day(n.createdAt), read: Boolean(n.readAt),
    })),

    /** Every recorded action touching this person. */
    activityOnYourRecord: auditRows.map((r) => ({
      what: r.action.replace(/_/g, ' ').toLowerCase(),
      detail: r.details,
      by: r.userRole ? r.userRole.replace(/_/g, ' ').toLowerCase() : 'the system',
      when: day(r.createdAt),
    })),

    /** What is kept and for how long, so the answer is self-contained. */
    ourRetentionPolicy: retention.publish(),

    yourRights: [
      'You may ask us to correct anything above that is wrong (POPIA section 24).',
      'You may object to how we process your information (section 11(3)).',
      'You may ask us to delete information we no longer need (section 24).',
      'You may complain to the Information Regulator if you are not satisfied with our response.',
    ],
  };
}

/**
 * Whether a deletion request can lawfully be granted.
 *
 * Deletion is not absolute. A live application cannot be deleted without
 * withdrawing it, and an approved registration that spent public money has to
 * remain auditable under the MFMA. Saying so up front is more honest than
 * accepting a request and refusing it later.
 */
async function deletionAssessment(userId, client = prisma) {
  const applications = await client.application.findMany({
    where: { userId },
    select: { id: true, reference: true, status: true, expiresAt: true, renewalStatus: true },
  });

  const blockers = [];

  const live = applications.filter((a) => a.status === 'PENDING');
  if (live.length) {
    blockers.push({
      code: 'APPLICATION_IN_PROGRESS',
      message: `${live.length} application(s) are still being decided. Withdraw them first, or wait for the outcome.`,
    });
  }

  const active = applications.filter((a) => a.status === 'APPROVED' && a.renewalStatus !== 'LAPSED');
  if (active.length) {
    blockers.push({
      code: 'ACTIVE_SUPPORT',
      message: 'You are currently receiving indigent support. Deleting your record would end it. '
        + 'Ask to be removed from the register first if that is what you want.',
    });
  }

  const auditable = applications.filter((a) => a.status === 'APPROVED');
  if (auditable.length) {
    blockers.push({
      code: 'FINANCIAL_RECORD',
      message: 'Approved applications spent public money and must remain auditable under the Municipal Finance '
        + 'Management Act. We can remove your identifying details once the retention period ends, keeping only '
        + 'anonymous statistics.',
    });
  }

  return {
    canDeleteNow: blockers.length === 0,
    blockers,
    /** What we can do instead, so the answer is never simply "no". */
    alternative: blockers.length
      ? 'We can anonymise your record when its retention period ends, which removes your name, ID number, address '
        + 'and location while keeping the anonymous figures the municipality is required to report.'
      : null,
    applications: applications.map((a) => ({ reference: a.reference, status: a.status })),
  };
}

module.exports = { compile, deletionAssessment };
