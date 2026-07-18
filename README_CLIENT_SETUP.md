# Backyard Pickle Booking System

This is the dedicated single-venue copy for onboarding the Backyard Pickle court owner while keeping the Platform Provider's booking-fee model separate from court revenue.

## New Client Setup

1. Create a brand-new Supabase project for Backyard Pickle.
2. Copy `.env.example` to `.env.local` and replace every placeholder with the new project's values.
3. Run `SETUP_NEW_SUPABASE.sql` in the new Supabase SQL editor.
4. Update `supabase-config.js` with the new Supabase project URL and anon key.
5. Run `create-accounts.js` only after `.env.local` contains real, unique account credentials. Never put the service-role key in frontend files.
6. Complete the remaining court-owner details in `BACKYARD_PICKLE_LAUNCH.md`.
7. Deploy the Supabase edge functions to the new Supabase project.
8. Deploy the frontend to a new Cloudflare Pages project or domain.

Email delivery uses Maileroo. `EMAIL_FROM` must use a domain verified in the Maileroo dashboard, and `MAILEROO_API_KEY` must be that domain's sending key.

## Important

Do not reuse another court owner's Supabase project. Each court owner should have separate bookings, Open Play reservations, payment settings, and admin accounts.

Use `?localData=1` on the website URL when testing with browser-only demo data.
