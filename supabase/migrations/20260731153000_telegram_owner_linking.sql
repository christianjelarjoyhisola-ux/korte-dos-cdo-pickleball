-- Secure, expiring Telegram account linking for owners and court owners.
-- Raw connection codes are intentionally never stored in the database.

create table if not exists public.telegram_owner_link_codes (
  id uuid primary key default gen_random_uuid(),
  code_digest text not null unique,
  target_user_id uuid not null
    references public.accounts(id) on delete cascade,
  created_by_user_id uuid
    references public.accounts(id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_telegram_chat_id bigint,
  revoked_at timestamptz,
  revoked_by_user_id uuid
    references public.accounts(id) on delete set null,
  constraint telegram_owner_link_codes_digest_check
    check (code_digest ~ '^[0-9a-f]{64}$'),
  constraint telegram_owner_link_codes_exact_expiry_check
    check (expires_at = created_at + interval '7 days'),
  constraint telegram_owner_link_codes_consumed_pair_check
    check (
      (consumed_at is null and consumed_telegram_chat_id is null)
      or
      (consumed_at is not null and consumed_telegram_chat_id is not null)
    ),
  constraint telegram_owner_link_codes_revocation_pair_check
    check (
      revoked_at is not null
      or revoked_by_user_id is null
    ),
  constraint telegram_owner_link_codes_terminal_state_check
    check (not (consumed_at is not null and revoked_at is not null))
);

comment on table public.telegram_owner_link_codes is
  'One-use, seven-day Telegram owner link challenges. Only SHA-256 code digests are stored.';
comment on column public.telegram_owner_link_codes.code_digest is
  'Lowercase hexadecimal SHA-256 digest of the normalized one-time code; never the raw code.';

create index if not exists telegram_owner_link_codes_target_created_idx
  on public.telegram_owner_link_codes(target_user_id, created_at desc);
create index if not exists telegram_owner_link_codes_pending_expiry_idx
  on public.telegram_owner_link_codes(expires_at)
  where consumed_at is null and revoked_at is null;

create table if not exists public.telegram_owner_connections (
  user_id uuid primary key
    references public.accounts(id) on delete cascade,
  telegram_chat_id bigint not null unique,
  telegram_user_id bigint not null unique,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  telegram_language_code text,
  telegram_profile jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  first_connected_at timestamptz not null,
  connected_at timestamptz not null,
  updated_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_user_id uuid
    references public.accounts(id) on delete set null,
  last_link_code_id uuid
    references public.telegram_owner_link_codes(id) on delete set null,
  constraint telegram_owner_connections_private_chat_check
    check (
      telegram_chat_id > 0
      and telegram_user_id > 0
      and telegram_chat_id = telegram_user_id
    ),
  constraint telegram_owner_connections_profile_check
    check (jsonb_typeof(telegram_profile) = 'object'),
  constraint telegram_owner_connections_active_revocation_check
    check (
      (is_active and revoked_at is null and revoked_by_user_id is null)
      or
      (not is_active and revoked_at is not null)
    )
);

comment on table public.telegram_owner_connections is
  'Telegram private-chat destinations explicitly linked to dashboard owner accounts.';

create table if not exists public.telegram_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  telegram_chat_id bigint not null,
  payload_digest text,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  next_attempt_at timestamptz,
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint telegram_notification_deliveries_event_key_check
    check (
      char_length(btrim(event_key)) between 1 and 200
      and event_key = btrim(event_key)
    ),
  constraint telegram_notification_deliveries_chat_id_check
    check (telegram_chat_id <> 0),
  constraint telegram_notification_deliveries_payload_digest_check
    check (
      payload_digest is null
      or payload_digest ~ '^[0-9a-f]{64}$'
    ),
  constraint telegram_notification_deliveries_status_check
    check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint telegram_notification_deliveries_attempt_check
    check (attempt_count >= 0),
  constraint telegram_notification_deliveries_claim_check
    check (
      (status = 'sending' and claim_token is not null and claimed_at is not null)
      or
      (status <> 'sending' and claim_token is null)
    ),
  constraint telegram_notification_deliveries_sent_check
    check (
      (status = 'sent' and sent_at is not null)
      or
      (status <> 'sent' and sent_at is null)
    ),
  constraint telegram_notification_deliveries_event_recipient_key
    unique (event_key, telegram_chat_id)
);

