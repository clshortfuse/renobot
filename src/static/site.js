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
      /** @param {{ minimumAmount: string, currency: string, floor: string,
       *   hasVerificationToken: boolean, hasForwardUrl: boolean, testUrl: string | null, lastTestAt: string | null }} settings */
      const showSettings = (settings) => {
        /** @type {HTMLInputElement} */ (element('minimum-amount')).value = settings.minimumAmount;
        /** @type {HTMLInputElement} */ (element('currency')).value = settings.currency;
        element('floor-note').textContent = `Minimum allowed: ${settings.floor} ${settings.currency}`;
        element('token-status').textContent = settings.hasVerificationToken ? 'Token configured (value hidden)' : 'Token not yet configured';
        element('forward-status').textContent = settings.hasForwardUrl ? 'Destination configured (value hidden)' : 'No forwarding destination';
        element('kofi-test').hidden = !settings.testUrl;
        element('kofi-test-url').textContent = settings.testUrl;
        element('kofi-test-status').textContent = settings.lastTestAt
          ? `Last verified delivery: ${new Date(settings.lastTestAt).toLocaleString()}` : 'No verified test delivery yet.';
        form.hidden = false;
        if (settings.testUrl && !events) {
          events = new EventSource('/app/api/modder/kofi/events');
          events.addEventListener('test-delivery', (event) => {
            try {
              const result = JSON.parse(/** @type {MessageEvent} */ (event).data);
              element('kofi-test-status').textContent = `Last verified delivery: ${new Date(result.receivedAt).toLocaleString()}`;
              element('kofi-test-details').textContent = `Verified test-format delivery: ${result.eventType}, ${result.amount} ${result.currency}; ${result.subscriptionPayment ? 'subscription payment' : 'not a subscription payment'}. Private supporter information is not shown.`;
            } catch { element('kofi-test-details').textContent = 'A test delivery arrived, but its status could not be displayed.'; }
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
      status.textContent = 'Settings can be saved, but no webhook or role processing is active.';
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
            status.textContent = 'Settings saved. Webhooks remain inactive.';
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
