const express = require('express');
const prisma = require('../lib/prisma');
const { protect } = require('../middleware/auth');
const access = require('../lib/applicationAccess');
const income = require('../lib/income');
const audit = require('../lib/audit');
const cache = require('../lib/cache');

/**
 * Where the household's money comes from.
 *
 * One row per source, so a household with an old-age grant, a child grant and a
 * back room let out is three answers rather than a shape the form cannot hold.
 * The five columns this replaces could carry five kinds of income and no more.
 *
 * Reachable by the applicant, the councillor capturing for them, and
 * administrators — the same access rules as the rest of the application, and
 * enforced by the same `applicationAccess` loader rather than by a copy of it.
 */
const router = express.Router();
router.use(...protect);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

/** More than this from one household is a mistake, not a declaration. */
const MAX_SOURCES = 20;

/**
 * Recompute everything derived from the rows.
 *
 * Called after every change so the stored totals can never disagree with the
 * sources they come from. The means test reads `totalHouseholdIncome` and knows
 * nothing about this table, which is what keeps that module unchanged.
 */
async function syncTotals(applicationId, tx = prisma) {
  const [sources, application, household] = await Promise.all([
    tx.incomeSource.findMany({ where: { applicationId } }),
    tx.application.findUnique({
      where: { id: applicationId },
      select: { peopleOnProperty: true, declaredNoIncome: true },
    }),
    tx.householdMember.findMany({ where: { applicationId }, select: { monthlyIncome: true } }),
  ]);

  const figures = income.totals(sources, {
    people: application?.peopleOnProperty ?? 1,
    household,
  });

  return tx.application.update({
    where: { id: applicationId },
    data: {
      totalHouseholdIncome: figures.total,
      totalIncomePerPerson: figures.perPerson,
      // Kept in step rather than asked separately, so the form cannot hold two
      // contradictory answers about whether somebody works.
      employmentStatus: income.employmentStatusFor(sources, {
        declaredNoIncome: application?.declaredNoIncome,
      }),
    },
  });
}

/**
 * The questionnaire itself: the types, their labels, and what each one asks.
 *
 * Served rather than hardcoded in each client. Three screens render this — the
 * resident's portal, the mobile app and the councillor's capture form — and
 * three copies would drift, with the form used by the person least able to
 * check the result drifting furthest.
 *
 * Declared before `/:id/income` so "income-types" is never read as an id.
 */
router.get('/income-types', (req, res) => {
  res.json({ success: true, data: income.TYPES });
});

router.get('/:id/income', access.loadFor('view'), async (req, res) => {
  try {
    const sources = await prisma.incomeSource.findMany({
      where: { applicationId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: sources.map((s) => ({ ...s, label: income.labelFor(s.type), sentence: income.describe(s) })),
      declaredNoIncome: req.application?.declaredNoIncome ?? false,
      answered: income.answered(sources, { declaredNoIncome: req.application?.declaredNoIncome }),
    });
  } catch (error) {
    console.error('income list error:', error);
    res.status(500).json({ success: false, message: 'We could not load your income details. Please try again.' });
  }
});

router.post('/:id/income', access.loadFor('edit'), async (req, res) => {
  try {
    const check = income.validate(req.body || {});
    if (!check.valid) return res.status(400).json({ success: false, message: check.reason });

    const count = await prisma.incomeSource.count({ where: { applicationId: req.params.id } });
    if (count >= MAX_SOURCES) {
      return res.status(400).json({
        success: false,
        message: `No more than ${MAX_SOURCES} sources of income can be listed.`,
      });
    }

    const source = await prisma.incomeSource.create({
      data: { applicationId: req.params.id, ...check.data },
    });

    // Adding a source contradicts having declared none. Clear it rather than
    // letting the record say both.
    await prisma.application.update({
      where: { id: req.params.id },
      data: { declaredNoIncome: false },
    });

    const application = await syncTotals(req.params.id);

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICATION,
      entityType: 'Application',
      entityId: req.params.id,
      details: `Income added: ${income.describe(source)} — R${Number(source.monthlyAmount).toFixed(2)} a month`,
    });

    res.status(201).json({
      success: true,
      message: `${income.labelFor(source.type)} added`,
      data: { ...source, label: income.labelFor(source.type), sentence: income.describe(source) },
      application,
    });
  } catch (error) {
    console.error('income create error:', error);
    res.status(500).json({ success: false, message: 'We could not save that. Please try again.' });
  }
});

router.patch('/:id/income/:sourceId', access.loadFor('edit'), async (req, res) => {
  try {
    const existing = await prisma.incomeSource.findFirst({
      where: { id: req.params.sourceId, applicationId: req.params.id },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'We could not find that income entry.' });

    // Validated whole rather than field by field: the detail fields a row may
    // carry depend on its type, so a partial update could leave a business name
    // attached to a grant.
    const check = income.validate({ ...existing, ...req.body, type: req.body?.type || existing.type });
    if (!check.valid) return res.status(400).json({ success: false, message: check.reason });

    const source = await prisma.incomeSource.update({
      where: { id: existing.id },
      data: check.data,
    });

    const application = await syncTotals(req.params.id);

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICATION,
      entityType: 'Application',
      entityId: req.params.id,
      details: `Income updated: ${income.describe(source)} — R${Number(source.monthlyAmount).toFixed(2)} a month`,
    });

    res.json({
      success: true,
      message: 'Updated',
      data: { ...source, label: income.labelFor(source.type), sentence: income.describe(source) },
      application,
    });
  } catch (error) {
    console.error('income update error:', error);
    res.status(500).json({ success: false, message: 'We could not save that change. Please try again.' });
  }
});

router.delete('/:id/income/:sourceId', access.loadFor('edit'), async (req, res) => {
  try {
    const existing = await prisma.incomeSource.findFirst({
      where: { id: req.params.sourceId, applicationId: req.params.id },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'We could not find that income entry.' });

    await prisma.incomeSource.delete({ where: { id: existing.id } });
    const application = await syncTotals(req.params.id);

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICATION,
      entityType: 'Application',
      entityId: req.params.id,
      details: `Income removed: ${income.describe(existing)}`,
    });

    res.json({ success: true, message: 'Removed', application });
  } catch (error) {
    console.error('income delete error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that. Please try again.' });
  }
});

/**
 * "We have no income at all."
 *
 * A real answer, and the commonest one in this register — so it needs somewhere
 * to be recorded. Without it an empty list means both "they told us there is
 * nothing" and "nobody has asked yet", and only one of those is a form that can
 * be submitted.
 */
router.post('/:id/income/none', access.loadFor('edit'), async (req, res) => {
  try {
    const declared = req.body?.declared !== false;

    if (declared) {
      const count = await prisma.incomeSource.count({ where: { applicationId: req.params.id } });
      if (count > 0) {
        return res.status(400).json({
          success: false,
          message: 'Remove the income you have already listed before declaring that there is none.',
        });
      }
    }

    await prisma.application.update({
      where: { id: req.params.id },
      data: { declaredNoIncome: declared },
    });

    const application = await syncTotals(req.params.id);

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICATION,
      entityType: 'Application',
      entityId: req.params.id,
      details: declared ? 'Declared no household income' : 'Withdrew the declaration of no income',
    });

    res.json({
      success: true,
      message: declared ? 'Recorded that the household has no income.' : 'Cleared.',
      application,
    });
  } catch (error) {
    console.error('income none error:', error);
    res.status(500).json({ success: false, message: 'We could not save that. Please try again.' });
  }
});

module.exports = router;
