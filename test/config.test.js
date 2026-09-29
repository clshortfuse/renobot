import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readBotConfig,
  readCommandRegistrationConfig,
  readReviewCollectionConfig,
} from '../src/config.js';
import { readWebConfig } from '../src/web-config.js';

const validBotEnvironment = Object.freeze({
  DISCORD_TOKEN: 'token',
  DISCORD_OWNER_USER_ID: '12345678901234567',
});

describe('configuration', () => {
  it('reads and trims the bot token', () => {
    assert.deepEqual(readBotConfig({
      ...validBotEnvironment,
      DISCORD_TOKEN: '  token  ',
    }), {
      token: 'token',
      messageContentIntent: false,
      ownerUserId: '12345678901234567',
      reviewCollection: {
        includeBots: false,
        lookbackDays: 7,
        maxMessages: 2_500,
      },
    });
  });

  it('rejects a missing bot token', () => {
    assert.throws(
      () => readBotConfig({}),
      /DISCORD_TOKEN must be set/u,
    );
  });

  it('validates the owner user ID', () => {
    assert.throws(
      () =>
        readBotConfig({
          ...validBotEnvironment,
          DISCORD_OWNER_USER_ID: 'not-a-user',
        }),
      /DISCORD_OWNER_USER_ID must be a Discord ID/u,
    );
  });

  it('enables Message Content only through an explicit setting', () => {
    assert.equal(
      readBotConfig({
        ...validBotEnvironment,
        DISCORD_MESSAGE_CONTENT_INTENT: 'true',
      }).messageContentIntent,
      true,
    );
    assert.throws(
      () => readBotConfig({
        ...validBotEnvironment,
        DISCORD_MESSAGE_CONTENT_INTENT: 'pending',
      }),
      /DISCORD_MESSAGE_CONTENT_INTENT must be true or false/u,
    );
  });

  it('reads command registration settings', () => {
    assert.deepEqual(
      readCommandRegistrationConfig({
        DISCORD_TOKEN: 'token',
        DISCORD_CLIENT_ID: 'application',
        DISCORD_GUILD_ID: '23456789012345678',
      }),
      {
        token: 'token',
        applicationId: 'application',
        guildId: '23456789012345678',
      },
    );
  });

  it('requires a guild ID for command registration', () => {
    assert.throws(
      () =>
        readCommandRegistrationConfig({
          DISCORD_TOKEN: 'token',
          DISCORD_CLIENT_ID: 'application',
        }),
      /DISCORD_GUILD_ID must be set/u,
    );
  });

  it('reads bounded review collection settings', () => {
    assert.deepEqual(
      readReviewCollectionConfig({
        REVIEW_INCLUDE_BOTS: 'true',
        REVIEW_LOOKBACK_DAYS: '14',
        REVIEW_MAX_MESSAGES: '5000',
      }),
      {
        includeBots: true,
        lookbackDays: 14,
        maxMessages: 5_000,
      },
    );
  });

  it('rejects invalid review collection settings', () => {
    assert.throws(
      () => readReviewCollectionConfig({ REVIEW_INCLUDE_BOTS: 'sometimes' }),
      /REVIEW_INCLUDE_BOTS must be true or false/u,
    );
    assert.throws(
      () => readReviewCollectionConfig({ REVIEW_LOOKBACK_DAYS: '31' }),
      /REVIEW_LOOKBACK_DAYS must be an integer from 1 through 30/u,
    );
    assert.throws(
      () => readReviewCollectionConfig({ REVIEW_MAX_MESSAGES: '0' }),
      /REVIEW_MAX_MESSAGES must be an integer from 1 through 10000/u,
    );
  });

  it('keeps the dashboard disabled until dashboard settings are supplied', () => {
    assert.equal(readWebConfig({
      DISCORD_CLIENT_ID: 'application',
      DISCORD_OWNER_USER_ID: '12345678901234567',
    }), undefined);
  });

  it('reads bounded dashboard configuration', () => {
    assert.deepEqual(readWebConfig({
      DISCORD_CLIENT_ID: 'application',
      DISCORD_CLIENT_SECRET: 'client-secret',
      DISCORD_GUILD_ID: '23456789012345678',
      DISCORD_MODDER_ROLE_ID: '34567890123456789',
      DISCORD_MODERATOR_ROLE_ID: '45678901234567890',
      DISCORD_OWNER_USER_ID: '12345678901234567',
      HTTP_HOST: ' 127.0.0.1 ',
      HTTP_PORT: '3001',
      PUBLIC_BASE_URL: 'https://renobot.renodx.com/',
      SESSION_SECRET: '01234567890123456789012345678901',
    }), {
      clientId: 'application',
      clientSecret: 'client-secret',
      guildId: '23456789012345678',
      host: '127.0.0.1',
      modderRoleId: '34567890123456789',
      moderatorRoleId: '45678901234567890',
      ownerUserId: '12345678901234567',
      port: 3001,
      publicBaseUrl: new URL('https://renobot.renodx.com/'),
      sessionSecret: '01234567890123456789012345678901',
    });
  });

  it('rejects partial or unsafe dashboard configuration', () => {
    assert.equal(readWebConfig({ KOFI_TEST_MODE: 'true' }), undefined);
    assert.throws(() => readWebConfig({ PUBLIC_BASE_URL: 'https://renobot.renodx.com/' }),
      /Dashboard configuration requires/u);
    const base = {
      DISCORD_CLIENT_ID: 'application', DISCORD_CLIENT_SECRET: 'client-secret',
      DISCORD_GUILD_ID: '23456789012345678',
      DISCORD_OWNER_USER_ID: '12345678901234567',
      SESSION_SECRET: '01234567890123456789012345678901',
    };
    assert.equal(readWebConfig({ ...base, PUBLIC_BASE_URL: 'https://example.com/' })?.publicBaseUrl.href, 'https://example.com/');
    assert.throws(() => readWebConfig({ ...base, PUBLIC_BASE_URL: 'http://example.com/' }),
      /PUBLIC_BASE_URL/u);
    assert.throws(() => readWebConfig({ ...base, PUBLIC_BASE_URL: 'https://example.com/', SESSION_SECRET: 'short' }),
      /SESSION_SECRET/u);
    assert.throws(() => readWebConfig({ ...base, PUBLIC_BASE_URL: 'https://example.com/', HTTP_PORT: '0' }),
      /HTTP_PORT/u);
    assert.throws(() => readWebConfig({ ...base, PUBLIC_BASE_URL: 'https://example.com/', DISCORD_MODDER_ROLE_ID: 'invalid' }),
      /DISCORD_MODDER_ROLE_ID/u);
    assert.throws(() => readWebConfig({ ...base, PUBLIC_BASE_URL: 'https://example.com/', DISCORD_GUILD_ID: 'invalid' }),
      /DISCORD_GUILD_ID/u);
  });
});