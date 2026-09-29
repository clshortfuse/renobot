/** @param {string} id */
function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error('Page is incomplete');
  return node;
}

async function loadSession() {
  const page = document.body.dataset.page;
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      if (page === 'app' || page === 'modder-kofi') location.assign(`/auth/discord?returnTo=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (!response.ok) throw new Error('Session unavailable');
    const session = await response.json();
    if (page === 'home') {
      const link = /** @type {HTMLAnchorElement} */ (element('portal-link'));
      const account = element('account');
      link.href = '/app';
      account.textContent = `Signed in as ${session.username}`;
      account.hidden = false;
    } else if (page === 'app') {
      element('username').textContent = session.username;
      element('connection').textContent = session.ready ? 'Ready' : 'Not ready';
      /** @type {HTMLInputElement} */ (element('csrf')).value = session.csrf;
      /** @type {HTMLButtonElement} */ (element('sign-out')).disabled = false;
      try {
        const accessResponse = await fetch('/app/api/capabilities', { credentials: 'same-origin', cache: 'no-store' });
        if (accessResponse.status === 401) {
          location.assign('/auth/discord?returnTo=%2Fapp');
          return;
        }
        if (!accessResponse.ok) throw new Error('Access unavailable');
        const { capabilities } = await accessResponse.json();
        element('owner-badge').hidden = !capabilities.includes('admin');
        element('modder-badge').hidden = !capabilities.includes('modder') || capabilities.includes('admin');
        element('reviewer-badge').hidden = !capabilities.includes('appeal:review') || capabilities.includes('admin');
        element('kofi-link').hidden = !capabilities.includes('modder');
        element('portal-navigation').hidden = false;
      } catch {
        element('access-status').hidden = false;
      }
    } else if (page === 'modder-kofi') {
      const status = element('settings-status');
      const form = /** @type {HTMLFormElement} */ (element('kofi-form'));
      /** @type {EventSource | undefined} */
      let events;
      /** @type {string | null} */
      let entriesCursor = null;
      let entriesCount = 0;
      let entriesVersion = 0;
      /** @param {boolean} [reset] */
      async function loadEntries(reset = true) {
        if (reset) entriesVersion++;
        const version = entriesVersion;
        const cursor = reset ? null : entriesCursor;
        const more = /** @type {HTMLButtonElement} */ (element('kofi-entries-more'));
        if (!reset) more.disabled = true;
        const path = `/app/api/modder/kofi/entries${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`;
        try {
          const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('Entries unavailable');
        /** @type {{ entries: { transactionId: string, eventType: string, amount: string, currency: string,
         *   supporterDiscordUserId: string | null, tierName: string | null, subscriptionPayment: boolean,
         *   occurredAt: string, receivedAt: string, outcome: string }[], nextCursor: string | null }} */
          const { entries, nextCursor } = await response.json();
          if (version !== entriesVersion) return;
          const list = element('kofi-entries-list');
          const items = entries.map((entry) => {
            const item = document.createElement('li');
            item.textContent = `Paid ${new Date(entry.occurredAt).toLocaleString()} · Received ${new Date(entry.receivedAt).toLocaleString()} · ${entry.eventType} · ${entry.amount} ${entry.currency} · Transaction ${entry.transactionId} · ${entry.supporterDiscordUserId ?? 'No linked Discord account'} · ${entry.tierName ?? 'No tier'} · ${entry.subscriptionPayment ? 'Recurring' : 'One-time'} · ${entry.outcome}`;
            return item;
          });
          if (reset) { list.replaceChildren(...items); entriesCount = 0; }
          else list.append(...items);
          entriesCount += entries.length;
          entriesCursor = nextCursor;
          more.hidden = !nextCursor;
          element('kofi-entries-status').textContent = entriesCount ? `Entries shown: ${entriesCount}` : 'No payment entries yet.';
        } catch {
          if (version === entriesVersion) element('kofi-entries-status').textContent = 'Entries are temporarily unavailable. Try again.';
        } finally { more.disabled = false; }
      }
      /** @param {{ minimumAmount: string, currency: string, floor: string,
       *   hasVerificationToken: boolean, hasForwardUrl: boolean, prodUrl: string | null, lastWebhookAt: string | null }} settings */
      const showSettings = (settings) => {
        /** @type {HTMLInputElement} */ (element('minimum-amount')).value = settings.minimumAmount;
        /** @type {HTMLInputElement} */ (element('currency')).value = settings.currency;
        element('floor-note').textContent = `Minimum allowed: ${settings.floor} ${settings.currency}`;
        element('token-status').textContent = settings.hasVerificationToken ? 'Token configured (value hidden)' : 'Token not yet configured';
        element('forward-status').textContent = settings.hasForwardUrl ? 'Destination configured (value hidden)' : 'No forwarding destination';
        element('kofi-prod').hidden = !settings.prodUrl;
        element('kofi-prod-url').textContent = settings.prodUrl;
        element('kofi-webhook-status').textContent = settings.lastWebhookAt
          ? `Last verified delivery: ${new Date(settings.lastWebhookAt).toLocaleString()}`
          : settings.hasVerificationToken ? 'No verified deliveries yet.'
            : 'Enter your Ko-fi verification token above and save settings to create a webhook URL.';
        element('kofi-entries').hidden = !settings.prodUrl;
        if (settings.prodUrl) void loadEntries();
        form.hidden = false;
        if (settings.prodUrl && !events) {
          events = new EventSource('/app/api/modder/kofi/events');
          events.addEventListener('receipt', () => {
            element('kofi-webhook-status').textContent = 'New verified delivery recorded. See entries below.';
            void loadEntries();
          });
        }
      };
      const access = await fetch('/app/api/modder/kofi', { credentials: 'same-origin', cache: 'no-store' });
      if (access.status === 401) {
        location.assign('/auth/discord?returnTo=%2Fapp%2Fmodder%2Fkofi');
        return;
      }
      if (access.status === 403) { status.textContent = 'Modder access required.'; return; }
      if (!access.ok) { status.textContent = 'Settings are temporarily unavailable.'; return; }
      showSettings(await access.json());
      element('kofi-entries-more').addEventListener('click', () => { void loadEntries(false); });
      status.textContent = 'Webhook receipts can be recorded; supporter roles and forwarding are inactive.';
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          const button = /** @type {HTMLButtonElement} */ (element('save-settings'));
          button.disabled = true;
          try {
            const fields = new URLSearchParams({ csrf: session.csrf,
              minimumAmount: /** @type {HTMLInputElement} */ (element('minimum-amount')).value,
              currency: /** @type {HTMLInputElement} */ (element('currency')).value,
              verificationToken: /** @type {HTMLInputElement} */ (element('verification-token')).value,
              forwardUrlAction: /** @type {HTMLSelectElement} */ (element('forward-action')).value,
              forwardUrl: /** @type {HTMLInputElement} */ (element('forward-url')).value });
            const saved = await fetch('/app/api/modder/kofi', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fields });
            if (saved.status === 403) { events?.close(); form.hidden = true; status.textContent = 'Modder access is no longer available.'; return; }
            if (!saved.ok) { status.textContent = saved.status === 400 ? 'Check the amount, token, and destination.' : 'Could not save settings. Please try again.'; return; }
            showSettings(await saved.json());
            /** @type {HTMLInputElement} */ (element('verification-token')).value = '';
            /** @type {HTMLInputElement} */ (element('forward-url')).value = '';
            /** @type {HTMLSelectElement} */ (element('forward-action')).value = 'keep';
            status.textContent = 'Settings saved. Supporter roles and forwarding remain inactive.';
          } catch { status.textContent = 'Could not save settings. Please try again.'; }
          finally { button.disabled = false; }
        })();
      });
    }
  } catch {
    if (page === 'app') {
      element('username').textContent = 'Unavailable';
      element('connection').textContent = 'Unavailable';
    } else if (page === 'modder-kofi') {
      element('settings-status').textContent = 'Settings are temporarily unavailable.';
    }
  }
}

void loadSession();
