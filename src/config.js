/**
 * @typedef {Readonly<{
 *   token: string,
 *   messageContentIntent: boolean,
 *   ownerUserId: string,
 *   reviewCollection: ReviewCollectionConfig,
 * }>} BotConfig
 */

/**
 * @typedef {Readonly<{
 *   includeBots: boolean,
 *   lookbackDays: number,
 *   maxMessages: number,
 * }>} ReviewCollectionConfig
 */

/**
 * @typedef {Readonly<{
 *   token: string,
 *   applicationId: string,
 *   guildId: string,
 * }>} CommandRegistrationConfig
 */

/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {BotConfig}
 */
export function readBotConfig(environment = process.env) {
  return Object.freeze({
    token: requiredEnvironmentVariable(environment, 'DISCORD_TOKEN'),
    messageContentIntent: optionalBoolean(
      environment,
      'DISCORD_MESSAGE_CONTENT_INTENT',
      false,
    ),
    ownerUserId: requiredSnowflake(environment, 'DISCORD_OWNER_USER_ID'),
    reviewCollection: readReviewCollectionConfig(environment),
  });
}

/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {ReviewCollectionConfig}
 */
export function readReviewCollectionConfig(environment = process.env) {
  return Object.freeze({
    includeBots: optionalBoolean(environment, 'REVIEW_INCLUDE_BOTS', false),
    lookbackDays: optionalInteger(
      environment,
      'REVIEW_LOOKBACK_DAYS',
      7,
      1,
      30,
    ),
    maxMessages: optionalInteger(
      environment,
      'REVIEW_MAX_MESSAGES',
      2_500,
      1,
      10_000,
    ),
  });
}

/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {CommandRegistrationConfig}
 */
export function readCommandRegistrationConfig(environment = process.env) {
  return Object.freeze({
    token: requiredEnvironmentVariable(environment, 'DISCORD_TOKEN'),
    applicationId: requiredEnvironmentVariable(environment, 'DISCORD_CLIENT_ID'),
    guildId: requiredSnowflake(environment, 'DISCORD_GUILD_ID'),
  });
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} name
 * @returns {string}
 */
function requiredEnvironmentVariable(environment, name) {
  const value = environment[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be set.`);
  }

  return value;
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} name
 * @returns {string}
 */
function requiredSnowflake(environment, name) {
  const value = requiredEnvironmentVariable(environment, name);

  if (!/^\d{17,20}$/u.test(value)) {
    throw new Error(`${name} must be a Discord ID.`);
  }

  return value;
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} name
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function optionalBoolean(environment, name, defaultValue) {
  const value = environment[name]?.trim().toLowerCase();

  if (!value) {
    return defaultValue;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} name
 * @param {number} defaultValue
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function optionalInteger(
  environment,
  name,
  defaultValue,
  minimum,
  maximum,
) {
  const rawValue = environment[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }

  return value;
}