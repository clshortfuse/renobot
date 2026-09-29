/** A Ko-fi test membership with a synthetic verification token. Never commit creator tokens. */
export const membership = Object.freeze({
  verification_token: 'fixture-token',
  message_id: 'dcf12844-870b-4485-97e1-836aa7225ad2',
  timestamp: '2026-09-29T04:47:38Z',
  type: 'Subscription',
  is_public: true,
  from_name: 'Jo Example',
  message: null,
  amount: '5.00',
  url: 'https://ko-fi.com/Home/CoffeeShop?txid=00000000-1111-2222-3333-444444444444',
  email: 'jo.example@example.com',
  currency: 'USD',
  is_subscription_payment: true,
  is_first_subscription_payment: false,
  kofi_transaction_id: '00000000-1111-2222-3333-444444444444',
  shop_items: null,
  tier_name: 'Bronze',
  shipping: null,
  discord_username: 'Jo#4105',
  discord_userid: '012345678901234567',
});

export function membershipForm() {
  return new URLSearchParams({ data: JSON.stringify(membership) });
}