-- BPI QR success receipts can show the venue QR label instead of the legal
-- GCash account name and can replace the mobile number with an opaque token.
-- Keep this provider-specific so other receipt methods retain their existing
-- receiver-name checks.

insert into public.settings (key, value)
values ('bpi_merchant_name', 'Korte Dos')
on conflict (key) do nothing;
