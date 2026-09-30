// The locally served MDW bundle exposes its fluent component builder.
const material = /** @type {{ CustomElement: typeof import('@shortfuse/materialdesignweb/core/CustomElement.js').default } | undefined} */ (Reflect.get(globalThis, '@shortfuse/materialdesignweb'));
if (material) {
  material.CustomElement.extend()
    .observe({ emails: { type: 'array', value: [], reflect: false } })
    .html`<mdw-list aria-label="Verified email addresses"><mdw-list-item mdw-for="{email of emails}" supporting={email.label}>{email.email}<mdw-badge slot="trailing" color="primary-container" ink="on-primary-container">Verified</mdw-badge></mdw-list-item></mdw-list>`
    .register('renobot-emails');
  material.CustomElement.extend()
    .observe({ items: { type: 'array', value: [], reflect: false } })
    .html`
      <mdw-list id="payments" padding="8" aria-label="Payments"><mdw-list-item mdw-for="{item of items}" expandable divider supporting={item.received}>
        {item.recipient} · <mdw-box inline ink="primary">{item.amount}</mdw-box>
        <mdw-box slot="expansion" color="surface-container" padding="16" gap="8">
          <mdw-label>Payment type</mdw-label><mdw-body size="small">{item.paymentType}</mdw-body>
          <mdw-label>Transaction</mdw-label><mdw-body size="small">{item.transaction}</mdw-body>
          <mdw-label>Status</mdw-label><mdw-body size="small">{item.outcome}</mdw-body>
          <mdw-body size="small" ink="on-surface-variant" hidden={!item.source}>{item.source}</mdw-body>
          <mdw-body size="small" ink="on-surface-variant" hidden={!item.peer}>{item.peer}</mdw-body>
        </mdw-box>
      </mdw-list-item></mdw-list>
    `
    .register('renobot-payments');
  material.CustomElement.extend()
    .observe({ person: 'string', userId: 'string', membership: 'string', expiry: 'string', paidAt: 'string', sync: 'string', nextCheck: 'string', busy: 'boolean', roleLabel: { type: 'string', value: 'Check Discord role' } })
    .html`
      <mdw-grid padding="16" gap="8" y="center">
        <mdw-box gap="4" col-span="4" col-span-8="4" col-span-12="3"><mdw-title size="small">{person}</mdw-title><mdw-body size="small" ink="on-surface-variant">{userId}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-8="4" col-span-12="3"><mdw-label>{membership}</mdw-label><mdw-body size="small" ink="on-surface-variant">Until {expiry}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-8="4" col-span-12="2"><mdw-label size="small" ink="on-surface-variant">Last payment</mdw-label><mdw-body size="small">{paidAt}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-8="4" col-span-12="2"><mdw-body size="small">{sync}</mdw-body><mdw-body size="small" ink="on-surface-variant">{nextCheck}</mdw-body></mdw-box>
        <mdw-box x="start" col-span="4" col-span-8="8" col-span-12="2"><mdw-button id="check" disabled={busy}>{roleLabel}</mdw-button></mdw-box>
      </mdw-grid><mdw-divider></mdw-divider>
    `
    .childEvents({ check: { click() { this.dispatchEvent(new Event('check-role')); } } })
    .register('renobot-membership');
  material.CustomElement.extend()
    .observe({ person: 'string', userId: 'string', donated: 'string', months: 'string', expiry: 'string', sync: 'string', canApprove: 'boolean', busy: 'boolean' })
    .html`
      <mdw-card outlined><mdw-grid padding="24" gap="16">
        <mdw-box gap="4" col-span="4" col-span-8="8" col-span-12="12"><mdw-label size="small" ink="on-surface-variant">Discord user</mdw-label><mdw-title>{person}</mdw-title><mdw-body size="small" ink="on-surface-variant">{userId}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-12="6"><mdw-label size="small" ink="on-surface-variant">Donated</mdw-label><mdw-body>{donated}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-12="6"><mdw-label size="small" ink="on-surface-variant">Months earned</mdw-label><mdw-body>{months}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-12="6"><mdw-label size="small" ink="on-surface-variant">Access until</mdw-label><mdw-body>{expiry}</mdw-body></mdw-box>
        <mdw-box gap="4" col-span="4" col-span-12="6"><mdw-label size="small" ink="on-surface-variant">Role sync</mdw-label><mdw-body>{sync}</mdw-body></mdw-box>
        <mdw-box row wrap gap="8" col-span="4" col-span-8="8" col-span-12="12"><mdw-button id="review">Review payments</mdw-button><mdw-button id="approve" filled hidden={!canApprove} disabled={busy}>Approve role</mdw-button></mdw-box>
      </mdw-grid></mdw-card>
    `
    .childEvents({ review: { click() { this.dispatchEvent(new Event('review-payments')); } }, approve: { click() { this.dispatchEvent(new Event('approve-role')); } } })
    .register('renobot-early-access');
}