comment on table public.telegram_notification_deliveries is
  'Per-recipient Telegram notification idempotency and retry state.';

create index if not exists telegram_notification_deliveries_due_idx
  on public.telegram_notification_deliveries(
    coalesce(next_attempt_at, claimed_at, created_at)
  )
  where status in ('pending', 'sending', 'failed');

alter table public.telegram_owner_link_codes enable row level security;
alter table public.telegram_owner_connections enable row level security;
alter table public.telegram_notification_deliveries enable row level security;

revoke all on table public.telegram_owner_link_codes
  from public, anon, authenticated;
revoke all on table public.telegram_owner_connections
  from public, anon, authenticated;
revoke all on table public.telegram_notification_deliveries
  from public, anon, authenticated;
grant all on table public.telegram_owner_link_codes to service_role;
grant all on table public.telegram_owner_connections to service_role;
grant all on table public.telegram_notification_deliveries to service_role;

create or replace function public.create_telegram_owner_link_code(
  p_code_digest text,
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_target_user_id uuid := coalesce(p_target_user_id, auth.uid());
  v_digest text := lower(btrim(coalesce(p_code_digest, '')));
  v_now timestamptz;
  v_code_id uuid;
begin
  select account.*
    into v_actor
  from public.accounts account
  where account.id = auth.uid()
    and account.status = 'active'
    and account.role in ('owner', 'court_owner');

  if not found then
    raise exception 'An active owner account is required.'
      using errcode = '42501';
  end if;

  if v_target_user_id is null then
    raise exception 'A target account is required.'
      using errcode = '22023';
  end if;

  if v_actor.role <> 'owner' and v_target_user_id <> v_actor.id then
    raise exception 'Court owners may only create their own Telegram link.'
      using errcode = '42501';
  end if;

  select account.*
    into v_target
  from public.accounts account
  where account.id = v_target_user_id
    and account.status = 'active'
    and account.role in ('owner', 'court_owner');

  if not found then
    raise exception 'The target must be an active owner or court owner.'
      using errcode = '22023';
  end if;

  if v_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid code digest is required.'
      using errcode = '22023';
  end if;

  -- Serialize code creation per target so only the newest challenge remains usable.
  perform pg_advisory_xact_lock(
    hashtextextended(v_target_user_id::text, 741913)
  );
  v_now := clock_timestamp();

  update public.telegram_owner_link_codes code
  set revoked_at = v_now,
      revoked_by_user_id = v_actor.id
  where code.target_user_id = v_target_user_id
    and code.consumed_at is null
    and code.revoked_at is null;

  insert into public.telegram_owner_link_codes (
    code_digest,
    target_user_id,
    created_by_user_id,
    created_at,
    expires_at
  )
  values (
    v_digest,
    v_target_user_id,
    v_actor.id,
    v_now,
    v_now + interval '7 days'
  )
  returning id into v_code_id;

  return jsonb_build_object(
    'id', v_code_id,
    'targetUserId', v_target_user_id,
    'createdAt', v_now,
    'expiresAt', v_now + interval '7 days'
  );
end;
$$;

revoke all on function public.create_telegram_owner_link_code(text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_telegram_owner_link_code(text, uuid)
  to authenticated;

create or replace function public.revoke_telegram_owner_link_code(
  p_code_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_code public.telegram_owner_link_codes%rowtype;
  v_revoked boolean := false;
begin
  select account.*
    into v_actor
  from public.accounts account
  where account.id = auth.uid()
    and account.status = 'active'
    and account.role in ('owner', 'court_owner');

  if not found then
    raise exception 'An active owner account is required.'
      using errcode = '42501';
  end if;

  select code.*
    into v_code
  from public.telegram_owner_link_codes code
  where code.id = p_code_id
  for update;

  if not found then
    return jsonb_build_object('revoked', false);
  end if;

  if v_actor.role <> 'owner' and v_code.target_user_id <> v_actor.id then
    raise exception 'Court owners may only revoke their own Telegram code.'
      using errcode = '42501';
  end if;

  update public.telegram_owner_link_codes code
  set revoked_at = clock_timestamp(),
      revoked_by_user_id = v_actor.id
  where code.id = v_code.id
    and code.consumed_at is null
    and code.revoked_at is null;
  v_revoked := found;

  return jsonb_build_object('revoked', v_revoked);
end;
$$;

revoke all on function public.revoke_telegram_owner_link_code(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_telegram_owner_link_code(uuid)
  to authenticated;

create or replace function public.consume_telegram_owner_link_code(
  p_code_digest text,
  p_telegram_chat_id bigint,
  p_telegram_user_id bigint,
  p_chat_type text default 'private',
  p_telegram_username text default null,
  p_telegram_first_name text default null,
  p_telegram_last_name text default null,
  p_telegram_language_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_digest text := lower(btrim(coalesce(p_code_digest, '')));
  v_code public.telegram_owner_link_codes%rowtype;
  v_target public.accounts%rowtype;
  v_existing_user_id uuid;
  v_now timestamptz;
  v_username text := nullif(left(btrim(coalesce(p_telegram_username, '')), 64), '');
  v_first_name text := nullif(left(btrim(coalesce(p_telegram_first_name, '')), 128), '');
  v_last_name text := nullif(left(btrim(coalesce(p_telegram_last_name, '')), 128), '');
  v_language_code text := nullif(left(btrim(coalesce(p_telegram_language_code, '')), 16), '');
  v_profile jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the Telegram link service may consume a code.'
      using errcode = '42501';
  end if;

  if v_digest !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  if lower(btrim(coalesce(p_chat_type, ''))) <> 'private'
     or p_telegram_chat_id is null
     or p_telegram_user_id is null
     or p_telegram_chat_id <= 0
     or p_telegram_user_id <= 0
     or p_telegram_chat_id <> p_telegram_user_id then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Read the target first without taking a row lock, then acquire locks in the
  -- same target-before-code order used by code creation and account revocation.
  select code.*
    into v_code
  from public.telegram_owner_link_codes code
  where code.code_digest = v_digest;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_code.target_user_id::text, 741913)
  );

  select code.*
    into v_code
  from public.telegram_owner_link_codes code
  where code.code_digest = v_digest
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_now := clock_timestamp();

  -- A consumed code remains "already used" even after its original expiry.
  if v_code.consumed_at is not null then
    return jsonb_build_object('status', 'already_used');
  end if;

  if v_code.revoked_at is not null then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_now >= v_code.expires_at then
    return jsonb_build_object('status', 'expired');
  end if;

  select account.*
    into v_target
  from public.accounts account
  where account.id = v_code.target_user_id
    and account.status = 'active'
    and account.role in ('owner', 'court_owner');

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- The chat lock closes races between distinct valid codes attempting to
  -- claim the same Telegram private chat.
  perform pg_advisory_xact_lock(p_telegram_chat_id);

  select connection.user_id
    into v_existing_user_id
  from public.telegram_owner_connections connection
  where connection.telegram_chat_id = p_telegram_chat_id
     or connection.telegram_user_id = p_telegram_user_id
  limit 1
  for update;

  if found and v_existing_user_id <> v_code.target_user_id then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_profile := jsonb_strip_nulls(jsonb_build_object(
    'id', p_telegram_user_id,
    'username', v_username,
    'firstName', v_first_name,
    'lastName', v_last_name,
    'languageCode', v_language_code
  ));

  update public.telegram_owner_link_codes code
  set consumed_at = v_now,
      consumed_telegram_chat_id = p_telegram_chat_id
  where code.id = v_code.id
    and code.consumed_at is null
    and code.revoked_at is null;

  if not found then
    return jsonb_build_object('status', 'already_used');
  end if;

  insert into public.telegram_owner_connections (
    user_id,
    telegram_chat_id,
    telegram_user_id,
    telegram_username,
    telegram_first_name,
    telegram_last_name,
    telegram_language_code,
    telegram_profile,
    is_active,
    first_connected_at,
    connected_at,
    updated_at,
    revoked_at,
    revoked_by_user_id,
    last_link_code_id
  )
  values (
    v_code.target_user_id,
    p_telegram_chat_id,
    p_telegram_user_id,
    v_username,
    v_first_name,
    v_last_name,
    v_language_code,
    v_profile,
    true,
    v_now,
    v_now,
    v_now,
    null,
    null,
    v_code.id
  )
  on conflict (user_id) do update
  set telegram_chat_id = excluded.telegram_chat_id,
      telegram_user_id = excluded.telegram_user_id,
      telegram_username = excluded.telegram_username,
      telegram_first_name = excluded.telegram_first_name,
      telegram_last_name = excluded.telegram_last_name,
      telegram_language_code = excluded.telegram_language_code,
      telegram_profile = excluded.telegram_profile,
      is_active = true,
      connected_at = excluded.connected_at,
      updated_at = excluded.updated_at,
      revoked_at = null,
      revoked_by_user_id = null,
      last_link_code_id = excluded.last_link_code_id;

  -- A successful link invalidates every other outstanding challenge for the
  -- same account. This keeps reconnects deterministic and limits exposure.
  update public.telegram_owner_link_codes code
  set revoked_at = v_now,
      revoked_by_user_id = null
  where code.target_user_id = v_code.target_user_id
    and code.id <> v_code.id
    and code.consumed_at is null
    and code.revoked_at is null;

  return jsonb_build_object('status', 'success');
end;
$$;

revoke all on function public.consume_telegram_owner_link_code(
  text, bigint, bigint, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.consume_telegram_owner_link_code(
  text, bigint, bigint, text, text, text, text, text
) to service_role;

create or replace function public.list_telegram_owner_links(
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_result jsonb;
begin
  select account.*
    into v_actor
  from public.accounts account
  where account.id = auth.uid()
    and account.status = 'active'
    and account.role in ('owner', 'court_owner');

  if not found then
    raise exception 'An active owner account is required.'
      using errcode = '42501';
  end if;

  if v_actor.role <> 'owner'
     and p_target_user_id is not null
     and p_target_user_id <> v_actor.id then
    raise exception 'Court owners may only view their own Telegram link.'
      using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'userId', account.id,
        'fullName', account.full_name,
        'email', account.email,
        'role', account.role,
        'accountStatus', account.status,
        'eligible', (
          account.status = 'active'
          and account.role in ('owner', 'court_owner')
        ),
        'connected', coalesce(connection.is_active, false),
        'telegramChatId', connection.telegram_chat_id,
        'telegramUserId', connection.telegram_user_id,
        'telegramUsername', connection.telegram_username,
        'telegramFirstName', connection.telegram_first_name,
        'telegramLastName', connection.telegram_last_name,
        'telegramLanguageCode', connection.telegram_language_code,
        'firstConnectedAt', connection.first_connected_at,
        'connectedAt', connection.connected_at,
        'updatedAt', connection.updated_at,
        'revokedAt', connection.revoked_at,
        'pendingCodeCreatedAt', pending_code.created_at,
        'pendingCodeExpiresAt', pending_code.expires_at
      ))
      order by
        case when account.id = v_actor.id then 0 else 1 end,
        lower(coalesce(account.full_name, account.email, account.username)),
        account.id
    ),
    '[]'::jsonb
  )
    into v_result
  from public.accounts account
  left join public.telegram_owner_connections connection
    on connection.user_id = account.id
  left join lateral (
    select code.created_at, code.expires_at
    from public.telegram_owner_link_codes code
    where code.target_user_id = account.id
      and code.consumed_at is null
      and code.revoked_at is null
      and code.expires_at > clock_timestamp()
    order by code.created_at desc
    limit 1
  ) pending_code on true
  where (
    account.role in ('owner', 'court_owner')
    or connection.user_id is not null
  )
    and (
      v_actor.role = 'owner'
      or account.id = v_actor.id
    )
    and (
      p_target_user_id is null
      or account.id = p_target_user_id
    );

  return v_result;
end;
$$;

revoke all on function public.list_telegram_owner_links(uuid)
  from public, anon, authenticated;
grant execute on function public.list_telegram_owner_links(uuid)
  to authenticated;

create or replace function public.revoke_telegram_owner_link(
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target_user_id uuid := coalesce(p_target_user_id, auth.uid());
  v_now timestamptz;
  v_connection_revoked boolean := false;
  v_codes_revoked integer := 0;
begin
  select account.*
    into v_actor
  from public.accounts account
  where account.id = auth.uid()
    and account.status = 'active'
    and account.role in ('owner', 'court_owner');

  if not found then
    raise exception 'An active owner account is required.'
      using errcode = '42501';
  end if;

  if v_target_user_id is null then
    raise exception 'A target account is required.'
      using errcode = '22023';
  end if;

  if v_actor.role <> 'owner' and v_target_user_id <> v_actor.id then
    raise exception 'Court owners may only revoke their own Telegram link.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.accounts account
    where account.id = v_target_user_id
  ) then
    raise exception 'The target account was not found.'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_target_user_id::text, 741913)
  );
  v_now := clock_timestamp();

  update public.telegram_owner_connections connection
  set is_active = false,
      updated_at = v_now,
      revoked_at = v_now,
      revoked_by_user_id = v_actor.id
  where connection.user_id = v_target_user_id
    and connection.is_active;
  v_connection_revoked := found;

  update public.telegram_owner_link_codes code
  set revoked_at = v_now,
      revoked_by_user_id = v_actor.id
  where code.target_user_id = v_target_user_id
    and code.consumed_at is null
    and code.revoked_at is null;
  get diagnostics v_codes_revoked = row_count;

  return jsonb_build_object(
    'targetUserId', v_target_user_id,
    'connectionRevoked', v_connection_revoked,
    'codesRevoked', v_codes_revoked
  );
