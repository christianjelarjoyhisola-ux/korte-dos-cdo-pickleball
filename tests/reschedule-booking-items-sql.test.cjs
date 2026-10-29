'use strict';

// Runs the per-court reschedule function on a real Postgres engine (PGlite).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261029220000_reschedule_booking_items.sql'), 'utf8');

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
    create table public.role_stub (r text); insert into role_stub values ('staff');
    create function public.current_account_role() returns text language sql as $$ select r from public.role_stub $$;
    create table public.courts (id text primary key, name text not null, blocked boolean not null default false);
    insert into courts values ('c1','Court 1',false),('c2','Court 2',false),('c3','Court 3',false),('c9','Court 9',true);
    create table public.bookings (ref text primary key, booking_group_ref text, court_id text not null, court_name text,
      date date not null, slots text[] not null default '{}', start_time text, end_time text, duration numeric,
      status text, total numeric, payment_status text);
    create role authenticated; create role anon;
  `);
  await db.exec(sql);
  await db.exec(`insert into bookings values
    ('H-01','H-G','c1','Court 1','2026-11-02','{17,18}','5:00 PM','7:00 PM',2,'confirmed',500,'downpayment_paid'),
    ('H-02','H-G','c2','Court 2','2026-11-02','{19,20}','7:00 PM','9:00 PM',2,'confirmed',500,'downpayment_paid'),
    ('H-03','H-G','c3','Court 3','2026-11-02','{17,18,19,20}','5:00 PM','9:00 PM',4,'confirmed',1000,'downpayment_paid'),
    ('S-01',null,'c1','Court 1','2026-11-02','{8,9}','8:00 AM','10:00 AM',2,'pending',400,'unpaid'),
    ('X-01',null,'c2','Court 2','2026-11-05','{17}','5:00 PM','6:00 PM',1,'confirmed',250,'paid');`);
  const call = moves => db.query('select public.reschedule_booking_items($1::jsonb) r', [JSON.stringify(moves)]).then(x => x.rows[0].r);
  const rows = () => db.query('select ref,court_id,court_name,date::text d,slots,start_time,end_time,total::int total,payment_status from bookings order by ref')
    .then(x => Object.fromEntries(x.rows.map(r => [r.ref, r])));
  const fails = async (moves, re) => {
    const before = JSON.stringify(await rows());
    await assert.rejects(call(moves), re);
    assert.equal(JSON.stringify(await rows()), before, 'nothing changed');
  };
  return { db, call, rows, fails };
}

test('host reservation: 3 courts with different times all move to a new date, keeping times and money', async () => {
  const { call, rows } = await setup();
  const r = await call([
    { ref: 'H-01', date: '2026-11-06', start_hour: 17 },
    { ref: 'H-02', date: '2026-11-06', start_hour: 19 },
    { ref: 'H-03', date: '2026-11-06', start_hour: 17 },
  ]);
  const b = await rows();
  assert.equal(r.bookingCount, 3);
  assert.equal(b['H-01'].d, '2026-11-06');
  assert.deepEqual(b['H-03'].slots, ['17', '18', '19', '20']);
  assert.equal(b['H-03'].end_time, '9:00 PM');
  assert.equal(b['H-03'].total, 1000);
  assert.equal(b['H-01'].payment_status, 'downpayment_paid');
});

test('one court of a reservation changes court and time while the others stay', async () => {
  const { call, rows } = await setup();
  const r = await call([{ ref: 'H-02', date: '2026-11-02', start_hour: 21, court_id: 'c1' }]);
  const b = await rows();
  assert.equal(b['H-02'].court_name, 'Court 1');
  assert.equal(b['H-02'].end_time, '11:00 PM');
  assert.equal(b['H-01'].d, '2026-11-02');
  assert.equal(r.changes[0].oldCourtName, 'Court 2');
  assert.equal(r.changes[0].newCourtName, 'Court 1');
});

test('single-court booking changes court, date and time; midnight end works', async () => {
  const { call, rows } = await setup();
  await call([{ ref: 'S-01', date: '2026-11-04', start_hour: 22, court_id: 'c3' }]);
  const b = await rows();
  assert.equal(b['S-01'].court_name, 'Court 3');
  assert.deepEqual(b['S-01'].slots, ['22', '23']);
  assert.equal(b['S-01'].end_time, '12:00 AM');
});

test('clashes are refused and nothing is half-moved', async () => {
  const { fails } = await setup();
  await fails([{ ref: 'H-02', date: '2026-11-05', start_hour: 16 }], /already booked/);
  await fails([
    { ref: 'H-01', date: '2026-11-06', start_hour: 17 },
    { ref: 'H-02', date: '2026-11-05', start_hour: 17 },
  ], /already booked/);
  await fails([{ ref: 'H-01', date: '2026-11-02', start_hour: 18, court_id: 'c3' }], /overlap/);
});

test('a court may take a slot freed by another court of the same reservation', async () => {
  const { call, rows } = await setup();
  await call([
    { ref: 'H-03', date: '2026-11-07', start_hour: 6 },
    { ref: 'H-01', date: '2026-11-02', start_hour: 17, court_id: 'c3' },
  ]);
  assert.equal((await rows())['H-01'].court_id, 'c3');
});

test('invalid requests are refused', async () => {
  const { db, fails } = await setup();
  await fails([{ ref: 'S-01', date: '2026-11-04', start_hour: 10, court_id: 'c9' }], /unavailable/);
  await fails([{ ref: 'H-03', date: '2026-11-04', start_hour: 21 }], /venue hours/);
  await fails([{ ref: 'H-01', date: '2026-11-04', start_hour: 10 }, { ref: 'S-01', date: '2026-11-04', start_hour: 12 }], /one reservation/);
  await fails([{ ref: 'H-01', date: '2026-11-04', start_hour: 10 }, { ref: 'H-01', date: '2026-11-05', start_hour: 10 }], /invalid/);
  await fails([{ ref: 'NOPE', date: '2026-11-04', start_hour: 10 }], /could not be found/);
  await fails([], /at least one/);
  await db.exec(`update bookings set status='cancelled' where ref='H-02'`);
  await fails([{ ref: 'H-02', date: '2026-11-04', start_hour: 10 }], /pending or confirmed/);
  await db.exec(`update role_stub set r='host'`);
  await fails([{ ref: 'S-01', date: '2026-11-04', start_hour: 10 }], /permission/);
});

test('only schedule columns are written', () => {
  const update = sql.match(/update public\.bookings booking[\s\S]*?where booking\.ref = plan\.ref;/i)?.[0] || '';
  assert.ok(update);
  assert.doesNotMatch(update, /payment_status|receipt|total|downpayment|voucher|billed_at|status\s*=/i);
});
