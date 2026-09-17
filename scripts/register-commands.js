import { REST, Routes } from 'discord.js';

import { loadCommands } from '../src/commands/load-commands.js';
import { readCommandRegistrationConfig } from '../src/config.js';
import { logger } from '../src/logger.js';

try {
  const config = readCommandRegistrationConfig();
  const commands = await loadCommands();
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const route = Routes.applicationGuildCommands(
    config.applicationId,
    config.guildId,
  );

  logger.info(
    {
      commandCount: body.length,
      scope: `guild:${config.guildId}`,
    },
    'Registering application commands',
  );

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(route, { body });

  logger.info('Application commands registered');
} catch (error) {
  logger.fatal({ err: error }, 'Application command registration failed');
  process.exitCode = 1;
}