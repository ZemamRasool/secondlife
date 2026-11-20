// My account: listings (with editor, screenshots, ownership proof), offers, deals, profile.
import { api, el, initAuth, message, money, signOut } from "./auth.js";
import { date, TYPE_LABEL, verifiedBadge } from "./ui.js";

const $ = (id) => document.getElementById(id);
let me = null;

function flash(text, ok = true) {
  message($("flash"), text, ok);
  if (text) setTimeout(() => message($("flash"), ""), 6000);
}

function btn(label, kind, onclick, attrs = {}) {
  const b = el("button", { class: `btn ${kind}`, type: "button", ...attrs }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onclick();
    } catch (err) {
      flash(err.message, false);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("app-view").classList.toggle("hidden", view !== "app");
  $("logout").classList.toggle("hidden", view !== "app");
}

// ---------------- tabs (#listings, #offers, #deals, #profile) ----------------
const loaders = { listings: loadListings, offers: loadOffers, deals: loadDeals, profile: loadProfile };
function currentTab() {
  const t = location.hash.slice(1).split("?")[0];
  return loaders[t] ? t : "listings";
}
async function openTab() {
  const name = currentTab();
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  if (q.get("github") === "connected") flash("GitHub connected. You can now add repositories to your listings.");
  if (q.get("github") === "failed") flash("GitHub connection didn't complete. Please try again.", false);
  try {
    await loaders[name]();
  } catch (err) {
    flash(err.message, false);
  }
}
document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => (location.hash = t.dataset.tab)));
window.addEventListener("hashchange", openTab);

async function start() {
  try {
    me = await api("/api/me");
  } catch {
    return;
  }
  $("who").textContent = me.displayName || me.email;
  $("admin-link").classList.toggle("hidden", !me.isAdmin);
  $("terms-banner").classList.toggle("hidden", me.termsAccepted);
  show("app");
  openTab();
}

// ---------------- listings ----------------
async function loadListings() {
  const list = await api("/api/my/listings");
  const box = $("my-listings");
  box.replaceChildren();
  if (!list.length) box.append(el("div", { class: "card empty" }, el("h2", {}, "Sell something you stopped working on"), el("p", { class: "muted" }, "A half-built app, a domain you never used, a small website. Listing is free; we take 10% only when it sells.")));
  for (const l of list) {
    box.append(
      el(
        "article",
        { class: "card" },
        el(
          "div",
          { class: "card-head" },
          el("div", {}, el("div", { class: "row" }, el("span", { class: "badge type" }, TYPE_LABEL[l.type]), verifiedBadge(l.verified), el("span", { class: `pill ${l.status}` }, l.status.replace("_", " "))), el("h3", {}, l.title)),
          el("div", { class: "price" }, money(l.price, l.currency)),
        ),
        l.rejectReason && l.status === "rejected" ? el("p", { class: "msg bad" }, `Changes needed: ${l.rejectReason}`) : "",
        l.pendingOffers ? el("p", { class: "msg ok" }, `${l.pendingOffers} offer(s) waiting. `, el("a", { href: "#offers" }, "See offers")) : "",
        el(
          "div",
          { class: "row" },
          ["draft", "rejected", "published", "pending_review"].includes(l.status) ? btn("Edit", "btn-ghost", () => openEditor(l.id)) : "",
          ["draft", "rejected"].includes(l.status) ? btn("Submit for review", "btn-primary", async () => {
            await api(`/api/my/listings/${l.id}/submit`, { method: "POST" });
            flash("Sent for review. We'll email you when it's live.");
            loadListings();
          }) : "",
          ["published", "under_offer", "sold"].includes(l.status) ? el("a", { class: "btn btn-ghost", href: `/l/${l.slug}` }, "View public page") : "",
          ["published", "draft", "rejected", "pending_review"].includes(l.status) ? btn("Take down", "btn-ghost", async () => {
            if (!confirm("Take this listing down? Pending offers will be declined.")) return;
            await api(`/api/my/listings/${l.id}/remove`, { method: "POST" });
            loadListings();
          }) : "",
        ),
      ),
    );
  }
}

function field(label, input, full = false) {
  return el("label", { class: `field ${full ? "full-row" : ""}` }, el("span", {}, label), input);
}