/** @typedef {HTMLElement & { patch: (state: Record<string, string | boolean>) => void, busy: boolean }} RecordElement */

/** @param {string} id */
function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error('Page is incomplete');
  return node;
}

/** @param {string} csrf */
async function loadSupporterAccount(csrf) {
  const status = element('account-status');
  const check = /** @type {HTMLButtonElement} */ (element('account-check-payments'));
  const more = /** @type {HTMLButtonElement} */ (element('account-payments-more'));
  /** @type {string | null} */
  let cursor = null;
  /** @type {Record<string, string>[]} */
  let payments = [];
  let version = 0;
  /** @param {boolean} reset */
  async function load(reset) {
    if (reset) version++;
    const current = version;
    const response = await fetch(`/app/api/account${reset || !cursor ? '' : `?before=${encodeURIComponent(cursor)}`}`,
      { credentials: 'same-origin', cache: 'no-store' });
    if (current !== version) return;
    if (!response.ok) throw new Error('Account unavailable');
    /** @type {{ emails: {email: string, verifiedBy: string}[], earlyAccess: { enabled: boolean, expiresAt: string | null, creditedMonths: number, roleManaged: boolean }, entries: {recipient: string, amount: string, currency: string, receivedAt: string, eventType: string, transactionId: string, outcome: string}[], nextCursor: string | null }} */
    const result = await response.json();
    if (current !== version) return;
    (/** @type {HTMLElement & {patch: (state: object) => void}} */ (element('account-emails'))).patch({
      emails: result.emails.map((email) => ({ ...email, label: email.verifiedBy === 'discord' ? 'Verified with Discord' : 'Verified email' })),
    });
    check.disabled = result.emails.length === 0;
    const access = result.earlyAccess;
    element('account-early-access').textContent = !access.enabled ? 'Early Access is not available right now.'
      : access.expiresAt && new Date(access.expiresAt) > new Date()
        ? `Eligible until ${new Date(access.expiresAt).toLocaleDateString()}.${access.roleManaged ? ' Grant recorded.' : ' No grant recorded.'} Discord role presence is not checked live.`
        : access.creditedMonths ? 'Your Early Access has expired.' : 'No Early Access recorded yet.';
    const items = result.entries.map((entry) => ({ amount: `${entry.amount} ${entry.currency}`, recipient: entry.recipient,
      received: new Date(entry.receivedAt).toLocaleString(), paymentType: entry.eventType, transaction: entry.transactionId,
      outcome: entry.outcome === 'renewed' ? 'Supporter membership credited' : 'Payment recorded', source: '', peer: '' }));
    payments = reset ? items : [...payments, ...items];
    (/** @type {HTMLElement & {patch: (state: object) => void}} */ (element('account-payments'))).patch({ items: payments });
    cursor = result.nextCursor;
    more.hidden = !cursor;
    element('account-payments-status').textContent = payments.length ? '' : 'No payments linked yet.';
    status.textContent = result.emails.length ? '' : 'Verify an email address to find payments without a Discord account attached.';
  }
  more.addEventListener('click', () => {
    if (!cursor || more.disabled) return;
    more.disabled = true;
    void load(false).catch(() => { status.textContent = 'Could not load older payments.'; }).finally(() => { more.disabled = false; });
  });
  check.addEventListener('click', () => {
    if (check.disabled) return;
    check.disabled = true;
    void (async () => {
      try {
        let linked = 0;
        let remaining;
        do {
          const response = await fetch('/app/api/account/link-payments', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
          if (!response.ok) throw new Error('Matching unavailable');
          const result = /** @type {{ linked: number, more: boolean }} */ (await response.json());
          linked += result.linked;
          remaining = result.more;
        } while (remaining);
        await load(true);
        status.textContent = linked ? `${linked} payment${linked === 1 ? '' : 's'} linked to your account.` : 'No additional payments found.';
      } catch { status.textContent = 'Could not check your payments. Try again.'; }
      finally { check.disabled = false; }
    })();
  });
  try { await load(true); } catch { status.textContent = 'Your account is temporarily unavailable. Try refreshing.'; }
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
    if (page === 'modder-kofi') {
      const button = /** @type {HTMLButtonElement} */ (document.getElementById('kofi-csv-import'));
      button?.addEventListener?.('click', () => {
        if (button.disabled) return;
        const file = /** @type {HTMLInputElement} */ (element('kofi-csv-file')).files?.[0];
        const status = element('kofi-csv-status');
        if (!file || file.size > 2 * 1024 * 1024) {
          status.textContent = 'Select a Ko-fi CSV no larger than 2 MB.'; return;
        }
        button.disabled = true;
        void (async () => {
          try {
            const response = await fetch('/app/api/modder/kofi/import', { method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'text/csv', 'X-CSRF-Token': session.csrf }, body: await file.text() });
            const result = await response.json();
            status.textContent = response.ok
              ? `${result.emailsUpdated} emails repaired; ${result.unchanged} unchanged; ${result.unmatched} unmatched transactions skipped.`
              : result.error;
            if (response.ok) document.dispatchEvent(new Event('kofi-emails-repaired'));
          } catch { status.textContent = 'Import unavailable. Try again.'; }
          finally { button.disabled = false; }
        })();
      });
    }
    if (page !== 'app' && document.getElementById('portal-navigation')) {
      try {
        const accessResponse = await fetch('/app/api/capabilities', { credentials: 'same-origin', cache: 'no-store' });
        if (accessResponse.ok) {
          const { capabilities } = await accessResponse.json();
          element('kofi-link').hidden = !capabilities.includes('modder');
          element('admin-kofi-link').hidden = !capabilities.includes('admin');
          element('admin-early-access-link').hidden = !capabilities.includes('admin');
          element('portal-navigation').hidden = false;
        }
      } catch {
        // Keep privileged navigation hidden when access cannot be established.
      }
    }
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
      if (document.getElementById('account-emails')) await loadSupporterAccount(session.csrf);
    } else if (page === 'admin-early-access') {
      const status = element('early-access-status');
      const approvalStatus = element('early-access-approval-status');
      const content = element('early-access-content');
      const importButton = /** @type {HTMLButtonElement} */ (element('early-access-import'));
      const importStatus = element('early-access-import-status');
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
            const row = /** @type {RecordElement} */ (document.createElement('renobot-early-access'));
            row.setAttribute('role', 'listitem');
            row.className = 'record early-access-record';
            const canApprove = result.enabled && member.active && !member.roleManaged && member.syncStatus === 'idle';
            row.patch({ person: member.discordName ?? 'Name unavailable', userId: member.discordUserId,
              donated: `${member.totalAmount} ${member.currency}`, months: String(member.creditedMonths),
              expiry: member.expiresAt ? `${member.active ? 'Active' : 'Expired'} · ${new Date(member.expiresAt).toLocaleString()}` : 'Not yet earned',
              sync: `${member.roleManaged ? 'Grant recorded' : 'Not managed'} · ${member.syncStatus}${member.nextAttemptAt ? ` · Next check ${new Date(member.nextAttemptAt).toLocaleString()}` : ''}`,
              canApprove, busy: false });
            row.addEventListener('review-payments', () => { void loadDetail(member.discordUserId, true); });
            row.addEventListener('approve-role', () => {
                if (!canApprove || row.busy) return;
                row.busy = true;
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
                    row.busy = false;
                  }
                })();
            });
            return row;
          });
          if (reset) element('early-access-list').replaceChildren(...items);
          else element('early-access-list').append(...items);
          cursor = result.nextCursor;
          more.hidden = !cursor;
          content.hidden = false;
          importButton.hidden = !result.enabled;
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
      importButton.addEventListener('click', () => {
        if (importButton.disabled) return;
        importButton.disabled = true;
        void (async () => {
          let scanned = 0;
          /** @type {string | null} */
          let after = null;
          try {
            do {
              const body = new URLSearchParams({ csrf: session.csrf });
              if (after) body.set('after', after);
              const response = await fetch('/app/api/admin/early-access/import', {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
              });
              if (!response.ok) throw new Error('Import unavailable');
              /** @type {{ scanned: number, nextCursor: string | null }} */
              const result = await response.json();
              scanned += result.scanned;
              after = result.nextCursor;
              importStatus.textContent = `Scanned ${scanned} historical receipts; importing…`;
            } while (after);
            importStatus.textContent = `Historical import scanned ${scanned} receipts. Review each person before approving a role.`;
            await loadPeople(true);
          } catch { importStatus.textContent = 'Import interrupted. Run it again to safely resume; existing credits are not duplicated.'; }
          finally { importButton.disabled = false; }
        })();
      });
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
      /** @type {Record<string, string>[]} */
      let payments = [];
      /** @param {Response} response @param {boolean} reset */
      async function renderEntries(response, reset) {
        /** @type {{ entries: { id: string, ownerDiscordUserId: string, ownerUsername: string,
         *   receivedAt: string, eventType: string, amount: string, currency: string,
         *   transactionId: string, outcome: string, sourceIp: string | null, sourcePort: number | null,
         *   sourceViaProxy: boolean, peerIp: string | null, peerPort: number | null }[], nextCursor: string | null }} */
        const result = await response.json();
        const items = result.entries.map((entry) => {
          return { amount: `${entry.amount} ${entry.currency}`, recipient: entry.ownerUsername,
            received: new Date(entry.receivedAt).toLocaleString(), paymentType: entry.eventType,
            transaction: entry.transactionId, outcome: entry.outcome,
            source: entry.sourceIp ? `${entry.sourceViaProxy ? 'Forwarded source' : 'Source'}: ${entry.sourceIp}${entry.sourcePort ? `:${entry.sourcePort}` : ''}` : '',
            peer: entry.sourceViaProxy && entry.peerIp ? `Connection: ${entry.peerIp}${entry.peerPort ? `:${entry.peerPort}` : ''}` : '' };
        });
        payments = reset ? items : [...payments, ...items];
        (/** @type {HTMLElement & { patch: (state: {items: Record<string, string>[]}) => void }} */ (element('admin-entries-list'))).patch({ items: payments });
        if (reset) shown = 0;
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
            const item = /** @type {RecordElement} */ (document.createElement('renobot-membership'));
            item.setAttribute('role', 'listitem');
            item.className = 'record supporter-record';
            const role = { 'granted-by-renobot': 'Role grant recorded by Renobot',
              pending: 'Role sync pending', retrying: 'Role sync retrying',
              'not-managed': 'No Renobot-managed role', disabled: 'Role sync disabled' }[member.roleStatus]
              ?? 'Role status unavailable';
            item.patch({ person: member.discordName ?? 'Name unavailable', userId: member.discordUserId,
              membership: member.active ? 'Active' : 'Expired', expiry: new Date(member.expiresAt).toLocaleString(),
              paidAt: new Date(member.lastPaymentAt).toLocaleString(), sync: role,
              nextCheck: member.nextAttemptAt ? `Next check ${new Date(member.nextAttemptAt).toLocaleString()}` : '',
              busy: false, roleLabel: 'Check Discord role' });
            item.addEventListener('check-role', () => {
              if (item.busy) return;
              item.busy = true;
              void (async () => {
                try {
                  const response = await fetch(`/app/api/modder/kofi/memberships/${encodeURIComponent(member.discordUserId)}`,
                    { credentials: 'same-origin', cache: 'no-store' });
                  if (!response.ok) throw new Error('Role lookup unavailable');
                  const { rolePresent } = await response.json();
                  item.patch({ roleLabel: rolePresent === null ? 'Role sync disabled'
                    : rolePresent ? 'Discord role present' : 'Discord role absent' });
                } catch { item.patch({ roleLabel: 'Role lookup unavailable; retry' }); }
                finally { item.busy = false; }
              })();
            });
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
         *   occurredAt: string, receivedAt: string, outcome: string }[], nextCursor: string | null, missingEmailCount: number }} */
          const { entries, nextCursor, missingEmailCount } = await response.json();
          if (version !== entriesVersion) return;
          element('kofi-csv-repair').hidden = !(missingEmailCount > 0);
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
        /** @type {HTMLInputElement} */ (element('currency')).value = settings.currency;
        element('token-status').textContent = settings.hasVerificationToken ? 'Token saved' : 'Add your Ko-fi verification token';
        element('forward-status').textContent = settings.hasForwardUrl ? 'Destination saved' : 'No destination saved';
        element('kofi-prod').hidden = !settings.prodUrl;
        element('kofi-prod-url').textContent = settings.prodUrl;
        element('kofi-role-status').textContent = settings.active
          ? 'Qualifying subscriptions renew access for 35 days.'
          : 'Automatic roles are off. Payments are still recorded.';
        element('kofi-webhook-status').textContent = settings.lastWebhookAt
          ? `Last payment received: ${new Date(settings.lastWebhookAt).toLocaleString()}`
          : settings.hasVerificationToken ? 'Waiting for your first payment or test.'
            : 'Save a verification token to get your webhook URL.';
        element('kofi-entries').hidden = !settings.prodUrl;
        if (settings.prodUrl) void loadEntries();
        form.hidden = false;
        if (settings.prodUrl && !events) {
          events = new EventSource('/app/api/modder/kofi/events');
          events.addEventListener('receipt', () => {
            element('kofi-webhook-status').textContent = 'New payment received. Payment history updated.';
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
      document.addEventListener?.('kofi-emails-repaired', () => { void loadEntries(); });
      status.textContent = '';
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          const button = /** @type {HTMLButtonElement} */ (element('save-settings'));
          button.disabled = true;
          try {
            const fields = new URLSearchParams({ csrf: session.csrf,
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
            status.textContent = 'Settings saved.';
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

const portalMenu = document.getElementById('portal-menu');
const portalDrawer = document.getElementById('portal-drawer');
if (portalMenu && portalDrawer && typeof portalMenu.addEventListener === 'function') {
  portalMenu.addEventListener('click', () => { portalDrawer.toggleAttribute('open'); });
}

void loadSession();
