# RallyOS interactive showroom

RallyOS is a resettable sales demo built beside the production Korte application. It uses browser-only seeded data and does not connect to live bookings, payments, notifications, or Supabase.

## Live demo

https://rallyos-pickleball-demo.pages.dev/

Deploy the current `demo/` directory to its isolated Cloudflare Pages project with:

```powershell
npm.cmd run deploy:demo
```

## Run locally

```powershell
npm.cmd run demo
```

Then open `http://127.0.0.1:4173/demo/`.

If port 4173 is already in use, run:

```powershell
node tools/serve-demo.mjs 4180
```

## Recommended sales story

1. Begin in **Owner / Today** to show revenue, occupancy, arrivals, and alerts.
2. Switch to **Player** and complete the three-step simulated GCash booking.
3. Return to **Owner / Schedule** to show the shared court timeline.
4. Open **Money** and approve a sample payment review.
5. Switch to **Play host** to run the live Open Play queue and rotation.
6. Finish in **Insights** with the utilization map and editable ROI scenario.

The persistent **Guided tour** control walks through the same sequence. **Reset demo** restores all seeded data.

## Shareable views

- Player booking: `/?role=player&view=book`
- Owner dashboard: `/?role=owner&view=today`
- Court schedule: `/?role=owner&view=schedule`
- Open Play operations: `/?role=host&view=play`
- Owner insights: `/?role=owner&view=insights`

## Structure

- `index.html` — accessible application shell and dialogs
- `app.js` — personas, navigation, guided tour, branding preview, and notifications
- `data.js` — deterministic shared demo state
- `views/` — player, operations, Open Play, and insights modules
- `styles/` — design tokens, shell, and isolated module styles
- `assets/` — original venue-neutral demo imagery
