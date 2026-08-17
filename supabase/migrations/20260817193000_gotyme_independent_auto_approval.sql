-- Give GoTyme its own receipt-verification configuration. Initial values are
-- copied once from the existing destination so deployment preserves today's
-- account while all future GoTyme changes remain independent.

insert into public.settings (key, value)
values ('payment_method_gotyme', '1')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

insert into public.settings (key, value)
values ('gotyme_auto_approve', '1')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

insert into public.settings (key, value)
select
  'gotyme_recipient_name',
  coalesce(nullif(btrim(value), ''), 'Korte DOS')
from public.settings
where key = 'gcash_merchant_name'
on conflict (key) do nothing;

insert into public.settings (key, value)
select
  'gotyme_destination_suffix',
  right(upper(regexp_replace(value, '[^A-Za-z0-9]', '', 'g')), 4)
from public.settings
where key = 'gcash_qr_account_id'
  and length(upper(regexp_replace(value, '[^A-Za-z0-9]', '', 'g')))
      between 12 and 24
  and upper(regexp_replace(value, '[^A-Za-z0-9]', '', 'g')) ~ '[A-Z]'
  and upper(regexp_replace(value, '[^A-Za-z0-9]', '', 'g')) ~ '[0-9]'
on conflict (key) do nothing;

insert into public.settings (key, value)
values
  ('gotyme_recipient_name', 'Korte DOS'),
  ('gotyme_destination_suffix', 'A1BS')
on conflict (key) do nothing;
