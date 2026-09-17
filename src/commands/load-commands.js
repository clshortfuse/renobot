import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { logger } from '../logger.js';

const defaultDirectoryUrl = new URL('./definitions/', import.meta.url);

/**
 * @param {URL} [directoryUrl]
 * @returns {Promise<Map<string, import('./command.js').Command>>}
 */
export async function loadCommands(directoryUrl = defaultDirectoryUrl) {
  const entries = await readdir(fileURLToPath(directoryUrl), {
    withFileTypes: true,
  });
  const commandFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .sort((left, right) => left.name.localeCompare(right.name));
  /** @type {Map<string, import('./command.js').Command>} */
  const commands = new Map();

  for (const commandFile of commandFiles) {
    const commandUrl = new URL(commandFile.name, directoryUrl);
    const commandModule = /** @type {{ default?: unknown }} */ (
      await import(commandUrl.href)
    );

    if (!isCommand(commandModule.default)) {
      throw new TypeError(
        `Command module ${commandFile.name} must default-export command data and an execute function.`,
      );
    }

    const command = commandModule.default;
    const commandName = command.data.name;

    if (commands.has(commandName)) {
      throw new Error(`Duplicate command name: ${commandName}`);
    }

    commands.set(commandName, command);
    logger.debug({ command: commandName }, 'Loaded command');
  }

  if (commands.size === 0) {
    throw new Error('No command modules were found.');
  }

  return commands;
}

/**
 * @param {unknown} value
 * @returns {value is import('./command.js').Command}
 */
function isCommand(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = /** @type {{ data?: unknown, execute?: unknown }} */ (value);

  if (!candidate.data || typeof candidate.data !== 'object') {
    return false;
  }

  const data = /** @type {{ name?: unknown, toJSON?: unknown }} */ (
    candidate.data
  );

  return (
    typeof data.name === 'string' &&
    typeof data.toJSON === 'function' &&
    typeof candidate.execute === 'function'
  );
}