async function openEditor(id) {
  const ed = $("editor");
  ed.classList.remove("hidden");
  const l = id ? await api(`/api/my/listings/${id}`) : null;
  const v = (k, d = "") => (l && l[k] !== null && l[k] !== undefined ? String(l[k]) : d);
  const type = el("select", { name: "type" }, ["codebase", "website", "domain"].map((t) => el("option", { value: t, selected: v("type") === t }, TYPE_LABEL[t])));
  const title = el("input", { type: "text", name: "title", value: v("title"), maxlength: "90", required: true, placeholder: "e.g. Habit tracker app with 300 users" });
  const summary = el("input", { type: "text", name: "summary", value: v("summary"), maxlength: "200", required: true, placeholder: "One line: what it is and how far along" });
  const description = el("textarea", { name: "description", rows: "8", required: true, placeholder: "What it does, what's built, how it's built, why you stopped." });
  description.value = v("description");
  const price = el("input", { type: "number", name: "price", min: "10", step: "1", value: v("price"), required: true });
  const tech = el("input", { type: "text", name: "techStack", value: l ? l.techStack.join(", ") : "", placeholder: "react, node, postgresql" });
  const missing = el("textarea", { name: "whatsMissing", rows: "3", placeholder: "Be honest: buyers trust listings that say what's unfinished." });
  missing.value = v("whatsMissing");
  const traction = el("input", { type: "text", name: "traction", value: v("traction"), placeholder: "e.g. 120 sign-ups, 40 GitHub stars" });
  const visitors = el("input", { type: "number", name: "monthlyVisitors", min: "0", value: v("monthlyVisitors") });
  const out = el("div");

  const form = el(
    "form",
    { class: "form-grid" },
    field("Type", type),
    field("Asking price (USD)", price),
    field("Title", title, true),
    field("One-line summary", summary, true),
    field("Description", description, true),
    field("Tech stack (comma separated)", tech, true),
    field("What's missing", missing, true),
    field("Traction (optional)", traction),
    field("Monthly visitors (optional)", visitors),
    el("div", { class: "row full-row" }, el("button", { class: "btn btn-primary", type: "submit" }, l ? "Save changes" : "Create draft"), btn("Close", "btn-ghost", async () => ed.classList.add("hidden"))),
    out,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      type: type.value,
      title: title.value,
      summary: summary.value,
      description: description.value,
      price: Number(price.value),
      techStack: tech.value.split(",").map((s) => s.trim()).filter(Boolean),
      whatsMissing: missing.value || null,
      traction: traction.value || null,
      monthlyVisitors: visitors.value ? Number(visitors.value) : null,
    };
    try {
      const saved = await api(l ? `/api/my/listings/${l.id}` : "/api/my/listings", { method: l ? "PUT" : "POST", body });
      flash(l ? "Saved." : "Draft created. Now add screenshots and prove ownership below, then submit for review.");
      await openEditor(saved.id);
      loadListings();
    } catch (err) {
      message(out, err.message, false);
    }
  });

  ed.replaceChildren(el("div", { class: "card" }, el("h2", {}, l ? `Edit: ${l.title}` : "New listing"), form));
  if (l) ed.append(screenshotsCard(l), proofCard(l));
  ed.scrollIntoView({ behavior: "smooth" });
}

function screenshotsCard(l) {
  const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true });
  input.addEventListener("change", async () => {
    const form = new FormData();
    for (const f of input.files) form.append("images", f);
    try {
      await api(`/api/my/listings/${l.id}/images`, { method: "POST", body: form });
      openEditor(l.id);
    } catch (err) {
      flash(err.message, false);
    }
  });
  const shots = l.assets.filter((a) => a.kind === "screenshot");
  return el(
    "div",
    { class: "card" },
    el("h2", {}, "Screenshots"),
    el("div", { class: "shots" }, shots.map((s) => el("div", { class: "stack" }, el("img", { src: s.reference, alt: "" }), btn("Remove", "btn-ghost btn-sm", async () => { await api(`/api/my/listings/${l.id}/assets/${s.id}`, { method: "DELETE" }); openEditor(l.id); })))),
    el("label", { class: "drop" }, input, el("span", {}, "Add JPG, PNG or WEBP screenshots (up to 8)")),
  );
}

