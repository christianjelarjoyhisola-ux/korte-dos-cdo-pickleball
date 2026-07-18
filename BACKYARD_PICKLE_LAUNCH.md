# Backyard Pickle launch checklist

This repository is the clean, single-venue copy for **Backyard Pickle**.

## Business roles

- **Backyard Pickle / Court Owner** owns and operates the physical venue, sets court rates, receives 100% of court-rental revenue, and is responsible for venue operations.
- **Platform Provider / System Owner** owns and operates the booking software. The platform earns the separately disclosed customer booking fee configured in the System Owner dashboard.
- Keep the booking fee visibly separate from court rent on checkout, receipts, reports, and remittance records.

## Required before launch

1. Create a dedicated Supabase project. Never reuse another venue's project or customer data.
2. Copy `.env.example` to `.env.local` and replace every placeholder.
3. Put the new Supabase URL and anon key in `supabase-config.js` for the static frontend.
4. Run `SETUP_NEW_SUPABASE.sql` in the new project's SQL editor, then deploy all Edge Functions.
5. Run `node create-accounts.js` only after the real System Owner, Court Owner, and staff credentials are set.
6. In the dashboard, enter Backyard Pickle's courts, rates, payment accounts, QR codes, booking-fee rate, and remittance account.
7. Replace `court-splash.jpg` with a real, approved Backyard Pickle venue photo.
8. Replace the temporary location text in `index.html` and the agreement venue details in `admin.html`.
9. Set the Edge Function secrets listed in `.env.example`, including a restricted Google Vision key, Maileroo sending key, production domain, and a sender on a Maileroo-verified domain.
10. Test customer booking, payment verification, confirmation/reschedule email, cancellation, host booking, reporting, and monthly booking-fee remittance before launch.

> The Maileroo-provided domain currently saved in `.env.local` is for setup and testing only because it can send only to authorized recipients. Before production, verify a Backyard Pickle-owned domain in Maileroo, create a sending key for that domain, and replace `MAILEROO_API_KEY` and `EMAIL_FROM`.

## Recommended brand direction

Backyard Pickle should feel friendly, local, and energetic. The court-provided `backyardpicklelogo.jpg` is the primary brand mark across the website, dashboards, favicon, and booking emails. The supplied `linkimage.jpg` is the social sharing preview for public booking links.

## Still needed from the court owner

- Full public address and Google Maps link
- Approved venue photos
- Final support hours and expected response time for calls, texts, and Facebook messages
- Court names, schedules, rates, and policies
- GCash/bank merchant names, numbers, and QR images
- Final domain and email sender
- Signed platform-provider/court-owner agreement with real legal names

## Official customer contact

- Call or text: `0915 393 4597`
- Facebook: `https://web.facebook.com/profile.php?id=61590034812771`
