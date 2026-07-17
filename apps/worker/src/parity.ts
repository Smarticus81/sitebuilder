// `pnpm parity` — driver parity suite. Runs an identical repository-level
// scenario against SQLite (always, in a scratch file) and against Postgres
// when POSTGRES_URL is set, then compares the observable results field by
// field. Zero keys → SQLite-only run (still validates the driver abstraction);
// with POSTGRES_URL it proves the two backends behave identically.

import './env.js';
import { rmSync } from 'node:fs';
import {
  openDb,
  migrate,
  resetDb,
  upsertLead,
  getLead,
  listLeads,
  setLeadStatus,
  insertDemo,
  getDemoByLead,
  updateDemo,
  insertMessage,
  updateMessageStatus,
  countSentToday,
  insertSequence,
  updateSequenceStatus,
  listSequenceMessages,
  insertSms,
  updateSmsStatus,
  isPhoneSuppressed,
  addPhoneSuppression,
  addSuppression,
  isSuppressed,
  insertProposal,
  getProposalByLead,
  insertDomainRequest,
  decideDomainRequest,
  upsertConfig,
  getConfigRow,
  logEvent,
  listEvents,
  toPgPlaceholders,
  type Driver,
} from '@storefront/db';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  const mark = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${mark} ${label}${detail ? `  — ${detail}` : ''}`);
}

interface Snapshot {
  lead: { name: string; status: string; segment: string | null; score: number };
  demoPublished: number;
  messageStatuses: string[];
  sentToday: number;
  suppressed: boolean;
  phoneSuppressed: boolean;
  sequenceStatus: string;
  sequenceSteps: number;
  proposalPrice: number | undefined;
  domainStatus: string;
  configCap: number;
  eventTypes: string[];
}

/** The scenario: one of everything, exercised through the public repo API. */
async function scenario(db: Driver): Promise<Snapshot> {
  await migrate(db);
  await resetDb(db);

  const { row: lead } = await upsertLead(db, {
    place_id: 'parity_1',
    name: 'Parity Test Salon',
    category: 'hair_salon',
    address: '1 Main St, Fort Worth, TX',
    phone: '(817) 555-0000',
    website_url: 'http://parity.example',
    rating: 4.5,
    review_count: 10,
  });
  await upsertLead(db, { place_id: 'parity_1', name: 'DUPLICATE — must not insert' });
  await setLeadStatus(db, lead.id, 'qualified', { segment: 'bad', score: 7.25, contact_email: 'owner@parity.example' });

  const demo = await insertDemo(db, {
    lead_id: lead.id,
    template: 'salon-barber',
    copy_json: '{}',
    assets_json: null,
    subdomain: 'parity-test-salon.demo.example.com',
    demo_url: 'https://parity-test-salon.demo.example.com',
    published: 1,
    unpublish_at: '2030-01-01 00:00:00',
  });
  await updateDemo(db, demo.id, { published: 0 });

  const msg = await insertMessage(db, {
    lead_id: lead.id,
    channel: 'email',
    subject: 'Parity subject',
    body: 'Parity body',
    status: 'draft',
  });
  await updateMessageStatus(db, msg.id, 'approved', { approved_by: 'parity' });
  await updateMessageStatus(db, msg.id, 'sent', { sent_at: new Date().toISOString() });

  const seq = await insertSequence(db, { lead_id: lead.id, max_followups: 2, spacing_days: 4 });
  await insertMessage(db, {
    lead_id: lead.id, channel: 'email', subject: 'f1', body: 'b1', status: 'draft',
    sequence_id: seq.id, followup_step: 1,
  });
  await insertMessage(db, {
    lead_id: lead.id, channel: 'email', subject: 'f2', body: 'b2', status: 'draft',
    sequence_id: seq.id, followup_step: 2,
  });
  await updateSequenceStatus(db, seq.id, 'approved', { approved_by: 'parity' });

  const sms = await insertSms(db, { lead_id: lead.id, to_phone: '(817) 555-0000', body: 'hi STOP' });
  await updateSmsStatus(db, sms.id, 'approved', { tcpa_basis: 'documented parity basis', approved_by: 'parity' });

  await addSuppression(db, 'gone@parity.example', 'parity test');
  await addSuppression(db, 'gone@parity.example', 'duplicate must not throw');
  await addPhoneSuppression(db, '(817) 555-9999', 'parity stop');

  await insertProposal(db, {
    lead_id: lead.id, slug: 'parity-test-salon', url: 'http://x/proposals/parity-test-salon/',
    payment_link_url: 'https://pay.example/1', payment_link_id: 'pl_1',
    price_cents: 150_000, monthly_cents: 5_000, currency: 'usd',
  });

  await insertDomainRequest(db, {
    lead_id: lead.id, domain: 'paritytest.com', token: 'parity-token', requested_by: 'parity',
  });
  await decideDomainRequest(db, 'parity-token', 'approved', 'parity-human');
  const redecided = await decideDomainRequest(db, 'parity-token', 'declined', 'someone-else');

  await upsertConfig(db, { daily_send_cap: 21, sender_name: 'Parity' });
  await upsertConfig(db, { mailing_address: '1 Main St' }); // merge path
  await logEvent(db, 'parity.custom', lead.id, { hello: 'world' });

  const fresh = (await getLead(db, lead.id))!;
  const msgs = await db.all<{ status: string }>(
    `SELECT status FROM messages WHERE lead_id = ? ORDER BY id ASC`,
    [lead.id],
  );
  return {
    lead: { name: fresh.name, status: fresh.status, segment: fresh.segment, score: fresh.score },
    demoPublished: (await getDemoByLead(db, lead.id))!.published,
    messageStatuses: msgs.map((m) => m.status),
    sentToday: await countSentToday(db),
    suppressed: await isSuppressed(db, 'GONE@parity.example '),
    phoneSuppressed: await isPhoneSuppressed(db, '817-555-9999'),
    sequenceStatus: (await db.get<{ status: string }>(`SELECT status FROM sequences WHERE id = ?`, [seq.id]))!.status,
    sequenceSteps: (await listSequenceMessages(db, seq.id)).length,
    proposalPrice: (await getProposalByLead(db, lead.id))?.price_cents,
    domainStatus: redecided.status,
    configCap: (await getConfigRow(db))!.daily_send_cap,
    eventTypes: (await listEvents(db, lead.id)).map((e) => e.type).sort(),
  };
}

async function main() {
  console.log('\nStorefront driver parity suite\n');

  // 0. Placeholder translation (pure).
  console.log('── SQL translation ──────────────────────────────────────────');
  check(
    '? placeholders translate to $1..$n',
    toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?') ===
      'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3',
  );

  // 1. SQLite run (always).
  console.log('\n── SQLite scenario ──────────────────────────────────────────');
  const scratch = 'sqlite:./data/parity-scratch.db';
  const sqlite = openDb(scratch);
  const a = await scenario(sqlite);
  check('scenario completed on sqlite', true);
  check('duplicate upsert did not double-insert', (await listLeads(sqlite)).length === 1);
  check('one email counted toward today\'s cap', a.sentToday === 1);
  check('suppression is case/space-insensitive', a.suppressed);
  check('phone suppression normalizes formatting', a.phoneSuppressed);
  check('first domain decision wins', a.domainStatus === 'approved');
  check('config merge kept the cap', a.configCap === 21);
  await sqlite.close();
  rmSync('./data/parity-scratch.db', { force: true });
  rmSync('./data/parity-scratch.db-wal', { force: true });
  rmSync('./data/parity-scratch.db-shm', { force: true });

  // 2. Postgres run (when POSTGRES_URL is set).
  const pgUrl = process.env.POSTGRES_URL;
  if (!pgUrl) {
    console.log('\n── Postgres scenario ────────────────────────────────────────');
    console.log('  ◦ skipped — set POSTGRES_URL to run the same scenario on Postgres');
  } else {
    console.log('\n── Postgres scenario ────────────────────────────────────────');
    const pg = openDb(pgUrl);
    const b = await scenario(pg);
    await pg.close();
    const aj = JSON.stringify(a, null, 2);
    const bj = JSON.stringify(b, null, 2);
    check('postgres snapshot matches sqlite snapshot exactly', aj === bj, aj === bj ? '' : `\nsqlite: ${aj}\npg: ${bj}`);
  }

  console.log(failures === 0 ? '\n✅ parity: all checks passed\n' : `\n❌ parity: ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