function proofCard(l) {
  const card = el("div", { class: "card stack" }, el("h2", {}, "Prove you own it"), el("p", { class: "muted" }, "Listings with proof get the Verified badge and sell faster. Codebases need their GitHub repository; domains and websites need a DNS record."));
  for (const a of l.assets.filter((x) => x.kind !== "screenshot")) {
    const row = el("div", { class: "stack card" }, el("div", { class: "row" }, el("span", { class: "strong" }, a.kind === "repo" ? `GitHub: ${a.reference}` : `Domain: ${a.reference}`), el("span", { class: `badge ${a.verified ? "verified" : "unverified"}` }, a.verified ? "✓ Proven" : "Waiting for DNS")));
    if (a.dnsRecord && !a.verified) {
      row.append(
        el("p", { class: "small" }, "Add this TXT record at your domain's DNS provider, then press Check:"),
        el("div", { class: "dns" }, `Type: TXT\nName: ${a.dnsRecord.name}\nValue: ${a.dnsRecord.value}`),
        el("div", { class: "row" }, btn("Check DNS now", "btn-primary btn-sm", async () => { await api(`/api/my/listings/${l.id}/assets/${a.id}/verify`, { method: "POST" }); flash("Domain verified."); openEditor(l.id); loadListings(); })),
      );
    }
    row.append(
      el(
        "div",
        { class: "row" },
        a.kind === "repo" ? btn("Refresh health report", "btn-ghost btn-sm", async () => { await api(`/api/my/listings/${l.id}/assets/${a.id}/health`, { method: "POST" }); flash("Health report is being rebuilt; it appears on your listing in a minute."); }) : "",
        btn("Remove", "btn-ghost btn-sm", async () => { await api(`/api/my/listings/${l.id}/assets/${a.id}`, { method: "DELETE" }); openEditor(l.id); loadListings(); }),
      ),
    );
    card.append(row);
  }
  const repo = el("input", { type: "text", placeholder: "github.com/you/project or you/project" });
  const domain = el("input", { type: "text", placeholder: "example.com" });
  card.append(
    el("div", { class: "row" }, repo, btn("Add repository", "btn-ghost", async () => {
      if (!me.github) { location.hash = "profile"; flash("Connect GitHub first, then come back.", false); return; }
      await api(`/api/my/listings/${l.id}/repos`, { method: "POST", body: { repo: repo.value } });
      flash("Repository verified. The health report will appear on your listing shortly.");
      openEditor(l.id);
      loadListings();
    })),
    el("div", { class: "row" }, domain, btn("Add domain", "btn-ghost", async () => { await api(`/api/my/listings/${l.id}/domains`, { method: "POST", body: { domain: domain.value } }); openEditor(l.id); })),
  );
  return card;
}

$("new-listing").addEventListener("click", () => {
  if (!me.termsAccepted) {
    location.hash = "profile";
    flash("Please accept the terms first.", false);
    return;
  }
  openEditor(null);
});

// ---------------- offers ----------------
async function loadOffers() {
  const offers = await api("/api/offers");
  const box = $("offers");
  box.replaceChildren();
  if (!offers.length) box.append(el("div", { class: "card empty" }, el("h2", {}, "No offers yet"), el("p", { class: "muted" }, "Offers you make and receive show up here, with the full conversation.")));
  for (const o of offers) {
    const reply = el("textarea", { rows: "2", placeholder: "Write a message…" });
    const actions = el("div", { class: "row" });
    if (o.status === "pending" && o.role === "seller") {
      actions.append(
        btn(`Accept ${money(o.amount, o.listing.currency)}`, "btn-primary", async () => {
          if (!confirm(`Accept ${money(o.amount, o.listing.currency)}? The listing comes off sale and escrow opens.`)) return;
          await api(`/api/offers/${o.id}/accept`, { method: "POST" });
          flash("Offer accepted. Escrow is being set up. Wait until it says FUNDED before handing anything over.");
          location.hash = "deals";
        }),
        btn("Decline", "btn-ghost", async () => { await api(`/api/offers/${o.id}/decline`, { method: "POST" }); loadOffers(); }),
      );
    }
    if (o.status === "pending" && o.role === "buyer") actions.append(btn("Withdraw offer", "btn-ghost", async () => { await api(`/api/offers/${o.id}/withdraw`, { method: "POST" }); loadOffers(); }));
    if (o.dealId) actions.append(el("a", { class: "btn btn-ghost", href: "#deals" }, "Go to deal"));
    box.append(
      el(
        "article",
        { class: "card" },
        el("div", { class: "card-head" }, el("div", {}, el("div", { class: "muted small" }, o.role === "seller" ? `Offer from ${o.buyer}` : "Your offer"), el("h3", {}, el("a", { href: `/l/${o.listing.slug}` }, o.listing.title))), el("div", { class: "right" }, el("div", { class: "price" }, money(o.amount, o.listing.currency)), el("span", { class: `pill ${o.status}` }, o.status))),
        el("p", { class: "muted small" }, `Asking ${money(o.listing.price, o.listing.currency)} · ${date(o.createdAt)}`),
        el("div", { class: "thread" }, o.messages.map((m) => el("div", { class: `bubble ${m.mine ? "mine" : ""}` }, el("small", {}, `${m.mine ? "You" : m.from} · ${date(m.at)}`), m.body))),
        ["pending", "accepted"].includes(o.status) ? el("div", { class: "stack" }, reply, btn("Send message", "btn-ghost", async () => { if (!reply.value.trim()) return; await api(`/api/offers/${o.id}/messages`, { method: "POST", body: { body: reply.value } }); loadOffers(); })) : "",
        actions,
      ),
    );
  }
}

