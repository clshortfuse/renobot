import nodemailer from 'nodemailer';
import { normalizeEmail } from './account-email.js';

/** @param {NodeJS.ProcessEnv} [environment] */
export function readMailConfig(environment = process.env) {
  const names = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
  if (!names.some((name) => environment[name])) return undefined;
  if (names.some((name) => !environment[name]?.trim())) throw new Error(`Email verification requires ${names.join(', ')}.`);
  const port = Number(environment.SMTP_PORT || '587');
  if (![465, 587].includes(port)) throw new Error('SMTP_PORT must be 465 or 587.');
  const from = normalizeEmail(environment.SMTP_FROM ?? '');
  if (!from) throw new Error('SMTP_FROM must be an email address.');
  return { host: (environment.SMTP_HOST ?? '').trim(), port, from,
    user: (environment.SMTP_USER ?? '').trim(), password: environment.SMTP_PASSWORD ?? '' };
}

/** @param {NonNullable<ReturnType<typeof readMailConfig>>} config */
export function createVerificationMailer(config) {
  const transport = nodemailer.createTransport({ host: config.host, port: config.port,
    secure: config.port === 465, requireTLS: true, auth: { user: config.user, pass: config.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true });
  /** @param {string} email @param {string} link */
  return async (email, link) => {
    await transport.sendMail({ from: { name: 'Renobot', address: config.from },
      to: { name: '', address: email }, subject: 'Verify your Renobot payment email',
      text: `You requested to link this payment email to your signed-in Discord account on Renobot.\n\nOpen this link and confirm while signed in to the same Discord account:\n${link}\n\nThis link expires in 30 minutes. If you did not request this, ignore this message. It will not change any existing email ownership or assigned payments.` });
  };
}