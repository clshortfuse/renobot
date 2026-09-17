import { createBot } from './bot.js';
import { loadCommands } from './commands/load-commands.js';
import { readBotConfig, readCommandRegistrationConfig } from './config.js';
import { createShutdown, installProcessHandlers } from './lifecycle.js';
import { logger } from './logger.js';
import { createReviewCollectionPreview } from './reviews/collection-preview.js';
import { readWebConfig } from './web-config.js';
import { createWebServer } from './web-server.js';

try {
  const config = readBotConfig();
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
    guildId: readCommandRegistrationConfig().guildId,
    reviewCollection,
  });
  const webConfig = readWebConfig();
  const webServer = webConfig ? createWebServer({ bot: client, config: webConfig, logger }) : undefined;
  const shutDown = createShutdown({ client, logger, ...(webServer ? { webServer } : {}) });
  installProcessHandlers({
    logger,
    shutDown,
  });

  await client.login(config.token);
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
} catch (error) {
  logger.fatal({ err: error }, 'Renobot failed to start');
  process.exitCode = 1;
}