end;
$$;

revoke all on function public.revoke_telegram_owner_link(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_telegram_owner_link(uuid)
  to authenticated;

create or replace function public.list_active_telegram_owner_chat_ids()
returns table (telegram_chat_id bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the Telegram notification service may list recipients.'
      using errcode = '42501';
  end if;

  return query
  select connection.telegram_chat_id
  from public.telegram_owner_connections connection
  join public.accounts account
    on account.id = connection.user_id
  where connection.is_active
    and account.status = 'active'
    and account.role in ('owner', 'court_owner')
  order by connection.telegram_chat_id;
end;
$$;

revoke all on function public.list_active_telegram_owner_chat_ids()
  from public, anon, authenticated;
grant execute on function public.list_active_telegram_owner_chat_ids()
  to service_role;

create or replace function public.claim_telegram_notification_delivery(
  p_event_key text,
  p_telegram_chat_id bigint,
  p_payload_digest text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_payload_digest text := nullif(
    lower(btrim(coalesce(p_payload_digest, ''))),
    ''
  );
  v_delivery public.telegram_notification_deliveries%rowtype;
  v_now timestamptz := clock_timestamp();
  v_claim_token uuid := gen_random_uuid();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the Telegram notification service may claim deliveries.'
      using errcode = '42501';
  end if;

  if char_length(v_event_key) not between 1 and 200
     or p_telegram_chat_id is null
     or p_telegram_chat_id = 0
     or (
       v_payload_digest is not null
       and v_payload_digest !~ '^[0-9a-f]{64}$'
     ) then
    raise exception 'Invalid Telegram delivery claim.'
      using errcode = '22023';
  end if;

  insert into public.telegram_notification_deliveries (
    event_key,
    telegram_chat_id,
    payload_digest,
    status,
    created_at,
    updated_at
  )
  values (
    v_event_key,
    p_telegram_chat_id,
    v_payload_digest,
    'pending',
    v_now,
    v_now
  )
  on conflict (event_key, telegram_chat_id) do nothing;

  select delivery.*
    into v_delivery
  from public.telegram_notification_deliveries delivery
  where delivery.event_key = v_event_key
    and delivery.telegram_chat_id = p_telegram_chat_id
  for update;

  if v_delivery.payload_digest is distinct from v_payload_digest then
    return jsonb_build_object(
      'claimed', false,
      'status', 'conflict'
    );
  end if;

  if v_delivery.status = 'sent' then
    return jsonb_build_object(
      'claimed', false,
      'status', 'sent'
    );
  end if;

  if v_delivery.status = 'sending'
     and v_delivery.claimed_at > v_now - interval '10 minutes' then
    return jsonb_build_object(
      'claimed', false,
      'status', 'sending'
    );
  end if;

  if v_delivery.status = 'failed'
     and v_delivery.next_attempt_at is not null
     and v_delivery.next_attempt_at > v_now then
    return jsonb_build_object(
      'claimed', false,
      'status', 'retry_scheduled',
      'retryAt', v_delivery.next_attempt_at
    );
  end if;

  update public.telegram_notification_deliveries delivery
  set status = 'sending',
      attempt_count = delivery.attempt_count + 1,
      claim_token = v_claim_token,
      claimed_at = v_now,
      next_attempt_at = null,
      last_error = null,
      updated_at = v_now
  where delivery.id = v_delivery.id
  returning delivery.* into v_delivery;

  return jsonb_build_object(
    'claimed', true,
    'status', 'sending',
    'deliveryId', v_delivery.id,
    'claimToken', v_delivery.claim_token,
    'attemptCount', v_delivery.attempt_count
  );
end;
$$;

revoke all on function public.claim_telegram_notification_delivery(
  text, bigint, text
) from public, anon, authenticated;
grant execute on function public.claim_telegram_notification_delivery(
  text, bigint, text
) to service_role;

create or replace function public.finalize_telegram_notification_delivery(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_telegram_message_id bigint default null,
  p_error text default null,
  p_retry_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery public.telegram_notification_deliveries%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the Telegram notification service may finalize deliveries.'
      using errcode = '42501';
  end if;

  if p_delivery_id is null
     or p_claim_token is null
     or p_succeeded is null then
    raise exception 'Invalid Telegram delivery result.'
      using errcode = '22023';
  end if;

  select delivery.*
    into v_delivery
  from public.telegram_notification_deliveries delivery
  where delivery.id = p_delivery_id
  for update;

  if not found then
    return jsonb_build_object('updated', false, 'status', 'not_found');
  end if;

  -- A stale worker must never overwrite the result of a newer retry claim.
  if v_delivery.status <> 'sending'
     or v_delivery.claim_token <> p_claim_token then
    return jsonb_build_object(
      'updated', false,
      'status', v_delivery.status
    );
  end if;

  if p_succeeded then
    update public.telegram_notification_deliveries delivery
    set status = 'sent',
        claim_token = null,
        next_attempt_at = null,
        telegram_message_id = p_telegram_message_id,
        last_error = null,
        updated_at = v_now,
        sent_at = v_now
    where delivery.id = v_delivery.id;

    return jsonb_build_object('updated', true, 'status', 'sent');
  end if;

  v_retry_at := greatest(
    coalesce(
      p_retry_at,
      v_now + make_interval(
        secs => least(3600, 15 * power(2, least(v_delivery.attempt_count, 8))::integer)
      )
    ),
    v_now
  );

  update public.telegram_notification_deliveries delivery
  set status = 'failed',
      claim_token = null,
      next_attempt_at = v_retry_at,
      telegram_message_id = null,
      last_error = nullif(left(btrim(coalesce(p_error, '')), 500), ''),
      updated_at = v_now,
      sent_at = null
  where delivery.id = v_delivery.id;

  return jsonb_build_object(
    'updated', true,
    'status', 'failed',
    'retryAt', v_retry_at
  );
end;
$$;

revoke all on function public.finalize_telegram_notification_delivery(
  uuid, uuid, boolean, bigint, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.finalize_telegram_notification_delivery(
  uuid, uuid, boolean, bigint, text, timestamptz
) to service_role;
