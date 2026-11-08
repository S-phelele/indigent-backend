/**
 * Banks VerifyNow can check an account at, with the universal branch code each
 * one is sent under.
 *
 * Taken from VerifyNow's published list (www.verifynow.co.za/api-docs, "Get
 * supported banks"). They also serve it live at GET /bank-account-verification/banks;
 * it is kept here so the officer's drop-down works with no network call and so
 * the list a check was made against is visible in the code.
 *
 * Notably absent: **Postbank**. Many grant recipients are paid into Postbank
 * accounts, and VerifyNow cannot check them. The portal says so, and the officer
 * records that check by hand instead.
 *
 * Capitec Bank and Capitec Business are different things at the bank; only
 * personal Capitec is listed, because this checks individuals.
 */
const BANKS = [
  { name: 'Absa Bank', bankName: 'ABSA', bankCode: '632005' },
  { name: 'Access Bank', bankName: 'ACCESS BANK', bankCode: '410506' },
  { name: 'African Bank', bankName: 'AFRICAN BANK', bankCode: '430000' },
  { name: 'Bank Zero', bankName: 'BANK ZERO', bankCode: '888000' },
  { name: 'Bidvest Bank', bankName: 'BIDVEST BANK', bankCode: '462005' },
  { name: 'Capitec Bank', bankName: 'CAPITEC BANK', bankCode: '470010' },
  { name: 'Discovery Bank', bankName: 'DISCOVERY BANK', bankCode: '679000' },
  { name: 'First National Bank (FNB)', bankName: 'FNB', bankCode: '250655' },
  { name: 'GoTyme Bank', bankName: 'TYME BANK', bankCode: '678910' },
  { name: 'Grindrod Bank', bankName: 'GRINDROD BANK', bankCode: '584000' },
  { name: 'Investec Bank', bankName: 'INVESTEC BANK', bankCode: '580105' },
  { name: 'Nedbank', bankName: 'NEDBANK', bankCode: '198765' },
  { name: 'OM Bank', bankName: 'OM BANK', bankCode: '352000' },
  { name: 'Old Mutual (Legacy)', bankName: 'OLD MUTUAL', bankCode: '462005' },
  { name: 'Sasfin Bank', bankName: 'SASFIN BANK', bankCode: '683000' },
  { name: 'Standard Bank', bankName: 'STANDARD BANK', bankCode: '051001' },
];

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Find a bank from whatever was typed or chosen: its VerifyNow name ("FNB"), its
 * display name ("First National Bank (FNB)") or its branch code. Null if unknown.
 */
function find(input) {
  const q = norm(input);
  if (!q) return null;
  return BANKS.find((b) => [b.bankName, b.name, b.bankCode].some((x) => norm(x) === q)) || null;
}

/** A six-digit branch code, leading zeros kept (Standard Bank is 051001). */
const isBranchCode = (v) => /^\d{6}$/.test(String(v ?? '').trim());

module.exports = { BANKS, find, isBranchCode };
