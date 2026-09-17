const defaultMaximumCharacters = 1_900;

/**
 * @param {string} content
 * @param {number} [maxCharacters]
 * @returns {string[]}
 */
export function splitDiscordContent(
  content,
  maxCharacters = defaultMaximumCharacters,
) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100) {
    throw new RangeError('The Discord content limit must be at least 100.');
  }

  /** @type {string[]} */
  const chunks = [];
  let remaining = content.trim();

  while (remaining.length > maxCharacters) {
    let splitAt = remaining.lastIndexOf('\n', maxCharacters);

    if (splitAt < maxCharacters / 2) {
      splitAt = remaining.lastIndexOf(' ', maxCharacters);
    }

    if (splitAt < maxCharacters / 2) {
      splitAt = maxCharacters;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}