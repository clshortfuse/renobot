/** Strip adjacent search context before deduplication or image inspection.
 * @template {{hit?: boolean}} T
 * @param {T[][]} groups
 */
export function searchHitMessages(groups) {
  return groups.flat().filter((message) => message.hit !== false);
}