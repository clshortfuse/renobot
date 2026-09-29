// Known test Discord ID used in receipt fixtures; never an access recipient.
export const testSupporterDiscordUserId = '012345678901234567';

/** @param {Date} start @param {number} months */
export function addCalendarMonths(start, months) {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const target = new Date(start);
  target.setUTCDate(1);
  target.setUTCFullYear(year, month + months, 1);
  const lastDay = new Date(target);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay.getUTCDate()));
  return target;
}

/**
 * @param {import('@prisma/client').Prisma.Decimal} total
 * @param {number} creditedMonths
 * @param {Date} start
 */
export function newlyEarnedMonths(total, creditedMonths, start) {
  const earned = total.div(5).floor().sub(creditedMonths);
  if (earned.lte(0)) return 0;
  // Keep the period representable; the remaining dollar balance stays available.
  const maximum = Math.max(0, (9999 - start.getUTCFullYear()) * 12 + 11 - start.getUTCMonth());
  return Math.min(earned.toNumber(), maximum);
}