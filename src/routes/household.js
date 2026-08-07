const express = require('express');
const prisma = require('../lib/prisma');
const { protect } = require('../middleware/auth');
const access = require('../lib/applicationAccess');
const saId = require('../lib/saIdNumber');
const audit = require('../lib/audit');
const cache = require('../lib/cache');

/**
 * Everyone living on the property.
 *
 * The register assesses a household, not a person. Income is measured per head,
 * so the same R3 000 qualifies a family of six and does not qualify somebody
 * living alone — which means who lives there is not a detail, it is half the
 * calculation.
 *
 * Reachable by the applicant themselves, the councillor capturing for them, and
 * administrators. The same access rules as the rest of the application.
 */
const router = express.Router();
router.use(...protect);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

const MAX_MEMBERS = 30;

/** Age from a date of birth, or from an ID number, or as stated. */
function resolveAge({ dateOfBirth, age, idNumber }) {
  if (dateOfBirth) {
    const years = Math.floor((Date.now() - new Date(dateOfBirth)) / (365.25 * 86400000));
    if (years >= 0 && years < 130) return { age: years, dateOfBirth: new Date(dateOfBirth) };
  }
  if (idNumber) {
    const check = saId.validate(idNumber);
    if (check.valid) {
      const years = Math.floor((Date.now() - check.birthDate) / (365.25 * 86400000));
      return { age: years, dateOfBirth: check.birthDate };
    }
  }
  const stated = parseInt(age, 10);
  if (Number.isFinite(stated) && stated >= 0 && stated < 130) return { age: stated, dateOfBirth: null };
  return { age: null, dateOfBirth: null };
}

/**
 * Keep the headline counts in step with the list.
 *
 * The wizard asks for "people on the property" as a number and then asks who
 * they are. Two answers to one question drift apart, and a reviewer seeing
 * "6 people" above a list of three has to decide which to believe. Once anybody
 * is listed, the list is the truth.
 */
async function syncCounts(applicationId, tx = prisma) {
  const members = await tx.householdMember.findMany({
    where: { applicationId },
    select: { age: true, monthlyIncome: true },
  });
  if (members.length === 0) return null;

  // +1 throughout: the applicant is a member of their own household but is not
  // listed as one, because their details are the application.
  const application = await tx.application.findUnique({
    where: { id: applicationId },
    select: { idNumber: true },
  });
  const applicantCheck = application?.idNumber ? saId.validate(application.idNumber) : { valid: false };
  const applicantAge = applicantCheck.valid
    ? Math.floor((Date.now() - applicantCheck.birthDate) / (365.25 * 86400000))
    : null;

  const ages = [...members.map((m) => m.age), applicantAge].filter((a) => Number.isFinite(a));

  return tx.application.update({
    where: { id: applicationId },
    data: {
      peopleOnProperty: members.length + 1,
      childrenUnder18: ages.filter((a) => a < 18).length,
      adults: ages.filter((a) => a >= 18).length,
      pensionersOver60: ages.filter((a) => a >= 60).length,
    },
  });
}

