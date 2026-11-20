# Project 2: Dead Projects Marketplace

**Working name:** SecondLife

**One-line pitch:** "Sell your abandoned project. Buy a head start."

**Memorable line:** *One builder's graveyard is another builder's gold mine.*

## The problem

Developers and founders have half-built apps, unused domains, old websites, and small audiences sitting idle. Buyers want a head start instead of starting from zero. Existing marketplaces (like Flippa) are crowded with scams and focus on profitable sites, not unfinished projects.

## Who pays

- **Sellers:** indie developers and founders who want something back from dead work.

- **Buyers:** beginner founders, agencies, and developers who want a head start.

## Business model

- **10 percent commission** on completed sales.

- Optional paid extras later: featured listing, verified badge, handover help.

## MVP scope

Listing types: **codebases, domains, and small websites.**

**Do NOT build yet:** mobile app, auctions, reviews, in-app chat (use email first), SaaS businesses with revenue verification.

## The cold start problem (the real challenge)

A marketplace is empty until both sides arrive. The plan:

1.  **Supply first.** Personally invite 30 sellers from Indie Hackers, Reddit, X, and GitHub before launch.

2.  Create 30 listings **yourself on their behalf with permission**, so the site never looks empty.

3.  Bring buyers only after the 30 listings exist.

## Trust system (this decides if the business lives or dies)

- **Ownership proof for code:** seller connects GitHub (read-only). The site shows commit history, languages, and last activity.

- **Ownership proof for domains:** seller adds a small DNS TXT record to prove control.

- **Escrow:** the buyer's money is held until handover is confirmed. Use a licensed escrow provider or a payment platform with held funds. Do not hold money yourself.

- **Handover checklist:** repo transfer, domain transfer, credentials list, and a 7-day confirmation window.

## User flow

1.  Seller signs up, connects GitHub or adds a domain, and fills a listing (price, description, what is missing).

2.  Site verifies ownership and shows a **Verified** badge.

3.  Buyer browses and filters (tech stack, type, price) and makes an offer.

4.  Seller accepts. Buyer pays into escrow.

5.  Handover checklist is completed step by step.

6.  Buyer confirms (or 7 days pass). Funds release to seller minus the commission.

## Data model (tables)

- users (id, email, role flags, payout_info_ref)

- listings (id, seller_id, type, title, description, price, tech_stack, status, verified)

- listing_assets (id, listing_id, kind: repo / domain / screenshot, reference, verified_at)

- offers (id, listing_id, buyer_id, amount, status)

- transactions (id, offer_id, amount, commission, escrow_status)

- handover_tasks (id, transaction_id, task, done_by, done_at)

- messages (id, offer_id, sender_id, body)

## Technical pieces

- GitHub OAuth (Open Authorization, a safe way to let a user grant access without sharing a password).

- DNS TXT check with a Node DNS lookup.

- Search with PostgreSQL full text search first. Do not add a separate search server yet.

- Escrow through a provider's API. Check provider rules for your country early.

- AI feature that helps: auto-generate a "project health report" from the repo (size, outdated packages, test coverage, README quality).

## Risks and honest answers

- **Stolen code:** require ownership proof, add a report button, and make sellers accept terms confirming they own the work.

- **Scams:** escrow plus verified badges.

- **Low prices:** dead projects often sell cheap. Mitigate by also listing domains and by focusing on projects with real traction (users, traffic, or design assets).

## Validation test (one week)

1.  Post in 3 communities: "Selling an abandoned project? I will list it for free and find you a buyer."

2.  Goal: **15 sellers** reply with real projects.

3.  Post a simple catalog (a public Notion page works) and ask in buyer communities who wants to buy.

4.  Goal: **at least 3 buyers** ask for introductions.

## Milestones

- **Milestone 1 (week 1):** auth, seller profile, listing creation, public listing pages, search and filters.

- **Milestone 2 (week 2):** GitHub connection and verification, domain verification, project health report.

- **Milestone 3 (week 3):** offers, messaging by email, admin approval of listings.

- **Milestone 4 (week 4):** escrow, handover checklist, commission handling.

## Starter prompt for Claude

> I am building SecondLife, a marketplace where developers sell abandoned projects, domains, and small websites. Read SPEC.md. Use Node.js, Express, PostgreSQL with Prisma, and a web front end. Build Milestone 1 only: authentication, listing creation with images, public listing pages, and search with filters. Keep the code simple, add tests, and explain each step in plain language.

## Shared rules for all three

- **Default stack:** Node.js + Express, PostgreSQL (Neon) with Prisma ORM, Firebase Authentication, Docker, and a web front end first (Flutter mobile later, only after people use the web version).

- **MVP (Minimum Viable Product):** the smallest version that proves people want it. Cut every feature that does not help prove that.

- **Payments warning:** Stripe does not open business accounts in Pakistan. Check this in week one. Options: a US company via Stripe Atlas, Paddle or Lemon Squeezy (they act as the seller for you), or Wise and Payoneer for payouts. Do not build payments until this is solved.

- **Security basics:** encrypt secrets, never store passwords yourself, keep one customer's data fully separate from another's, log who accessed what.

- **Legal basics:** write a privacy policy and terms of service before real users arrive. Talk to a lawyer before handling other people's money, emails, or employee data.

