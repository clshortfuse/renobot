import { createBot } from './bot.js';
import { isIP } from 'node:net';
import { loadCommands } from './commands/load-commands.js';
import { readBotConfig, readCommandRegistrationConfig } from './config.js';
import { readSecurityAutodeleteConfig } from './security-autodelete.js';
import { connectPortalDatabase } from './database.js';
import { createShutdown, installProcessHandlers } from './lifecycle.js';
import { logger } from './logger.js';
import { readModderSettingsConfig } from './modder-settings.js';
import { startEarlyAccessRoleWorker, startSupporterRoleWorker } from './supporter-roles.js';
import { createReviewCollectionPreview } from './reviews/collection-preview.js';
import { readWebConfig } from './web-config.js';
import { createWebServer } from './web-server.js';
import { createVerificationMailer, readMailConfig } from './verification-mail.js';

/** @type {import('./database.js').PortalDatabase | undefined} */
let database;
try {
  const config = readBotConfig();
  const guildId = readCommandRegistrationConfig().guildId;
  const securityChannelId = process.env.DISCORD_SECURITY_CHANNEL_ID?.trim() || undefined;
  const securityAutodelete = readSecurityAutodeleteConfig();
  if (securityAutodelete && (!securityChannelId || !guildId || securityAutodelete.channelId === securityChannelId)) {
    throw new Error('Honeypot correlation requires guild/security configuration and a distinct honeypot channel.');
  }
  if (securityChannelId && !/^\d{17,20}$/u.test(securityChannelId)) throw new Error('Invalid DISCORD_SECURITY_CHANNEL_ID.');
  if (securityChannelId && !config.messageContentIntent) throw new Error('Security detection requires DISCORD_MESSAGE_CONTENT_INTENT=true; unset DISCORD_SECURITY_CHANNEL_ID to disable.');
  database = await connectPortalDatabase(process.env.DATABASE_URL);
  const commands = await loadCommands();
  const reviewCollection = createReviewCollectionPreview({
    ...config.reviewCollection,
    logger,
  });
  const client = createBot({
    commands,
    logger,
    messageContentIntent: config.messageContentIntent,
    ownerUserId: config.ownerUserId,
    summarizeRoleId: process.env.DISCORD_SUMMARIZE_ROLE_ID?.trim(),
    guildId,
    securityChannelId,
    securityAutodelete,
    reviewCollection,
  });
  const webConfig = readWebConfig();
  const mailConfig = readMailConfig();
  if (mailConfig && (!webConfig || !database)) throw new Error('Email verification requires the dashboard and database.');
  const settingsConfig = readModderSettingsConfig();
  if (settingsConfig && !database) throw new Error('Modder settings require DATABASE_URL.');
  const supporterRoleId = process.env.DISCORD_SUPPORTER_ROLE_ID?.trim();
  const earlyAccessRoleId = process.env.DISCORD_EARLY_ACCESS_ROLE_ID?.trim();
  const trustedKofiProxyIp = process.env.KOFI_TRUSTED_PROXY_IP?.trim();
  if (trustedKofiProxyIp && !isIP(trustedKofiProxyIp)) throw new Error('KOFI_TRUSTED_PROXY_IP must be a single IP address.');
  if (supporterRoleId && (!/^\d{17,20}$/u.test(supporterRoleId) || !settingsConfig || !database)) {
    throw new Error('DISCORD_SUPPORTER_ROLE_ID requires a Discord role ID and Ko-fi database settings.');
  }
  if (earlyAccessRoleId && (!/^\d{17,20}$/u.test(earlyAccessRoleId) || earlyAccessRoleId === supporterRoleId
    || !settingsConfig || !database)) {
    throw new Error('DISCORD_EARLY_ACCESS_ROLE_ID requires a distinct Discord role ID and Ko-fi database settings.');
  }
  const webServer = webConfig ? createWebServer({ bot: client, config: webConfig, logger,
    ...(mailConfig ? { sendVerificationEmail: createVerificationMailer(mailConfig) } : {}),
    ...(database ? { database } : {}), ...(settingsConfig ? { settingsConfig } : {}),
    ...(supporterRoleId ? { supporterRoleId } : {}),
    ...(earlyAccessRoleId ? { earlyAccessRoleId } : {}),
    ...(trustedKofiProxyIp ? { trustedKofiProxyIp } : {}) }) : undefined;
  const shutDown = createShutdown({ client, logger, ...(webServer ? { webServer } : {}), ...(database ? { database } : {}) });
  const stopSupporterWorker = supporterRoleId && database
    ? startSupporterRoleWorker(database, client, readCommandRegistrationConfig().guildId, supporterRoleId, logger)
    : undefined;
  const stopEarlyAccessWorker = earlyAccessRoleId && database
    ? startEarlyAccessRoleWorker(database, client, readCommandRegistrationConfig().guildId, earlyAccessRoleId, logger)
    : undefined;
  let stopping = false;
  /** @type {NodeJS.Timeout | undefined} */
  let loginRetry;
  installProcessHandlers({
    logger,
    shutDown: async (reason, exitCode) => {
      stopping = true;
      if (loginRetry) clearTimeout(loginRetry);
      stopSupporterWorker?.();
      stopEarlyAccessWorker?.();
      await shutDown(reason, exitCode);
    },
  });

  if (webConfig && webServer) {
    await new Promise((resolve, reject) => {
      webServer.once('error', reject);
      webServer.listen(webConfig.port, webConfig.host, () => {
        webServer.off('error', reject);
        resolve(undefined);
      });
    });
    logger.info({ host: webConfig.host, port: webConfig.port }, 'Renobot dashboard is listening');
  }
  async function connectBot() {
    if (stopping) return;
    try {
      await client.login(config.token);
    } catch (error) {
      if (stopping) return;
      logger.warn({ err: error }, 'Discord login failed; webhook receipts remain available, retrying');
      loginRetry = setTimeout(() => { void connectBot(); }, 30_000);
    }
  }
  void connectBot();
} catch (error) {
  logger.fatal({ err: error }, 'Renobot failed to start');
  await database?.disconnect();
  process.exitCode = 1;
}