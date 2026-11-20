# SecondLife

**Sell your abandoned project. Buy a head start.**
*One builder's graveyard is another builder's gold mine.*

A marketplace for half-built codebases, unused domains and small websites. Sellers prove they own what they sell, buyers see a health report before they offer, and every deal goes through a licensed escrow company with a handover checklist. SecondLife takes 10% of completed sales. Built to `SPEC.md`, Milestones 1–4.

## What it does

| | |
|---|---|
| **Browse and search** | Full-text search (PostgreSQL, best match first) with filters for type, tech stack, price and "verified only", plus sorting and paging. The URL holds the search, so it can be shared. |
| **Listings** | Codebases, domains, websites. Title, summary, description, price, tech tags, what's missing, traction, screenshots. Flow: draft → admin review → live → under offer → sold. If the seller changes what's being sold, the listing goes back to review; price-only changes don't. |
| **Ownership proof** | **GitHub:** the seller connects GitHub (read-only use), and we check they own or administer the repo, then show its commits, stars and last activity. **Domains:** the seller adds a DNS TXT record `_secondlife.<domain>`, and we check it. A listing gets **Verified** only when the right proof is in place and nothing is left unproven. |
| **Project health report** | Fixed checks give the same score every time (0–100): README, tests, outdated packages (checked live against npm), licence, CI, setup docs, commit history, and no committed secrets. The AI then writes a plain-English summary for buyers. |
| **Offers and messages** | Buyers make offers with a message. Conversations stay on the site, and each message is **emailed** to the other side without revealing anyone's email address. |
| **Deals** | Accepting an offer takes the listing off sale, closes other offers and opens **escrow**. The handover checklist depends on the listing type. The seller can only start once escrow is **funded**. After handover, the buyer confirms, or opens a dispute within **7 days**; otherwise payment is approved automatically. |
| **Escrow** | **Manual (works today):** each deal is opened on Escrow.com by the admin as broker, and the admin records "Funded" and "Released". **Escrow.com API:** deals are created automatically and their status is checked every 10 minutes. SecondLife never holds the money itself. |
| **Commission** | 10% of the sale, in whole cents, paid by the seller as an Escrow.com broker fee. Admin shows commission earned and pending. |
| **Admin** (`/admin`) | Live-listing count against the cold-start goal of 30, review queue (approve or send back with a reason), **list a project for a seller with their permission** (the cold-start plan), deals with escrow actions and dispute decisions, reports, users (ban), failed jobs, audit log. |

## Security

