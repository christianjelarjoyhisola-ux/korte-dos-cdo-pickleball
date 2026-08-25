import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals } from "jsr:@std/assert@1";

const migrationUrl = new URL(
  "../../migrations/20260825143000_reconcile_staged_court_receipts.sql",
  import.meta.url,
);

Deno.test("stale court holds recover stored receipts before empty holds expire", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema storage;

      create table public.bookings (
        ref text primary key,
        booking_group_ref text,
        payment_method text,
        gcash_ref text,
        status text not null,
        payment_status text not null,
        created_at timestamptz not null,
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
    `);
    await db.exec(await Deno.readTextFile(migrationUrl));

    const storedRef = "PB-STORED-ONE1";
    const emptyRef = "PB-EMPTY-TWO2";
    const imageHash = "a".repeat(64);
    await db.query(
      `insert into public.bookings
        (ref,payment_method,gcash_ref,status,payment_status,created_at)
       values
        ($1,'gcash','2044277954328','verifying','for_verification',now() - interval '20 minutes'),
        ($2,'gcash','9999999999999','verifying','for_verification',now() - interval '20 minutes')`,
      [storedRef, emptyRef],
    );
    await db.query(
      `insert into storage.objects (bucket_id,name)
       values ('receipts',$1)`,
      [`${storedRef}/${imageHash}.jpg`],
    );

    await db.query("select public.expire_stale_verifying_bookings()");
    const bookings = await db.query<{
      ref: string;
      status: string;
      payment_status: string;
      receipt_image_url: string | null;
    }>(
      `select ref,status,payment_status,receipt_image_url
       from public.bookings order by ref`,
    );
    const byRef = new Map(bookings.rows.map((row) => [row.ref, row]));
    assertEquals(byRef.get(storedRef), {
      ref: storedRef,
      status: "pending",
      payment_status: "for_verification",
      receipt_image_url: `${storedRef}/${imageHash}.jpg`,
    });
    assertEquals(byRef.get(emptyRef), {
      ref: emptyRef,
      status: "cancelled",
      payment_status: "rejected",
      receipt_image_url: null,
    });

    const audits = await db.query<{
      booking_ref: string;
      result: string;
      image_hash: string;
    }>(
      "select booking_ref,result,image_hash from public.receipt_verifications",
    );
    assertEquals(audits.rows, [{
      booking_ref: storedRef,
      result: "manual_review",
      image_hash: imageHash,
    }]);
  } finally {
    await db.close();
  }
});
