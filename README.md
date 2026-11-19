# Visitors Data

A private dashboard for the portfolio's visit logs: a world map of where visitors
are, which ones keep coming back, and the full visit history for each one.

It's a static site (HTML/CSS/JS, no build step). It reads from the
`html-node-website` API's admin endpoints, which require a bearer token.

## How visitors are identified

The portfolio stores an anonymous random ID (`sv_vid`) in each browser's
localStorage and sends it with every page view. Visits are grouped by that ID;
visits logged before the ID existed are grouped by IP instead.

| Tier      | Rule                                  | Colour |
|-----------|---------------------------------------|--------|
| One-time  | seen on a single day                  | blue   |
| Returning | seen on 2+ different days             | green  |
| Frequent  | seen on 3+ days, or 5+ page views     | orange |

The same person on a different browser or device counts as a separate visitor.
Coordinates come from IP geolocation (ipinfo.io / geoip-lite), so they're
accurate to the city or ISP hub, not a street address.

## Setup

1. **On the API (Render → Environment):**
   - `ADMIN_TOKEN`: a long random secret. Generate one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - If `CORS_ORIGIN` is set, add the dashboard's URL to it
     (e.g. `https://visitors-xyz.netlify.app`).
2. **Host this folder** anywhere static: Netlify drop, Vercel, Cloudflare Pages,
   GitHub Pages (private repo + Pages), or a Render static site.
3. Open it, keep the API URL, paste the token. Tick "Remember on this device"
   to stay signed in.

## Local preview

```sh
python3 -m http.server 8080
# http://localhost:8080          real data (needs the token)
# http://localhost:8080/?demo    fake sample data, no API needed
```

## API used

- `GET /api/admin/visitors?days=30&minVisits=1&limit=500`: visitors grouped by ID, with totals
- `GET /api/admin/visitors/:id/visits`: every visit for one visitor (newest first)

Both need `Authorization: Bearer <ADMIN_TOKEN>`.