- **No passwords stored:** login is through Firebase (email link or Google).
- **Encrypted:** GitHub tokens and payout details are encrypted with AES-256-GCM. GitHub is only ever read, and can be disconnected at any time.
- **Separation:** every seller, offer and deal query checks it belongs to the logged-in user. Tests prove other users get "not found".
- **Private details:** buyers and sellers never see each other's email address. DNS proof values and payout details are never public.
- **GitHub connection:** the OAuth "state" is signed and expires after 10 minutes, so it can't be forged or replayed.
- **Uploads:** screenshots are checked by their real content and stored with random names.
- **Search input:** search uses parameterised SQL, and a test tries an injection.
- **Headers:** strict Content Security Policy with no inline scripts, no framing, HSTS in production.
- **Rate limits:** on the API, offers, messages, reports and GitHub/DNS checks.
- **Audit log:** every important action, and every admin request (including denied ones).
- **Abuse handling:** a report button, admin removal, and bans (a banned seller's listings come down).
- **Money safety:** status changes are atomic, so a double click or two tabs can't accept two offers or release twice. The money sits with a licensed escrow company, never with us.
- **Production checks:** the server refuses to start in production without https, real email, or GitHub OAuth.

---

## Run it on your computer

You need **Node 22** and **Docker Desktop**.

```bash
cd secondlife
copy .env.example .env           # Mac/Linux: cp .env.example .env
npm install
npm run gen:key                  # paste the output into .env as ENCRYPTION_KEY=...
docker compose up -d db
npx prisma generate
npx prisma migrate deploy
npm run dev                      # http://localhost:3000
```

Set `ADMIN_EMAILS=you@example.com` in `.env`. With `AUTH_MODE=dev` you can log in as any email, which makes it easy to play buyer, seller and admin in different browser windows.

**Try the full flow:**
1. As a seller, open `/app`, go to Profile and accept the terms. Create a listing under My listings, add screenshots, then Submit for review.
2. As the admin, approve it in `/admin`.
3. As a buyer (a different email), open the listing from the home page and make an offer.
4. As the seller, open Offers and Accept.
5. As the admin, mark the deal **Funded**.
6. As the seller, open Deals and tick each handover step.
7. As the buyer, open Deals and choose **Everything received**.
8. As the admin, mark it **Released**. The listing now shows as Sold.

Emails are printed in the terminal while `MAIL_PROVIDER=console`.

**GitHub verification locally:** create an OAuth app at github.com/settings/developers with callback `http://localhost:3000/auth/github/callback`, then fill in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Tests
```bash
docker compose exec db createdb -U secondlife secondlife_test
```
PowerShell:
```powershell
$env:DATABASE_URL="postgresql://secondlife:secondlife@localhost:5432/secondlife_test"; npx prisma migrate deploy
Remove-Item Env:DATABASE_URL
npm test
```
48 tests cover listings, review, search and filters, cold start, GitHub and DNS proof, health reports, offers, messages, the full deal flow, auto-release, disputes and refunds, commission, privacy between users, bans, reports, rate limits and settings checks. GitHub, DNS, email and AI are faked, so the tests cost nothing.

---

## Going live

1. **Login:** set up Firebase, the same way as RefundRadar (see its README), then set `AUTH_MODE=firebase`.
2. **GitHub:** create an OAuth app with your real domain as the callback, and fill in the two `GITHUB_*` settings.
3. **Email:** in Postmark, create a server and verify your sending domain. Then set `MAIL_PROVIDER=postmark`, `POSTMARK_SERVER_TOKEN` and `MAIL_FROM`.
4. **Escrow:** open an Escrow.com account and check its rules for your country (SPEC: do this early).
   - Start with `ESCROW_PROVIDER=manual`.
   - To automate it, request API access, test on the sandbox, then set `ESCROW_PROVIDER=escrowcom` and the `ESCROWCOM_*` settings. Use `https://api.escrow.com/2017-09-01` for live deals.
   - The API request follows Escrow.com's documented broker-transaction format. **Run one sandbox deal end to end before going live.**
5. **Server:** `NODE_ENV=production`, an https `PUBLIC_BASE_URL`, a managed Postgres (e.g. Neon), and a fresh `ENCRYPTION_KEY` that you **back up**.
6. **Legal:** `/terms` and `/privacy` are drafts with a visible notice. Have a lawyer review them, then remove the notice.

## Cold start plan (SPEC.md)
1. Invite 30 sellers from Indie Hackers, Reddit, X and GitHub.
2. With each seller's permission, publish their project using **Admin → List a project for a seller**. The seller is emailed, takes over the listing by logging in with that email, and can add GitHub or DNS proof.
3. Invite buyers only once the admin tile shows 30 live listings.

---

## What each file does

| File | In simple words |
|---|---|
| `SPEC.md` | The product plan. |
| `prisma/schema.prisma` | Tables: users, listings, listing_assets (repos, domains, screenshots), health_reports, offers, messages, transactions (deals), handover_tasks, reports, jobs, audit_logs. |
| `prisma/migrations/` | The SQL that creates them, including the search column and its indexes. |
| `src/config.ts` | Reads `.env`; refuses missing or unsafe settings. |
| `src/bootstrap.ts`, `server.ts`, `worker.ts` | Connects the real services; starts the website; runs background jobs. |
| `src/app.ts` | Security headers, rate limits, which areas need login, all routes. |
| `src/lib/crypto.ts` | Encryption. |
| `src/lib/audit.ts` | Audit log. |
| `src/lib/util.ts` | Slugs, tags, domain and repo clean-up, signed tokens, money, image checks. |
| `src/jobs/queue.ts`, `handlers.ts` | Background jobs in Postgres: emails, health reports, escrow checks, auto-release. |
| `src/services/listings.ts` | Listings, review status, search, GitHub and DNS ownership proof, the Verified rule. |
| `src/services/deals.ts` | Offers, messages, accepting, escrow states, handover checklist, 7-day auto-release, disputes. |
| `src/services/escrow.ts` | Manual escrow and the Escrow.com API. |
| `src/services/github.ts` | Reading from GitHub (repo, languages, commits, files). |
| `src/services/healthReport.ts` | Health checks, score and AI summary. |
| `src/services/mailer.ts` | Email through the console or Postmark. |
| `src/services/media.ts` | Screenshot storage. |
| `src/routes/public.ts` | Search, listing page, seller page, tags, images. |
| `src/routes/me.ts` | Profile, terms, GitHub connect and callback, export, delete. |
| `src/routes/sell.ts` | My listings, screenshots, proofs, reports. |
| `src/routes/deals.ts` | Offers, messages, deals. |
| `src/routes/admin.ts` | Admin. |
| `public/index.html` + `js/browse.js` | Home: search and filters. |
| `public/listing.html` + `js/listing.js` | Listing page: proof, health report, offer box. |
| `public/seller.html` + `js/seller.js` | Seller profile. |
| `public/app.html` + `js/app.js` | My account: listings editor, offers, deals, profile. |
| `public/admin.html` + `js/admin.js` | Admin dashboard. |
| `public/js/auth.js`, `js/ui.js` | Login and shared page helpers. |
| `public/terms.html`, `privacy.html` | Draft legal pages. |
| `tests/` | 48 automatic tests. |

## Known limits
- **Private repos:** GitHub OAuth apps have no read-only scope for private repos, so the seller has to grant `repo` scope, and we still only read. A GitHub App would allow true read-only access later.
- **Test coverage:** the health report checks whether tests *exist*. It doesn't run them.
- **Messages:** replies happen on the site. Replying by email isn't built yet.
- **Escrow.com webhooks:** not used. The status is checked every 10 minutes instead.
- **Auctions, reviews, revenue-verified SaaS listings and a mobile app:** left out on purpose, as the spec says.
