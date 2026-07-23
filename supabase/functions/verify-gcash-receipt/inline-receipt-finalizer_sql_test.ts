import { PGlite } from "npm:@electric-sql/pglite@0.3.14";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function installFinalizerHarness(db: PGlite) {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create function auth.role()
    returns text language sql stable
    as $$ select 'service_role'::text $$;

    create table public.receipt_verifications (
      id bigint primary key,
      result text not null,
      booking_ref text not null,
      flags text[],
      extracted jsonb,
      confidence numeric,
      image_hash text,
      phash text,
      created_at timestamptz not null default now()
    );
    create table public.open_play_registrations (
      id bigint primary key,
      payment_status text not null,
      capacity_exception boolean not null default false,
      receipt_verification_id bigint,
      receipt_image_url text,
      receipt_image_hash text,
      full_name text,
      court_id text,
      court_name text,
      date date,
      hour integer,
      time_label text,
      payment_type text,
      payment_method text,
      gcash_ref text,
      amount numeric,
      receipt_status text,
      receipt_phash text,
      receipt_flags text[],
      receipt_extracted jsonb,
      receipt_confidence numeric,
      receipt_verified_at timestamptz
    );
    create table public.open_play_host_sessions (
      id uuid primary key,
      date date not null
    );
    create table public.open_play_host_session_registrations (
      id uuid primary key,
      session_id uuid references public.open_play_host_sessions(id),
      payment_status text not null,
      capacity_exception boolean not null default false,
      receipt_verification_id bigint,
      receipt_image_url text,
      receipt_image_hash text,
      full_name text,
      contact_number text,
      payment_method text,
      gcash_ref text,
      amount numeric,
      receipt_status text,
      receipt_phash text,
      receipt_flags text[],
      receipt_extracted jsonb,
      receipt_confidence numeric,
      receipt_verified_at timestamptz
    );
    create table public.used_gcash_refs (
      gcash_ref text primary key,
      booking_ref text not null,
      provider text
    );

    create function public.open_play_receipt_audit_matches(
      jsonb, text, text, text, date, integer, text, text, text, text, numeric
    )
    returns boolean language sql immutable as $$ select true $$;
    create function public.host_session_receipt_audit_matches(
      jsonb, uuid, date, text, text, text, text, numeric
    )
    returns boolean language sql immutable as $$ select true $$;
    create function public.payment_review_ledger_keys(
      p_extracted jsonb,
      p_fallback_provider text default null,
      p_fallback_reference text default null
    )
    returns table (ledger_key text, provider_key text)
    language sql immutable
    as $$
      select item->>'key', item->>'providerKey'
      from jsonb_array_elements(p_extracted->'dedupeKeys') item
    $$;
  `);

  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260723153000_payment_review_notifications.sql",
      import.meta.url,
    ),
  );
  const start = migration.indexOf(
    "create or replace function public.finalize_inline_receipt_registration(",
  );
  const end = migration.indexOf(
    "\nrevoke all on function public.finalize_inline_receipt_registration(",
    start,
  );
  assert(start >= 0 && end > start, "finalizer SQL was not found in migration");
  await db.exec(migration.slice(start, end));
}

Deno.test("inline finalizer rolls back partial replay claims on duplicate", async () => {
  const db = new PGlite();
  try {
    await installFinalizerHarness(db);
    const imageHash = "a".repeat(64);
    const extracted = {
      verificationContext: "open_play",
      registrationContext: {
        fullName: "Player One",
        courtId: "c1",
        courtName: "Court One",
        date: "2026-07-24",
        hour: 18,
        timeLabel: "6:00 PM",
        paymentType: "100%",
      },
      provider: "gcash",
      submittedReference: "1234567890123",
      expectedAmount: 100,
      expectedTotal: 100,
      dedupeKeys: [
        { key: "A-FIRST-KEY", providerKey: "gcash" },
        { key: "Z-CONFLICT-KEY", providerKey: "gcash" },
      ],
    };
    await db.query(
      `insert into public.receipt_verifications (
         id, result, booking_ref, flags, extracted, confidence, image_hash
       ) values (1, 'auto_approved', 'OP-ABCDEF', '{}', $1, 0.99, $2)`,
      [JSON.stringify(extracted), imageHash],
    );
    await db.query(
      `insert into public.open_play_registrations (
         id, payment_status, receipt_verification_id, receipt_image_url,
         receipt_image_hash, full_name, court_id, court_name, date, hour,
         time_label, payment_type, payment_method, gcash_ref, amount,
         receipt_status
       ) values (
         1, 'pending', 1, $1, $2, 'Player One', 'c1', 'Court One',
         '2026-07-24', 18, '6:00 PM', '100%', 'gcash',
         '1234567890123', 100, 'manual_review'
       )`,
      [`OP-ABCDEF/${imageHash}.jpg`, imageHash],
    );
    await db.exec(`
      insert into public.used_gcash_refs (
        gcash_ref, booking_ref, provider
      ) values ('Z-CONFLICT-KEY', 'OPR-999', 'gcash');
    `);

    let duplicateRejected = false;
    try {
      await db.query(
        `select public.finalize_inline_receipt_registration(
          'open_play', '1', 1
        )`,
      );
    } catch (error) {
      duplicateRejected = /Duplicate payment reference/i.test(String(error));
    }
    assert(duplicateRejected, "duplicate replay key must reject finalization");

    const rollback = await db.query<{
      first_key_count: number;
      payment_status: string;
    }>(`
      select
        (
          select count(*)::integer
          from public.used_gcash_refs
          where gcash_ref = 'A-FIRST-KEY'
        ) as first_key_count,
        (
          select payment_status
          from public.open_play_registrations
          where id = 1
        ) as payment_status
    `);
    assert(
      rollback.rows[0].first_key_count === 0,
      "the earlier replay-key claim must roll back",
    );
    assert(
      rollback.rows[0].payment_status === "pending",
      "registration must remain pending after duplicate rollback",
    );

    await db.exec(`
      delete from public.used_gcash_refs
      where gcash_ref = 'Z-CONFLICT-KEY';
      select public.finalize_inline_receipt_registration(
        'open_play', '1', 1
      );
    `);
    const finalized = await db.query<{
      payment_status: string;
      claim_count: number;
    }>(`
      select
        registration.payment_status,
        (
          select count(*)::integer
          from public.used_gcash_refs used_ref
          where used_ref.booking_ref = 'OPR-1'
        ) as claim_count
      from public.open_play_registrations registration
      where registration.id = 1
    `);
    assert(
      finalized.rows[0].payment_status === "paid",
      "successful finalization must mark registration paid",
    );
    assert(
      finalized.rows[0].claim_count === 2,
      "successful finalization must claim every replay key",
    );
  } finally {
    await db.close();
  }
});
