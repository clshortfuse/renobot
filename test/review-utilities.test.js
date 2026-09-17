import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMessageContent } from '../src/reviews/collect-messages.js';
import { splitDiscordContent } from '../src/reviews/discord-content.js';

describe('review utilities', () => {
  it('splits generated reviews below the Discord message limit', () => {
    const chunks = splitDiscordContent(
      `${'first '.repeat(30)}\n${'second '.repeat(30)}`,
      150,
    );

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 150));
    assert.equal(chunks.join(' ').replaceAll(/\s+/gu, ' ').trim(),
      `${'first '.repeat(30)} ${'second '.repeat(30)}`.replaceAll(/\s+/gu, ' ').trim());
  });

  it('normalizes text, attachments, and stickers for compaction', () => {
    const message = /** @type {import('discord.js').Message<true>} */ (
      /** @type {unknown} */ ({
        attachments: new Map([['attachment', { name: 'example.zip' }]]),
        cleanContent: 'Update available.\r\n\r\n\r\nPlease test.',
        stickers: new Map([['sticker', { name: 'Renobot' }]]),
      })
    );

    assert.equal(
      formatMessageContent(message),
      'Update available.\n\nPlease test. [attachment: example.zip] [sticker: Renobot]',
    );
  });
});