/**
 * The directory pieces, wired to the real database, audit trail and provider.
 *
 * The factories in directoryAuth.js and directorySync.js take their
 * dependencies as arguments so tests can pass fakes; this file is the one place
 * the real ones are plugged in, so routes just `require` it.
 */
const prisma = require('./prisma');
const audit = require('./audit');
const notify = require('./notify');
const directory = require('./directory');
const directoryAuth = require('./directoryAuth');
const directorySync = require('./directorySync');

const deps = {
  prisma,
  audit,
  notify,
  getProvider: () => directory.active(),
  getRoleMap: () => directory.roleMap(),
};

const auth = directoryAuth.create({
  ...deps,
  onRoleChange: (user, previousRole) => audit.record(null, {
    action: audit.ACTIONS.DIRECTORY_ROLE_CHANGE,
    entityType: 'User',
    entityId: user.id,
    details: `Role changed from ${previousRole} to ${user.role} to follow directory group membership`,
    actor: user,
  }),
});
const sync = directorySync.create(deps);

module.exports = { ...directory, auth, sync };
