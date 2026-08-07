const test = require('node:test');
const assert = require('node:assert/strict');

const slots = require('../src/lib/documentSlots');

/**
 * The conditional checklist.
 *
 * The rule these protect: nobody is asked for a document their circumstances
 * cannot produce. Asking a tenant for a title deed, or a pensioner for a
 * guardianship order, is how a register turns away the people it exists for.
 */

const typesFor = (application) => slots.slotsFor(application).map((s) => s.type);
const slotFor = (application, type) => slots.slotsFor(application).find((s) => s.type === type);

test('a bare draft gets the common core only', () => {
  const types = typesFor({});
  assert.ok(types.includes('ID_COPY'));
  assert.ok(types.includes('AFFIDAVIT'));
  assert.ok(!types.includes('PROOF_OF_OWNERSHIP'), 'tenure has not been answered yet');
  assert.ok(!types.includes('GUARDIANSHIP_ORDER'));
});

test('an owner is asked for proof of ownership, a tenant for a lease', () => {
  assert.ok(typesFor({ tenure: 'OWNER' }).includes('PROOF_OF_OWNERSHIP'));
  assert.ok(!typesFor({ tenure: 'OWNER' }).includes('LEASE_AGREEMENT'));

  assert.ok(typesFor({ tenure: 'TENANT' }).includes('LEASE_AGREEMENT'));
  assert.ok(!typesFor({ tenure: 'TENANT' }).includes('PROOF_OF_OWNERSHIP'));
});

test('an occupier is asked for neither', () => {
  // Somebody living on family land or in an informal dwelling has no deed and no
  // lease. The affidavit in the core list carries this case.
  const types = typesFor({ tenure: 'OCCUPIER' });
  assert.ok(!types.includes('PROOF_OF_OWNERSHIP'));
  assert.ok(!types.includes('LEASE_AGREEMENT'));
  assert.ok(types.includes('AFFIDAVIT'));
});

test('a deceased estate is asked for the estate documents, and they are required', () => {
  const application = { applicantCategory: 'DECEASED_ESTATE' };
  assert.equal(slotFor(application, 'COPY_OF_DEATH_CERT').importance, 'REQUIRED');
  assert.equal(slotFor(application, 'LETTER_OF_AUTHORITY').importance, 'REQUIRED');
  assert.equal(slotFor(application, 'MARRIAGE_CERTIFICATE').importance, 'OPTIONAL');
});

test('the same documents stay optional for everyone else', () => {
  assert.equal(slotFor({}, 'COPY_OF_DEATH_CERT').importance, 'OPTIONAL');
  assert.equal(slotFor({}, 'LETTER_OF_AUTHORITY').importance, 'OPTIONAL');
});

test('a child-headed household is asked for a social worker letter', () => {
  const application = { applicantCategory: 'CHILD_HEADED' };
  const types = typesFor(application);
  assert.ok(types.includes('BIRTH_CERTIFICATE'));
  assert.ok(types.includes('SOCIAL_WORKER_LETTER'));
  assert.equal(slotFor(application, 'SOCIAL_WORKER_LETTER').importance, 'REQUIRED');
  // A guardianship order may simply not exist for these households, so it is
  // asked for but never demanded.
  assert.equal(slotFor(application, 'GUARDIANSHIP_ORDER').importance, 'OPTIONAL');
});

test('a pensioner is asked for nothing extra', () => {
  // Their age is already in their ID number and their SASSA letter is already an
  // accepted route to financial evidence. Adding a slot would be theatre.
  assert.deepEqual(typesFor({ applicantCategory: 'PENSIONER' }), typesFor({ applicantCategory: 'STANDARD' }));
});

test('a disabled applicant is asked for a disability certificate', () => {
  assert.equal(slotFor({ applicantCategory: 'DISABLED' }, 'DISABILITY_CERTIFICATE').importance, 'REQUIRED');
});

test('category and tenure combine without duplicating a slot', () => {
  const list = slots.slotsFor({ applicantCategory: 'DECEASED_ESTATE', tenure: 'OWNER' });
  const types = list.map((s) => s.type);
  assert.equal(new Set(types).size, types.length, `duplicate slot in ${types.join(', ')}`);
  assert.ok(types.includes('PROOF_OF_OWNERSHIP'));
  assert.ok(types.includes('LETTER_OF_AUTHORITY'));
});

test('a category promotes a core slot rather than adding a second copy', () => {
  // COPY_OF_DEATH_CERT exists in the core as optional. A deceased estate must
  // end up with one slot marked required, not two slots.
  const list = slots.slotsFor({ applicantCategory: 'DECEASED_ESTATE' });
  const deathCerts = list.filter((s) => s.type === 'COPY_OF_DEATH_CERT');
  assert.equal(deathCerts.length, 1);
  assert.equal(deathCerts[0].importance, 'REQUIRED');
});