// ---------------- deals ----------------
const STAGES = [
  ["awaiting_payment", "Payment"],
  ["funded", "Escrow funded"],
  ["release_approved", "Buyer confirmed"],
  ["released", "Seller paid"],
];

async function loadDeals() {
  const deals = await api("/api/deals");
  const box = $("deals");
  box.replaceChildren();
  if (!deals.length) box.append(el("div", { class: "card empty" }, el("h2", {}, "No deals yet"), el("p", { class: "muted" }, "When an offer is accepted, the deal and its handover checklist appear here.")));
  for (const d of deals) {
    const reached = STAGES.findIndex(([s]) => s === d.escrowStatus);
    const timeline = el("div", { class: "timeline" }, STAGES.map(([, label], i) => el("span", { class: reached >= i ? "on" : "" }, label)));
    const steps = el(
      "ul",
      { class: "steps-list" },
      d.tasks.map((t) =>
        el(
          "li",
          { class: t.done ? "done" : "" },
          el("span", {}, t.task),
          el("span", { class: "state" }, t.confirmed ? "✓ received" : t.done ? "done by seller" : "to do"),
          d.role === "seller" && !t.done && d.escrowStatus === "funded" ? btn("Mark done", "btn-primary btn-sm", async () => { await api(`/api/deals/${d.id}/tasks/${t.id}/done`, { method: "POST" }); loadDeals(); }) : "",
          d.role === "buyer" && t.done && !t.confirmed && d.escrowStatus === "funded" ? btn("I got it", "btn-ghost btn-sm", async () => { await api(`/api/deals/${d.id}/tasks/${t.id}/confirm`, { method: "POST" }); loadDeals(); }) : "",
        ),
      ),
    );
    const notes = el("div", { class: "stack" });
    if (d.escrowStatus === "awaiting_payment") notes.append(el("p", { class: "msg ok" }, d.role === "buyer" ? "Pay into escrow using the instructions we emailed you (from Escrow.com). Never pay the seller directly." : "Waiting for the buyer to pay into escrow. Don't hand anything over yet."));
    if (d.escrowStatus === "funded" && !d.handoverDoneAt) notes.append(el("p", { class: "msg ok" }, d.role === "seller" ? "The money is held in escrow. Hand everything over and tick each step." : "Your money is held in escrow. The seller is handing everything over."));
    if (d.escrowStatus === "funded" && d.handoverDoneAt && d.role === "buyer") {
      notes.append(
        el("p", { class: "msg ok" }, `Handover finished. Check everything, then confirm. If you do nothing, the money is released to the seller on ${date(d.releaseDueAt)}.`),
        el("div", { class: "row" }, btn("Everything received — release payment", "btn-primary", async () => { if (!confirm("Confirm you received everything? This releases the money to the seller.")) return; await api(`/api/deals/${d.id}/confirm`, { method: "POST" }); loadDeals(); }), btn("Something is wrong", "btn-danger", async () => { const reason = prompt("What's wrong? The money stays in escrow while we look into it."); if (!reason) return; await api(`/api/deals/${d.id}/dispute`, { method: "POST", body: { reason } }); loadDeals(); })),
      );
    }
    if (d.escrowStatus === "disputed") notes.append(el("p", { class: "msg bad" }, `Disputed: ${d.disputeReason}. Our team is reviewing it; the money stays in escrow.`));
    if (d.escrowStatus === "release_approved") notes.append(el("p", { class: "msg ok" }, "Confirmed. The escrow is paying the seller."));
    box.append(
      el(
        "article",
        { class: "card stack" },
        el("div", { class: "card-head" }, el("div", {}, el("div", { class: "muted small" }, d.role === "buyer" ? `Buying from ${d.counterpart}` : `Selling to ${d.counterpart}`), el("h3", {}, el("a", { href: `/l/${d.listing.slug}` }, d.listing.title))), el("div", { class: "right" }, el("div", { class: "price" }, money(d.amount, d.currency)), el("span", { class: `pill ${d.escrowStatus}` }, d.escrowStatus.replace("_", " ")))),
        d.role === "seller" ? el("p", { class: "muted small" }, `Commission ${money(d.commission, d.currency)} · you receive ${money(d.sellerPayout, d.currency)}`) : "",
        timeline,
        notes,
        el("h3", { class: "group-title" }, "Handover checklist"),
        steps,
      ),
    );
  }
}

