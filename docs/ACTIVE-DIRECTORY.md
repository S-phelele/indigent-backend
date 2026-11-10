# Active Directory sign-in

Municipal staff sign in with their Windows account. Nobody creates their account
or issues them a password: they are pulled from the directory, and their role
comes from the AD group they belong to. Residents are unaffected and keep local
accounts.

## How it behaves

| | |
|---|---|
| **Who is checked** | Anyone signing in whose name is not a local account, or whose account is marked as a directory account. A local account (every resident, the break-glass administrator) is never sent to the directory. |
| **Who checks the password** | Active Directory. It is never stored, hashed or compared here, and AD's own lockout and expiry apply. |
| **Role** | From group membership, via `AD_ROLE_MAP`. Not in a mapped group = refused, with a message saying so. Several groups = the most privileged role. |
| **Account** | Created on first sign-in (or when an administrator imports them), keyed on the AD `objectGUID`. Applications, approvals and audit rows attach to it as for any other user. |
| **Leaving** | A scheduled sync (`AD_SYNC_INTERVAL_MINUTES`) deactivates anybody no longer in a mapped group or whose AD account is disabled. Deactivation is checked on every request, so an open session stops working on its next call. |
| **Never reactivates** | Coming back into a group does not switch an account on. An administrator turns it back on. |
| **Passwords** | Change/forgot/reset are refused for directory accounts; they use Windows. |
| **Directory down** | Directory accounts cannot sign in (clear message, no lockout counted). Local accounts still can — keep one local administrator. |

## Try it on your own machine, no directory needed

The `mock` provider has nine built-in people, all with the password `Passw0rd!`:

| Username | Group | Result |
|---|---|---|
| `jsuper` / `jadmin` / `jsupervise` / `jassess` / `jverify` / `jcapture` / `jcouncil` | one per role | signs in with that role |
| `joutsider` | `Finance-Clerks` (not mapped) | refused: not in a group that may use the system |
| `jleaver` | mapped, but disabled | refused |

1. Copy the AD block from `.env.example` into `.env`:
   `AD_ENABLED=true`, `AD_PROVIDER=mock`, and the `AD_ROLE_MAP` line. Leave `AD_SYNC_INTERVAL_MINUTES=0` while testing.
2. `npm run db:deploy` (adds the `AuthSource` column and enum), then `npm run dev`.
3. In the admin portal, sign in as `jadmin` / `Passw0rd!`. You land as an Administrator and no account was created by hand.
4. Staff → **Import from directory** to search and add people ahead of their first sign-in.
5. Automated check of all of this against your running API:
   `API=http://localhost:5000/api npm run verify:directory` (needs `DATABASE_URL`, and `npm run db:seed` first).

## Try the real LDAP code, still without Active Directory

`scripts/dev-ldap/` starts a throwaway OpenLDAP server that carries the AD
attributes the provider reads (`sAMAccountName`, `userPrincipalName`,
`memberOf`, `objectGUID`, `userAccountControl`), over both LDAPS and StartTLS
with a generated CA. Needs Linux/WSL with `slapd` and `openssl`.

```bash
scripts/dev-ldap/run.sh start /tmp/ldap
LDAP_TEST_CA=/tmp/ldap/ca.pem npm run verify:ldap      # 27 checks on the provider itself
scripts/dev-ldap/run.sh stop /tmp/ldap
```

To run the whole API against it, set `AD_PROVIDER=ldap`, `AD_URL=ldaps://localhost:6360`,
`AD_BASE_DN=ou=Staff,dc=city,dc=test`,
`AD_BIND_DN=cn=svc-indigent,ou=Service,dc=city,dc=test`, `AD_BIND_PASSWORD=SvcPass#1`,
`AD_TLS_CA=/tmp/ldap/ca.pem` and a role map using `Indigent-Admins` / `Indigent-Verification`.

**This is not Active Directory.** It proves the protocol, TLS, filter escaping and
the refusal rules. It cannot prove group nesting, AD lockout or password policy.

## Going live — what IT must give you

1. **Can the server reach a domain controller?** The API is hosted at
   `api.indigent.malcam.co.za`. A cloud server cannot reach an internal DC without
   a VPN or site-to-site link, and a DC must never be exposed to the internet. If
   there is no network path, use Microsoft Entra ID sign-in instead (see below).
2. **LDAPS on port 636** with a certificate the server can verify. If it is signed
   by an internal CA, give the CA's PEM file and set `AD_TLS_CA`.
3. **A read-only service account** (`AD_BIND_DN`) with permission to read users
   under `AD_BASE_DN`. It only looks people up; it does not sign anybody in.
4. **The groups**, one per role you will use, and who is in each. Put their names
   in `AD_ROLE_MAP`. Use a full DN as the key if two OUs hold a group with the same name.
5. **The base DN** of the OU that holds municipal staff, e.g. `OU=Staff,DC=city,DC=gov,DC=za`.
6. Whether staff sign in by short name (`jsmith`), UPN, or email. All three work by default.
7. Whether groups are nested (a team group inside `Indigent-Admins`). If so set
   `AD_NESTED_GROUPS=true` and use full DNs in the map. **Untested against real AD.**

### Rollout order

1. Deploy with `AD_ENABLED=false`, run `npm run db:deploy`. Nothing changes.
2. Set the `AD_*` values in a **test** environment. Sign in with one test account per role.
3. Staff → **Directory** shows the connection and any configuration problems.
4. In production, enable it. Existing local staff keep working.
5. For each existing staff member: Staff → **Link to Windows account**. They keep
   their account (and every application and approval attached to it) but now sign
   in with Windows. The last local administrator cannot be linked, and nobody can
   link their own account.
6. Keep at least one local administrator, with a long password stored safely, as
   the way back in if the directory is down.

### Check on site before relying on it

- Sign in with a user whose password has **expired** and one that is **locked out**
  in AD, and confirm the message is sensible.
- Remove a test user from their group, press **Sync now**, confirm they are
  deactivated and their open session ends.
- Stop the VPN, confirm sign-in says the directory is unreachable and local
  administrators still get in.
- Confirm two people with similar names cannot be confused (the provider refuses
  any search that matches more than one account).

## What is not built

- **Microsoft Entra ID / OIDC.** If the municipality's AD is synced to Entra ID
  (Microsoft 365), that route needs no VPN, supports multi-factor, and never sees a
  password. It would reuse everything here (role mapping, account creation, sync)
  and replace only the "check the password" step. Not built, pending IT's answer.
- **Single sign-on without typing a password** (Kerberos/Windows-integrated).
- Group changes take effect at the next sign-in or the next sync, not instantly.

## Settings

See the "Directory sign-in" block in `.env.example`; every setting is explained there.