test('bank statements now satisfy the financial evidence group', () => {
  // Three routes, any one sufficient: payslip, grant letter, or statements.
  const financial = slots.slotsFor({})
    .filter((s) => s.group === slots.GROUPS.FINANCIAL_EVIDENCE)
    .map((s) => s.type);
  assert.deepEqual(new Set(financial), new Set(['PROOF_OF_INCOME', 'PROOF_OF_GRANT', 'BANK_STATEMENTS']));
});

test('any one financial document completes the application', () => {
  const base = slots.seedRows('a1', {}).map((r) => ({ ...r }));
  for (const type of ['PROOF_OF_INCOME', 'PROOF_OF_GRANT', 'BANK_STATEMENTS']) {
    const docs = base.map((d) => (
      ['ID_COPY', 'AFFIDAVIT', type].includes(d.type) ? { ...d, status: 'Uploaded' } : d
    ));
    assert.equal(slots.outstanding(docs).complete, true, `${type} alone should be enough`);
  }
});

// ---------------------------------------------------------------------------
// Reconciling an existing application after its answers change
// ---------------------------------------------------------------------------

test('changing tenure adds the new document and drops the empty old one', () => {
  const existing = slots.seedRows('a1', { tenure: 'OWNER' })
    .map((r, i) => ({ ...r, id: `d${i}`, filePath: null }));

  const { toCreate, toDelete } = slots.reconcile(existing, { id: 'a1', tenure: 'TENANT' });

  assert.ok(toCreate.some((d) => d.type === 'LEASE_AGREEMENT'));
  const deed = existing.find((d) => d.type === 'PROOF_OF_OWNERSHIP');
  assert.ok(toDelete.includes(deed.id), 'the empty deed slot should go');
});

test('a document already uploaded is never dropped', () => {
  // An applicant who supplied a lease and then corrected their tenure must not
  // silently lose the file they sent.
  const existing = slots.seedRows('a1', { tenure: 'TENANT' })
    .map((r, i) => ({ ...r, id: `d${i}`, filePath: null }))
    .map((d) => (d.type === 'LEASE_AGREEMENT' ? { ...d, status: 'Uploaded', filePath: '/uploads/lease.pdf' } : d));

  const { toDelete } = slots.reconcile(existing, { id: 'a1', tenure: 'OWNER' });
  const lease = existing.find((d) => d.type === 'LEASE_AGREEMENT');
  assert.ok(!toDelete.includes(lease.id), 'an uploaded lease must survive the change');
});

test('reconciling promotes an existing slot instead of recreating it', () => {
  const existing = slots.seedRows('a1', {})
    .map((r, i) => ({ ...r, id: `d${i}`, filePath: null }));

  const { toCreate, toUpdate } = slots.reconcile(existing, { id: 'a1', applicantCategory: 'DECEASED_ESTATE' });

  assert.ok(!toCreate.some((d) => d.type === 'COPY_OF_DEATH_CERT'), 'the slot already exists');
  const promotion = toUpdate.find((u) => u.id === existing.find((d) => d.type === 'COPY_OF_DEATH_CERT').id);
  assert.equal(promotion.importance, 'REQUIRED');
});

test('reconciling an unchanged application is a no-op', () => {
  const application = { id: 'a1', tenure: 'OWNER', applicantCategory: 'STANDARD' };
  const existing = slots.seedRows('a1', application).map((r, i) => ({ ...r, id: `d${i}`, filePath: null }));

  const { toCreate, toDelete, toUpdate } = slots.reconcile(existing, application);
  assert.deepEqual({ toCreate, toDelete, toUpdate }, { toCreate: [], toDelete: [], toUpdate: [] });
});

test('every slot in every combination has a name, type and hint', () => {
  const categories = ['STANDARD', 'PENSIONER', 'DECEASED_ESTATE', 'CHILD_HEADED', 'DISABLED'];
  const tenures = [undefined, 'OWNER', 'TENANT', 'OCCUPIER'];

  for (const applicantCategory of categories) {
    for (const tenure of tenures) {
      for (const slot of slots.slotsFor({ applicantCategory, tenure })) {
        assert.ok(slot.name, `${applicantCategory}/${tenure}: a slot has no name`);
        assert.ok(slot.type, `${slot.name} has no type`);
        assert.ok(['REQUIRED', 'OPTIONAL'].includes(slot.importance), `${slot.name} has a bad importance`);
        assert.ok(slot.hint && slot.hint.length > 10, `${slot.name} needs guidance text`);
      }
    }
  }
});
