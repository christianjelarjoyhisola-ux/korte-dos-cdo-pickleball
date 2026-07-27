-- MariBank's current share screen can obscure the transaction date/time row.
-- Keep replay protection authoritative by pairing the provider-scoped
-- six-digit reference with the exact principal amount. This also lets owners
-- approve already-stored audits whose date/time could not be read.

create or replace function public.payment_review_ledger_keys(
  p_extracted jsonb,
  p_fallback_provider text default null,
  p_fallback_reference text default null
)
returns table (
  ledger_key text,
  provider_key text
)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  clean_key text;
  clean_provider text;
  raw_reference text;
  amount_text text;
  explicit_key_count integer := 0;
begin
  if jsonb_typeof(p_extracted->'dedupeKeys') = 'array' then
    for item in
      select value
      from jsonb_array_elements(p_extracted->'dedupeKeys')
    loop
      clean_key := nullif(btrim(item->>'key'), '');
      clean_provider := nullif(lower(btrim(item->>'providerKey')), '');
      if clean_key is not null
         and clean_provider is not null
         and length(clean_key) <= 240
         and length(clean_provider) <= 80 then
        ledger_key := clean_key;
        provider_key := clean_provider;
        explicit_key_count := explicit_key_count + 1;
        return next;
      end if;
    end loop;

    if explicit_key_count > 0 then
      return;
    end if;
  end if;

  clean_provider := lower(coalesce(
    nullif(btrim(p_extracted->>'provider'), ''),
    nullif(btrim(p_fallback_provider), '')
  ));
  raw_reference := coalesce(
    nullif(btrim(p_extracted->>'ref'), ''),
    nullif(btrim(p_extracted->>'submittedReference'), ''),
    nullif(btrim(p_fallback_reference), '')
  );

  if raw_reference is not null and clean_provider = 'gcash' then
    ledger_key := raw_reference;
    provider_key := 'gcash';
    return next;
  elsif raw_reference is not null
        and clean_provider in ('bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    ledger_key := clean_provider || ':' || raw_reference;
    provider_key := clean_provider;
    return next;
  end if;

  if clean_provider = 'bdopay'
     and nullif(btrim(p_extracted->>'invoice'), '') is not null then
    ledger_key := 'bdopay_invoice:' || btrim(p_extracted->>'invoice');
    provider_key := 'bdopay_invoice';
    return next;
  end if;

  if clean_provider = 'maya'
     and nullif(btrim(p_extracted->>'instapayRefNo'), '') is not null then
    ledger_key := 'maya_instapay:' || btrim(p_extracted->>'instapayRefNo');
    provider_key := 'maya_instapay';
    return next;
  end if;

  if clean_provider = 'bpi'
     and nullif(btrim(p_extracted->>'bpiTransactionRefNo'), '') is not null then
    ledger_key :=
      'bpi_transaction:' || btrim(p_extracted->>'bpiTransactionRefNo');
    provider_key := 'bpi_transaction';
    return next;
  end if;

  if clean_provider = 'maribank'
     and raw_reference ~ '^[0-9]{6}$' then
    amount_text := p_extracted->>'amount';
    if amount_text ~ '^[0-9]+([.][0-9]+)?$'
       and amount_text::numeric > 0 then
      ledger_key := 'maribank_transaction:'
        || raw_reference
        || ':' || to_char(
          round(amount_text::numeric, 2),
          'FM999999999999990.00'
        );
      provider_key := 'maribank_transaction';
      return next;
    end if;
  end if;
end;
$$;

revoke all on function public.payment_review_ledger_keys(jsonb, text, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
