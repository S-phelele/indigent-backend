const { roleFor } = require('./directoryRoles');
const { DirectoryUnavailable } = require('./directory');

/**
 * Keeping access in step with the directory.
 *
 * Signing in checks the directory at that moment, but a session lasts up to
 * SESSION_HOURS, and somebody who leaves the municipality does not sign in again
 * to be told so. This sweep is what makes leaving the AD group the same act as
 * losing access: it re-reads everybody it provisioned and deactivates anyone the
 * directory no longer vouches for. `authenticate` checks `isActive` on every
 * request, so a deactivated person's open session stops working on its next call
 * rather than whenever the token expires.
 *
 * ## Fail safe, in both directions
 *
 *  - **Directory unreachable → change nothing.** An outage must never look like
 *    "everyone left" and lock the whole department out.
 *  - **Suspiciously many missing → change nothing.** If most of the staff appear
 *    to have vanished at once, the likelier story is a wrong base DN or a service
 *    account that lost its read rights, not a mass resignation. The sweep stops
 *    and says so rather than deactivating on a guess.
 *  - **Never reactivates.** Coming back into a group does not switch an account
 *    on; an administrator might have turned it off for a reason the directory
 *    cannot see.
 */

/** Past this share of staff missing, with at least MIN_FOR_GUARD of them, the sweep refuses. */
const MAX_MISSING_SHARE = 0.5;
const MIN_FOR_GUARD = 4;

/** Pure: decide each person's fate from what the directory said. */
function classify(user, entry, roleMap) {
  if (!entry || (entry.externalId && user.externalId && entry.externalId !== user.externalId)) {
    return { status: 'missing', reason: 'no longer in the directory' };
  }
  if (entry.disabled) return { status: 'gone', reason: 'their directory account is disabled' };
  const role = roleFor(entry.groups, roleMap);
  if (!role) return { status: 'gone', reason: 'they are no longer in any group that grants access' };
  return { status: 'ok', role };
}

function create({ prisma, getProvider, getRoleMap, audit, notify }) {
  async function run() {
    const provider = getProvider();
    const roleMap = getRoleMap();
    const users = await prisma.user.findMany({ where: { authSource: 'DIRECTORY', isActive: true } });
    const summary = { checked: users.length, deactivated: [], roleChanges: [], aborted: null };
    if (users.length === 0) return summary;

    const verdicts = [];
    for (const user of users) {
      try {
        const entry = user.directoryUsername ? await provider.lookup({ username: user.directoryUsername }) : null;
        verdicts.push({ user, entry, ...classify(user, entry, roleMap) });
      } catch (error) {
        if (error instanceof DirectoryUnavailable) {
          summary.aborted = `The directory could not be reached (${error.message}). No access was changed.`;
          return summary;
        }
        throw error;
      }
    }

    const leaving = verdicts.filter((v) => v.status !== 'ok');
    if (users.length >= MIN_FOR_GUARD && leaving.length / users.length > MAX_MISSING_SHARE) {
      summary.aborted = `${leaving.length} of ${users.length} staff appear to have left the directory at once. `
        + 'That looks like a configuration or permissions fault, not resignations, so no access was changed. '
        + 'Check AD_BASE_DN and the service account.';
      return summary;
    }

    for (const v of verdicts) {
      if (v.status === 'ok') {
        const before = v.user.role;
        const changes = { directorySyncedAt: new Date() };
        if (before !== v.role) changes.role = v.role;
        await prisma.user.update({ where: { id: v.user.id }, data: changes });
        if (changes.role) {
          summary.roleChanges.push({ email: v.user.email, from: before, to: v.role });
          await audit.record(null, {
            action: audit.ACTIONS.DIRECTORY_ROLE_CHANGE,
            entityType: 'User',
            entityId: v.user.id,
            details: `Role changed from ${before} to ${v.role} to follow directory group membership`,
            actor: { ...v.user, role: v.role },
          });
        }
        continue;
      }

      await prisma.user.update({ where: { id: v.user.id }, data: { isActive: false, directorySyncedAt: new Date() } });
      summary.deactivated.push({ email: v.user.email, reason: v.reason });
      await audit.record(null, {
        action: audit.ACTIONS.DIRECTORY_DEACTIVATE,
        entityType: 'User',
        entityId: v.user.id,
        details: `Deactivated ${v.user.email}: ${v.reason}`,
        actor: v.user,
      });
      await notify?.toAdmins({
        type: notify.TYPE.ACCOUNT_LOCKED,
        title: 'A staff account was deactivated',
        body: `${v.user.email} no longer has access because ${v.reason}.`,
        link: '/staff',
        entityType: 'User',
        entityId: v.user.id,
      });
    }

    return summary;
  }

  /** Run every AD_SYNC_INTERVAL_MINUTES (default 60). 0 disables it. */
  function schedule() {
    const minutes = parseInt(process.env.AD_SYNC_INTERVAL_MINUTES ?? '60', 10);
    if (!minutes || minutes <= 0) {
      console.log('[directory] scheduled sync disabled');
      return () => {};
    }
    const tick = async () => {
      try {
        const s = await run();
        if (s.aborted) console.warn(`[directory] sync stopped: ${s.aborted}`);
        else if (s.deactivated.length || s.roleChanges.length) {
          console.log(`[directory] sync: ${s.deactivated.length} deactivated, ${s.roleChanges.length} role change(s)`);
        }
      } catch (error) {
        // A failing sweep must not take the process down.
        console.error('[directory] sync failed:', error.message);
      }
    };
    const initial = setTimeout(tick, 30000);
    const timer = setInterval(tick, minutes * 60 * 1000);
    timer.unref?.();
    console.log(`[directory] syncing access every ${minutes} minute(s)`);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }

  return { run, schedule };
}

module.exports = { create, classify, MAX_MISSING_SHARE, MIN_FOR_GUARD };