// ---------------- profile ----------------
async function loadProfile() {
  me = await api("/api/me");
  $("terms-banner").classList.toggle("hidden", me.termsAccepted);
  const name = el("input", { type: "text", value: me.displayName || "", maxlength: "60" });
  const bio = el("textarea", { rows: "3", maxlength: "1000" });
  bio.value = me.bio || "";
  const website = el("input", { type: "url", value: me.website || "", placeholder: "https://" });
  const payout = el("input", { type: "text", value: me.payoutInfo || "", placeholder: "e.g. Payoneer: you@email.com" });
  const out = el("div");
  const terms = me.termsAccepted
    ? el("p", { class: "msg ok" }, `You accepted the terms (version ${me.termsVersion}).`)
    : el(
        "div",
        { class: "stack" },
        el("p", {}, "To buy or sell, accept the ", el("a", { href: "/terms", target: "_blank" }, "terms"), " and ", el("a", { href: "/privacy", target: "_blank" }, "privacy policy"), `. In short: you only sell what you own, every deal goes through escrow, and sellers pay a ${me.commissionPercent}% commission on completed sales.`),
        btn("I accept", "btn-primary", async () => { await api("/api/me/terms", { method: "POST", body: { accept: true } }); flash("Thanks! You can now sell and make offers."); loadProfile(); }),
      );
  const gh = me.github
    ? el("div", { class: "stack" }, el("p", {}, `Connected as `, el("b", {}, me.github), me.githubPrivateAccess ? " (with private repo access)" : " (public repos)"), el("div", { class: "row" }, btn("Disconnect GitHub", "btn-ghost", async () => { await api("/api/me/github", { method: "DELETE" }); loadProfile(); }), me.githubPrivateAccess ? "" : btn("Allow private repos", "btn-ghost", async () => { const r = await api("/api/me/github/connect?private=1"); location.href = r.url; })))
    : el("div", { class: "stack" }, el("p", { class: "muted" }, "We only read: to prove you own a repo and to build its health report. Your token is encrypted, and you can disconnect any time."), el("div", { class: "row" }, btn("Connect GitHub", "btn-primary", async () => { const r = await api("/api/me/github/connect"); location.href = r.url; }), btn("Connect with private repos", "btn-ghost", async () => { const r = await api("/api/me/github/connect?private=1"); location.href = r.url; })));
  $("profile").replaceChildren(
    el(
      "div",
      { class: "app-grid" },
      el("div", { class: "card stack" }, el("h2", {}, "Terms"), terms, el("h2", {}, "GitHub"), gh),
      el(
        "div",
        { class: "card stack" },
        el("h2", {}, "Public profile"),
        field("Display name", name),
        field("About you", bio),
        field("Website", website),
        el("h2", {}, "How you get paid"),
        field("Only our team sees this", payout),
        btn("Save profile", "btn-primary", async () => { await api("/api/me", { method: "PATCH", body: { displayName: name.value || undefined, bio: bio.value, website: website.value, payoutInfo: payout.value } }); message(out, "Saved.", true); }),
        out,
      ),
    ),
    el(
      "div",
      { class: "card stack" },
      el("h2", {}, "Your data"),
      el("div", { class: "row" }, btn("Download my data", "btn-ghost", async () => { const data = await api("/api/me/export"); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const a = el("a", { href: url, download: "secondlife-export.json" }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); }), btn("Delete my account", "btn-danger", async () => { if (prompt("Type DELETE to delete your account and listings for good.") !== "DELETE") return; await api("/api/me", { method: "DELETE", body: { confirm: "DELETE" } }); await signOut(); })),
    ),
  );
}

$("logout").addEventListener("click", () => signOut());
initAuth({
  form: $("login-form"),
  googleBtn: $("google-btn"),
  hint: $("login-hint"),
  say: (text, ok) => message($("login-msg"), text, ok),
  onSignedIn: start,
  onSignedOut: () => show("login"),
});
