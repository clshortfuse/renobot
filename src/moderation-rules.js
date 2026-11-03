/** Canonical rule IDs, menu/audit labels, and server policy text. */
export const moderationRules = Object.freeze([
  { id: '1', label: 'Rule 1 (Respect Others)', text: 'Treat everyone with respect. Absolutely no harassment, witch hunting, sexism, racism, or hate speech will be tolerated.' },
  { id: '2', label: 'Rule 2 (Spam / Self-Promotion)', text: 'No spam or self-promotion (server invites, advertisements, etc) without permission from a staff member. This includes DMing fellow members.' },
  { id: '3', label: 'Rule 3 (Obscene Content)', text: 'No age-restricted or obscene content. This includes text, images, or links featuring nudity, sex, hard violence, or other graphically disturbing content.' },
  { id: '4', label: 'Rule 4 (Piracy)', text: 'Piracy is not permitted. Do not share, request, or promote unauthorized content. This includes support.' },
  { id: '5', label: 'Rule 5 (Misleading Info)', text: "Avoid misleading or inaccurate info. Share what you know, and be upfront when you're unsure." },
  { id: '6', label: 'Rule 6 (Low-Effort Trolling)', text: "No low-effort trolling. Don't make us waste our time moderating garbage." },
  { id: '7', label: 'Rule 7 (Unnecessary Pings)', text: "Pinging people because you don't want to read the rules or pins is against the rules." },
  { id: '8', label: 'Rule 8 (Read Pins)', text: 'Read pins first. Comment second.' },
  { id: '9', label: 'Rule 9 (Unapproved Payloads)', text: 'No paid, private, or suspicious payloads without permissions from moderators.' },
].map(rule => Object.freeze(rule)));