/** The household on one application. */
router.get('/:id/household', access.loadFor('view'), async (req, res) => {
  try {
    const members = await prisma.householdMember.findMany({
      where: { applicationId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: members,
      summary: {
        listed: members.length,
        // Plus the applicant, who is not listed among their own dependants.
        total: members.length + 1,
        children: members.filter((m) => Number.isFinite(m.age) && m.age < 18).length,
        pensioners: members.filter((m) => Number.isFinite(m.age) && m.age >= 60).length,
        earners: members.filter((m) => Number(m.monthlyIncome) > 0).length,
        memberIncome: members.reduce((sum, m) => sum + Number(m.monthlyIncome || 0), 0),
      },
    });
  } catch (error) {
    console.error('household list error:', error);
    res.status(500).json({ success: false, message: 'We could not load the household. Please try again.' });
  }
});

/** Add somebody. */
router.post('/:id/household', access.loadFor('edit'), async (req, res) => {
  try {
    const { fullName, relationship, idNumber, dateOfBirth, age, monthlyIncome, isDependant, notes } = req.body || {};

    if (!fullName?.trim()) {
      return res.status(400).json({ success: false, message: 'Please enter a name.' });
    }

    const count = await prisma.householdMember.count({ where: { applicationId: req.params.id } });
    if (count >= MAX_MEMBERS) {
      return res.status(400).json({ success: false, message: `No more than ${MAX_MEMBERS} household members can be listed.` });
    }

    // An ID number is welcome but never demanded. Informal households routinely
    // have no document for every child living there, and refusing the whole
    // application over that would defeat the register's purpose.
    if (idNumber) {
      const check = saId.validate(idNumber);
      if (!check.valid) return res.status(400).json({ success: false, message: `${fullName}: ${check.reason}` });
    }

    const resolved = resolveAge({ dateOfBirth, age, idNumber });

    const member = await prisma.householdMember.create({
      data: {
        applicationId: req.params.id,
        fullName: fullName.trim(),
        relationship: relationship?.trim() || null,
        idNumber: idNumber?.trim() || null,
        dateOfBirth: resolved.dateOfBirth,
        age: resolved.age,
        monthlyIncome: monthlyIncome === '' || monthlyIncome === undefined || monthlyIncome === null
          ? null
          : Number(monthlyIncome),
        isDependant: isDependant === undefined ? true : Boolean(isDependant),
        notes: notes?.trim() || null,
      },
    });

    const application = await syncCounts(req.params.id);

    res.status(201).json({ success: true, message: `${member.fullName} added`, data: member, application });
  } catch (error) {
    console.error('household create error:', error);
    res.status(500).json({ success: false, message: 'We could not add that person. Please try again.' });
  }
});

router.patch('/:id/household/:memberId', access.loadFor('edit'), async (req, res) => {
  try {
    const existing = await prisma.householdMember.findFirst({
      where: { id: req.params.memberId, applicationId: req.params.id },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'We could not find that person.' });

    const { fullName, relationship, idNumber, dateOfBirth, age, monthlyIncome, isDependant, notes } = req.body || {};

    if (idNumber) {
      const check = saId.validate(idNumber);
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
    }

    const resolved = resolveAge({
      dateOfBirth: dateOfBirth ?? existing.dateOfBirth,
      age: age ?? existing.age,
      idNumber: idNumber ?? existing.idNumber,
    });

    const member = await prisma.householdMember.update({
      where: { id: existing.id },
      data: {
        ...(fullName !== undefined ? { fullName: fullName.trim() } : {}),
        ...(relationship !== undefined ? { relationship: relationship?.trim() || null } : {}),
        ...(idNumber !== undefined ? { idNumber: idNumber?.trim() || null } : {}),
        ...(notes !== undefined ? { notes: notes?.trim() || null } : {}),
        ...(isDependant !== undefined ? { isDependant: Boolean(isDependant) } : {}),
        ...(monthlyIncome !== undefined
          ? { monthlyIncome: monthlyIncome === '' || monthlyIncome === null ? null : Number(monthlyIncome) }
          : {}),
        age: resolved.age,
        dateOfBirth: resolved.dateOfBirth,
      },
    });

    const application = await syncCounts(req.params.id);
    res.json({ success: true, message: 'Household member updated', data: member, application });
  } catch (error) {
    console.error('household update error:', error);
    res.status(500).json({ success: false, message: 'We could not save those changes. Please try again.' });
  }
});

router.delete('/:id/household/:memberId', access.loadFor('edit'), async (req, res) => {
  try {
    const existing = await prisma.householdMember.findFirst({
      where: { id: req.params.memberId, applicationId: req.params.id },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'We could not find that person.' });

    await prisma.householdMember.delete({ where: { id: existing.id } });
    const application = await syncCounts(req.params.id);

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICATION,
      entityType: 'Application',
      entityId: req.params.id,
      details: `Removed ${existing.fullName} from the household`,
    });

    res.json({ success: true, message: `${existing.fullName} removed`, application });
  } catch (error) {
    console.error('household delete error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that person. Please try again.' });
  }
});

module.exports = router;
