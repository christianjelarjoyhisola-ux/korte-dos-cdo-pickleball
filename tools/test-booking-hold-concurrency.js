'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('pg');

const databaseUrl = process.env.BOOKING_HOLD_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('BOOKING_HOLD_TEST_DATABASE_URL is required.');
}

const migration = fs.readFileSync(
  'supabase/migrations/20260825234000_serialize_booking_holds.sql',
  'utf8',
);

const schemaSql = `
  do $roles$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
  end
  $roles$;

  drop schema if exists public cascade;
  drop schema if exists storage cascade;
  create schema public;
  create schema storage;

  create table public.bookings (
    ref text primary key,
    booking_group_ref text,
    court_id text not null,
    court_name text,
    date date not null,
    slots text[] not null,
    start_time text,
    end_time text,
    duration numeric,
    total numeric,
    downpayment numeric,
    booking_fee_amount_snapshot numeric,
    voucher_discount_amount numeric,
    full_name text,
    payment_method text,
    gcash_ref text,
    status text not null,
    payment_status text not null,
    created_at timestamptz not null default now(),
    receipt_image_url text,
    receipt_image_hash text,
    receipt_status text default 'none',
    receipt_flags text[] default '{}',
    receipt_confidence numeric
  );

  create table public.receipt_verifications (
    id bigserial primary key,
    booking_ref text not null,
    result text not null,
    flags text[] not null default '{}',
    extracted jsonb,
    confidence numeric,
    image_hash text,
    phash text,
    raw_ocr_text text,
    created_at timestamptz not null default now()
  );

  create table storage.objects (
    id bigserial primary key,
    bucket_id text not null,
    name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

function client() {
  return new Client({ connectionString: databaseUrl });
}

async function main() {
  const setup = client();
  const first = client();
  const second = client();
  await Promise.all([setup.connect(), first.connect(), second.connect()]);
  try {
    const database = await setup.query('select current_database() as name');
    assert.equal(
      database.rows[0]?.name,
      'korte_dos_receipt_race_test',
      'refusing to reset any database except the dedicated race-test database',
    );

    await setup.query(schemaSql);
    await setup.query(migration);
    await setup.query(`
      create trigger trg_prevent_double_booking
      before insert or update on public.bookings
      for each row execute function public.prevent_double_booking();
    `);

    await first.query('begin');
    await second.query('begin');
    await first.query(`
      insert into public.bookings
        (ref,court_id,date,slots,status,payment_status,payment_method,gcash_ref)
      values
        ('PB-RACE-FIRST','c2','2026-09-05','{18,19,20}',
         'verifying','for_verification','gcash','8044346667611')
    `);

    let secondSettled = false;
    const competingInsert = second.query(`
      insert into public.bookings
        (ref,court_id,date,slots,status,payment_status,payment_method,gcash_ref)
      values
        ('PB-RACE-SECOND','c2','2026-09-05','{18,19,20}',
         'verifying','for_verification','gcash','8044346667611')
    `).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    ).finally(() => { secondSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      secondSettled,
      false,
      'the competing insert should wait for the first slot transaction',
    );

    await first.query('commit');
    const outcome = await competingInsert;
    assert.equal(outcome.ok, false, 'the competing same-slot hold must fail');
    assert.match(
      String(outcome.error?.message || ''),
      /time slots are already booked/i,
    );
    await second.query('rollback');

    const activeRaceRows = await setup.query(`
      select ref from public.bookings
      where court_id = 'c2'
        and date = '2026-09-05'
        and slots && '{18,19,20}'::text[]
        and status not in ('cancelled','forfeited')
    `);
    assert.deepEqual(activeRaceRows.rows, [{ ref: 'PB-RACE-FIRST' }]);

    await setup.query('alter table public.bookings disable trigger trg_prevent_double_booking');
    await setup.query(`
      insert into public.bookings
        (ref,court_id,date,slots,status,payment_status,payment_method,gcash_ref,created_at)
      values
        ('PB-STORED-EVIDENCE','c3','2026-09-06','{18,19,20}',
         'verifying','for_verification','gcash','1111111111111',now() - interval '20 minutes'),
        ('PB-EMPTY-SIBLING','c3','2026-09-06','{18,19,20}',
         'verifying','for_verification','gcash','1111111111111',now() - interval '20 minutes')
    `);
    await setup.query('alter table public.bookings enable trigger trg_prevent_double_booking');

    const imageHash = 'a'.repeat(64);
    await setup.query(
      `insert into storage.objects (bucket_id,name) values ('receipts',$1)`,
      [`PB-STORED-EVIDENCE/${imageHash}.jpg`],
    );
    await setup.query('select public.expire_stale_verifying_bookings()');

    const reconciled = await setup.query(`
      select ref,status,payment_status,receipt_image_url
      from public.bookings
      where ref in ('PB-STORED-EVIDENCE','PB-EMPTY-SIBLING')
      order by ref
    `);
    assert.deepEqual(reconciled.rows, [
      {
        ref: 'PB-EMPTY-SIBLING',
        status: 'cancelled',
        payment_status: 'failed',
        receipt_image_url: null,
      },
      {
        ref: 'PB-STORED-EVIDENCE',
        status: 'pending',
        payment_status: 'for_verification',
        receipt_image_url: `PB-STORED-EVIDENCE/${imageHash}.jpg`,
      },
    ]);

    const audits = await setup.query(`
      select booking_ref,result,image_hash
      from public.receipt_verifications
      where booking_ref = 'PB-STORED-EVIDENCE'
    `);
    assert.deepEqual(audits.rows, [{
      booking_ref: 'PB-STORED-EVIDENCE',
      result: 'manual_review',
      image_hash: imageHash,
    }]);

    console.log('Booking hold concurrency and stored-receipt reconciliation passed.');
  } finally {
    await Promise.allSettled([
      first.query('rollback'),
      second.query('rollback'),
    ]);
    await Promise.allSettled([setup.end(), first.end(), second.end()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
