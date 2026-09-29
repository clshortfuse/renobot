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
      if (page === 'app' || page === 'modder-kofi' || page === 'admin-kofi' || page === 'admin-early-access') location.assign(`/auth/discord?returnTo=${encodeURIComponent(location.pathname)}`);
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
        element('admin-kofi-link').hidden = !capabilities.includes('admin');
        element('admin-early-access-link').hidden = !capabilities.includes('admin');
        element('portal-navigation').hidden = false;
      } catch {
        element('access-status').hidden = false;
      }
    } else if (page === 'admin-early-access') {
      const status = element('early-access-status');
      const approvalStatus = element('early-access-approval-status');
      const content = element('early-access-content');
      const more = /** @type {HTMLButtonElement} */ (element('early-access-more'));
      const paymentsMore = /** @type {HTMLButtonElement} */ (element('early-access-contributions-more'));
      /** @type {string | null} */
      let cursor = null;
      /** @type {string | null} */
      let paymentCursor = null;
      /** @type {string | null} */
      let selected = null;
      let version = 0;
      let detailVersion = 0;
      /** @param {boolean} reset */
      async function loadPeople(reset) {
        if (reset) version++;
        const current = version;
        const path = `/app/api/admin/early-access${reset || !cursor ? '' : `?before=${encodeURIComponent(cursor)}`}`;
        more.disabled = true;
        try {
          const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
          if (response.status === 403) { status.textContent = 'Owner access required.'; return; }
          if (!response.ok) throw new Error('Review unavailable');
          /** @type {{ enabled: boolean, members: { discordUserId: string, discordName: string | null,
           * totalAmount: string, currency: string, creditedMonths: number, expiresAt: string | null,
           * active: boolean, roleManaged: boolean, syncStatus: string, nextAttemptAt: string | null }[], nextCursor: string | null }} */
          const result = await response.json();
          if (current !== version) return;
          const items = result.members.map((member) => {
            const row = document.createElement('tr');
            const person = document.createElement('td');
            const name = document.createElement('strong');
            name.textContent = member.discordName ?? 'Name unavailable';
            const id = document.createElement('span');
            id.className = 'membership-detail';
            id.textContent = member.discordUserId;
            person.append(name, id);
            const total = document.createElement('td');
            total.textContent = `${member.totalAmount} ${member.currency}`;
            const months = document.createElement('td');
            months.textContent = String(member.creditedMonths);
            const expiry = document.createElement('td');
            expiry.textContent = member.expiresAt
              ? `${member.active ? 'Active' : 'Expired'} · ${new Date(member.expiresAt).toLocaleString()}` : 'Not yet earned';
            const sync = document.createElement('td');
            sync.textContent = `${member.roleManaged ? 'Grant recorded' : 'Not managed'} · ${member.syncStatus}${member.nextAttemptAt ? ` · Next check ${new Date(member.nextAttemptAt).toLocaleString()}` : ''}`;
            const detail = document.createElement('td');
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Review payments';
            button.addEventListener('click', () => { void loadDetail(member.discordUserId, true); });
            detail.append(button);
            const approval = document.createElement('td');
            if (result.enabled && member.active && !member.roleManaged && member.syncStatus === 'idle') {
              const approve = document.createElement('button');
              approve.type = 'button';
              approve.textContent = 'Approve role';
              approve.addEventListener('click', () => {
                approve.disabled = true;
                approvalStatus.textContent = `Scheduling role for ${member.discordUserId}…`;
                void (async () => {
                  try {
                    const response = await fetch(`/app/api/admin/early-access/${encodeURIComponent(member.discordUserId)}/approve`, {
                      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                      body: new URLSearchParams({ csrf: session.csrf }),
                    });
                    if (!response.ok) throw new Error('Approval unavailable');
                    approvalStatus.textContent = `Role sync queued for ${member.discordUserId}.`;
                    await loadPeople(true);
                  } catch {
                    approvalStatus.textContent = `Could not approve ${member.discordUserId}; refresh before trying again.`;
                    approve.disabled = false;
                  }
                })();
              });
              approval.append(approve);
            }
            row.append(person, total, months, expiry, sync, detail, approval);
            return row;
          });
          if (reset) element('early-access-list').replaceChildren(...items);
          else element('early-access-list').append(...items);
          cursor = result.nextCursor;
          more.hidden = !cursor;
          content.hidden = false;
          status.textContent = result.enabled
            ? 'Recorded access and grants are shown below. Role presence on Discord is not checked live.'
            : 'Early-access role sync is disabled; stored credits are shown below.';
          if (reset && !result.members.length) status.textContent = 'No credited supporters yet.';
        } catch { if (current === version) status.textContent = 'Early-access review is temporarily unavailable.'; }
        finally { more.disabled = false; }
      }
      /** @param {string} userId @param {boolean} reset */
      async function loadDetail(userId, reset) {
        if (reset) { detailVersion++; paymentCursor = null; selected = userId; }
        const current = detailVersion;
        paymentsMore.disabled = true;
        element('early-access-detail-status').textContent = 'Loading credited payments…';
        try {
          const path = `/app/api/admin/early-access/${encodeURIComponent(userId)}${paymentCursor ? `?before=${encodeURIComponent(paymentCursor)}` : ''}`;
          const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('Detail unavailable');
          /** @type {{ periods: { startedAt: string, expiresAt: string, months: number }[], contributions: {
           * eventId: string, amount: string, currency: string, eventType: string, receivedAt: string,
           * modderDiscordUserId: string, modderUsername: string }[], nextCursor: string | null }} */
          const result = await response.json();
          if (current !== detailVersion) return;
          if (reset) element('early-access-periods').replaceChildren(...result.periods.map((period) => {
            const item = document.createElement('li');
            item.textContent = `${new Date(period.startedAt).toLocaleString()} → ${new Date(period.expiresAt).toLocaleString()} · ${period.months} month${period.months === 1 ? '' : 's'}`;
            return item;
          }));
          const items = result.contributions.map((entry) => {
            const item = document.createElement('li');
            item.textContent = `${new Date(entry.receivedAt).toLocaleString()} · ${entry.amount} ${entry.currency} · ${entry.eventType} · To ${entry.modderUsername} (${entry.modderDiscordUserId}) · Receipt ${entry.eventId}`;
            return item;
          });
          if (reset) element('early-access-contributions').replaceChildren(...items);
          else element('early-access-contributions').append(...items);
          paymentCursor = result.nextCursor;
          paymentsMore.hidden = !paymentCursor;
          element('early-access-detail').hidden = false;
          element('early-access-detail-status').textContent = `Credited payment history for ${userId}.`;
        } catch { if (current === detailVersion) element('early-access-detail-status').textContent = 'Could not load payment history.'; }
        finally { paymentsMore.disabled = false; }
      }
      more.addEventListener('click', () => { if (cursor && !more.disabled) void loadPeople(false); });
      paymentsMore.addEventListener('click', () => { if (selected && paymentCursor && !paymentsMore.disabled) void loadDetail(selected, false); });
      element('early-access-refresh').addEventListener('click', () => { void loadPeople(true); });
      await loadPeople(true);
    } else if (page === 'admin-kofi') {
      const status = element('admin-kofi-status');
      const first = await fetch('/app/api/admin/kofi/entries', { credentials: 'same-origin', cache: 'no-store' });
      if (first.status === 403) { status.textContent = 'Owner access required.'; return; }
      if (!first.ok) { status.textContent = 'Payment receipts are temporarily unavailable.'; return; }
      const content = element('admin-kofi-content');
      const more = /** @type {HTMLButtonElement} */ (element('admin-entries-more'));
      /** @type {string | null} */
      let cursor = null;
      let shown = 0;
      /** @param {Response} response @param {boolean} reset */
      async function renderEntries(response, reset) {
        /** @type {{ entries: { id: string, ownerDiscordUserId: string, ownerUsername: string,
         *   receivedAt: string, eventType: string, amount: string, currency: string,
         *   transactionId: string, outcome: string, sourceIp: string | null, sourcePort: number | null,
         *   sourceViaProxy: boolean, peerIp: string | null, peerPort: number | null }[], nextCursor: string | null }} */
        const result = await response.json();
        const items = result.entries.map((entry) => {
          const item = document.createElement('li');
          item.textContent = `${new Date(entry.receivedAt).toLocaleString()} · ${entry.ownerUsername} (${entry.ownerDiscordUserId}) · ${entry.eventType} · ${entry.amount} ${entry.currency} · Transaction ${entry.transactionId} · ${entry.outcome} · ${entry.sourceViaProxy ? 'Nginx observed' : 'Socket peer'} ${entry.sourceIp ?? 'unknown'}:${entry.sourcePort ?? 'unknown'} · Socket peer ${entry.peerIp ?? 'unknown'}:${entry.peerPort ?? 'unknown'}`;
          return item;
        });
        if (reset) { element('admin-entries-list').replaceChildren(...items); shown = 0; }
        else element('admin-entries-list').append(...items);
        shown += result.entries.length;
        cursor = result.nextCursor;
        more.hidden = !cursor;
        element('admin-entries-status').textContent = shown ? `Receipts shown: ${shown}` : 'No stored receipts yet.';
      }
      await renderEntries(first, true);
      content.hidden = false;
      status.textContent = 'Only the owner can read this activity.';
      more.addEventListener('click', () => {
        if (!cursor || more.disabled) return;
        more.disabled = true;
        void (async () => {
          try {
            const response = await fetch(`/app/api/admin/kofi/entries?before=${encodeURIComponent(cursor ?? '')}`,
              { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) throw new Error('Receipts unavailable');
            await renderEntries(response, false);
          } catch { element('admin-entries-status').textContent = 'Could not load older receipts.'; }
          finally { more.disabled = false; }
        })();
      });
      async function loadOperations() {
        try {
          const response = await fetch('/app/api/admin/kofi/operations', { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('Operations unavailable');
          /** @type {{ events: { at: string, event: string }[] }} */
          const { events } = await response.json();
          element('admin-operations-list').replaceChildren(...events.map((event) => {
            const item = document.createElement('li');
            item.textContent = `${new Date(event.at).toLocaleString()} · ${event.event}`;
            return item;
          }));
          element('admin-operations-status').textContent = events.length
            ? `Recent events: ${events.length} (current process only)` : 'No webhook events in this process yet.';
        } catch { element('admin-operations-status').textContent = 'Recent events are temporarily unavailable.'; }
      }
      element('admin-operations-refresh').addEventListener('click', () => { void loadOperations(); });
      await loadOperations();
    } else if (page === 'modder-kofi') {
      const status = element('settings-status');
      const form = /** @type {HTMLFormElement} */ (element('kofi-form'));
      /** @type {EventSource | undefined} */
      let events;
      /** @type {string | null} */
      let membersCursor = null;
      let membersCount = 0;
      let membersVersion = 0;
      /** @param {boolean} [reset] */
      async function loadMemberships(reset = true) {
        if (reset) membersVersion++;
        const version = membersVersion;
        const cursor = reset ? null : membersCursor;
        const more = /** @type {HTMLButtonElement} */ (element('kofi-memberships-more'));
        if (!reset) more.disabled = true;
        try {
          const response = await fetch(`/app/api/modder/kofi/memberships${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`,
            { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('Memberships unavailable');
          /** @type {{ members: { discordUserId: string, discordName: string | null, expiresAt: string, lastPaymentAt: string,
           *   active: boolean, roleStatus: string, nextAttemptAt: string | null }[], nextCursor: string | null }} */
          const { members, nextCursor } = await response.json();
          if (version !== membersVersion) return;
          const items = members.map((member) => {
            const item = document.createElement('tr');
            const role = { 'granted-by-renobot': 'Role grant recorded by Renobot',
              pending: 'Role sync pending', retrying: 'Role sync retrying',
              'not-managed': 'No Renobot-managed role', disabled: 'Role sync disabled' }[member.roleStatus]
              ?? 'Role status unavailable';
            const supporter = document.createElement('td');
            const name = document.createElement('strong');
            name.textContent = member.discordName ?? 'Name unavailable';
            const id = document.createElement('span');
            id.className = 'membership-detail';
            id.textContent = member.discordUserId;
            supporter.append(name, id);
            const membership = document.createElement('td');
            const state = document.createElement('span');
            state.className = `membership-state${member.active ? '' : ' expired'}`;
            state.textContent = member.active ? 'Active' : 'Expired';
            const expiry = document.createElement('time');
            expiry.dateTime = member.expiresAt;
            expiry.textContent = new Date(member.expiresAt).toLocaleString();
            membership.append(state, expiry);
            const payment = document.createElement('td');
            const paidAt = document.createElement('time');
            paidAt.dateTime = member.lastPaymentAt;
            paidAt.textContent = new Date(member.lastPaymentAt).toLocaleString();
            payment.append(paidAt);
            const sync = document.createElement('td');
            sync.textContent = role;
            if (member.nextAttemptAt) {
              const next = document.createElement('span');
              next.className = 'membership-detail';
              next.textContent = `Next check ${new Date(member.nextAttemptAt).toLocaleString()}`;
              sync.append(next);
            }
            const discord = document.createElement('td');
            const check = document.createElement('button');
            check.type = 'button';
            check.textContent = 'Check Discord role';
            check.addEventListener('click', () => {
              if (check.disabled) return;
              check.disabled = true;
              void (async () => {
                try {
                  const response = await fetch(`/app/api/modder/kofi/memberships/${encodeURIComponent(member.discordUserId)}`,
                    { credentials: 'same-origin', cache: 'no-store' });
                  if (!response.ok) throw new Error('Role lookup unavailable');
                  const { rolePresent } = await response.json();
                  check.textContent = rolePresent === null ? 'Role sync disabled'
                    : rolePresent ? 'Discord role present' : 'Discord role absent';
                } catch { check.textContent = 'Role lookup unavailable; retry'; }
                finally { check.disabled = false; }
              })();
            });
            discord.append(check);
            item.append(supporter, membership, payment, sync, discord);
            return item;
          });
          if (reset) { element('kofi-memberships-list').replaceChildren(...items); membersCount = 0; }
          else element('kofi-memberships-list').append(...items);
          membersCount += members.length;
          membersCursor = nextCursor;
          more.hidden = !nextCursor;
          element('kofi-memberships-status').textContent = membersCount
            ? `Memberships shown: ${membersCount}` : 'No qualifying memberships yet.';
        } catch {
          if (version === membersVersion) element('kofi-memberships-status').textContent = 'Membership status is temporarily unavailable.';
        } finally { more.disabled = false; }
      }
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
      /** @param {{ minimumAmount: string, currency: string, floor: string, active: boolean,
       *   hasVerificationToken: boolean, hasForwardUrl: boolean, prodUrl: string | null, lastWebhookAt: string | null }} settings */
      const showSettings = (settings) => {
        /** @type {HTMLInputElement} */ (element('minimum-amount')).value = settings.minimumAmount;
        /** @type {HTMLInputElement} */ (element('currency')).value = settings.currency;
        element('floor-note').textContent = `Minimum allowed: ${settings.floor} ${settings.currency}`;
        element('token-status').textContent = settings.hasVerificationToken ? 'Token configured (value hidden)' : 'Token not yet configured';
        element('forward-status').textContent = settings.hasForwardUrl ? 'Destination configured (value hidden)' : 'No forwarding destination';
        element('kofi-prod').hidden = !settings.prodUrl;
        element('kofi-prod-url').textContent = settings.prodUrl;
        element('kofi-role-status').textContent = settings.active
          ? 'Supporter role sync is enabled: qualifying recurring payments, including Ko-fi tests, renew membership for 35 days. Roles granted by others are never automatically removed.'
          : 'Supporter role sync is disabled. Receipts are stored without granting roles.';
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
            void loadMemberships();
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
      element('kofi-memberships').hidden = false;
      void loadMemberships();
      element('kofi-memberships-more').addEventListener('click', () => { void loadMemberships(false); });
      element('kofi-memberships-refresh').addEventListener('click', () => { void loadMemberships(); });
      element('kofi-entries-more').addEventListener('click', () => { void loadEntries(false); });
      status.textContent = 'Memberships and role-sync status are shown below. Ko-fi setup is available when needed.';
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
            status.textContent = 'Settings saved. See role activation status below; forwarding remains inactive.';
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
    } else if (page === 'admin-kofi') {
      element('admin-kofi-status').textContent = 'Owner activity is temporarily unavailable.';
    } else if (page === 'admin-early-access') {
      element('early-access-status').textContent = 'Early-access review is temporarily unavailable.';
    }
  }
}

void loadSession();
