// Admin dashboard. Every request is checked on the server and written to the audit log.
import { api, el, initAuth, message, money, signOut, totalsText } from "./auth.js";
import { TYPE_LABEL, verifiedBadge } from "./ui.js";

const $ = (id) => document.getElementById(id);
const when = (d) => (d ? new Date(d).toLocaleString() : "—");
const say = (t, ok) => message($("admin-msg"), t, ok);

function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("app-view").classList.toggle("hidden", view !== "app");
  $("logout").classList.toggle("hidden", view === "login");
}

function btn(label, kind, fn) {
  const b = el("button", { class: `btn btn-sm ${kind}`, type: "button" }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await fn();
      await refresh();
    } catch (err) {
      say(err.message, false);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

const tile = (label, value, sub) => el("div", { class: "card tile" }, el("div", { class: "muted small" }, label), el("div", { class: "big" }, value), sub ? el("div", { class: "muted small" }, sub) : "");

async function loadOverview() {
  const o = await api("/api/admin/overview");
  const L = o.listings;
  $("tiles").replaceChildren(
    tile("Live listings", String(L.published || 0), `Goal before inviting buyers: ${o.coldStartGoal.target} · ${o.verifiedLive} verified`),
    tile("To review", String(L.pending_review || 0), `${L.draft || 0} drafts`),
    tile("Members", String(o.users), `${o.offersPending} offers waiting`),
    tile("Deals in progress", String((o.deals.awaiting_payment || 0) + (o.deals.funded || 0) + (o.deals.release_approved || 0)), `${o.deals.disputed || 0} disputed`),
    tile("Commission earned", totalsText(o.commissionEarned) || "$0", `Pending: ${totalsText(o.commissionPending) || "$0"}`),
    tile("Sales volume", totalsText(o.salesVolume) || "$0", `${o.openReports} open reports · ${o.failedJobs} failed jobs`),
  );
}

async function loadReview() {
  const rows = await api("/api/admin/review");
  const box = $("review");
  box.replaceChildren();
  if (!rows.length) box.append(el("p", { class: "muted" }, "Nothing waiting."));
  for (const l of rows) {
    box.append(
      el(
        "div",
        { class: "card stack" },
        el("div", { class: "row" }, el("span", { class: "badge type" }, TYPE_LABEL[l.type]), verifiedBadge(l.verified), el("b", {}, l.title), el("span", { class: "muted small" }, `${money(l.price, l.currency)} · ${l.sellerEmail}`)),
        el("p", {}, l.summary),
        el("details", {}, el("summary", {}, "Description, proofs, what's missing"), el("p", { class: "prose-text small" }, l.description), el("p", { class: "small" }, `Proofs: ${l.proofs.map((p) => `${p.kind} ${p.reference} ${p.verified ? "✓" : "✗"}`).join(", ") || "none"}`), l.whatsMissing ? el("p", { class: "small" }, `Missing: ${l.whatsMissing}`) : ""),
        el(
          "div",
          { class: "row" },
          btn("Approve", "btn-primary", () => api(`/api/admin/listings/${l.id}/approve`, { method: "POST" })),
          btn("Send back", "btn-ghost", async () => {
            const reason = prompt("What should the seller change?");
            if (reason) await api(`/api/admin/listings/${l.id}/reject`, { method: "POST", body: { reason } });
          }),
          btn("Remove", "btn-danger", () => api(`/api/admin/listings/${l.id}/remove`, { method: "POST" })),
        ),
      ),
    );
  }
}

async function loadDeals() {
  const s = $("deal-filter").value;
  const rows = await api(`/api/admin/deals${s ? `?status=${s}` : ""}`);
  const tbody = $("deals");
  tbody.replaceChildren();
  if (!rows.length) tbody.append(el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No deals.")));
  for (const d of rows) {
    const actions = el("td", { class: "row" });
    if (d.escrowStatus === "awaiting_payment") actions.append(btn("Funded", "btn-primary", () => api(`/api/admin/deals/${d.id}/funded`, { method: "POST" })), btn("Cancel", "btn-ghost", () => api(`/api/admin/deals/${d.id}/cancel`, { method: "POST" })));
    if (d.escrowStatus === "release_approved") actions.append(btn("Released", "btn-primary", () => api(`/api/admin/deals/${d.id}/released`, { method: "POST" })));
    if (d.escrowStatus === "disputed") actions.append(btn("Pay seller", "btn-ghost", () => api(`/api/admin/deals/${d.id}/released`, { method: "POST" })), btn("Refund buyer", "btn-danger", () => api(`/api/admin/deals/${d.id}/refund`, { method: "POST" })));
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, el("a", { href: `/l/${d.listing.slug}` }, d.listing.title)),
        el("td", { class: "small" }, `${d.buyer} → ${d.seller}`, d.sellerPayoutInfo ? el("div", { class: "muted" }, `Payout: ${d.sellerPayoutInfo}`) : ""),
        el("td", { class: "num-cell" }, d.amount),
        el("td", { class: "num-cell" }, d.commission),
        el("td", {}, el("span", { class: `pill ${d.escrowStatus}` }, d.escrowStatus.replace("_", " ")), d.disputeReason ? el("div", { class: "err" }, d.disputeReason) : "", d.escrowRef ? el("div", { class: "muted small" }, `Escrow #${d.escrowRef}`) : ""),
        el("td", { class: "small" }, `${d.tasksDone}/${d.tasksTotal}`, d.releaseDueAt ? el("div", { class: "muted" }, `auto ${when(d.releaseDueAt)}`) : ""),
        actions,
      ),
    );
  }
}

async function loadReports() {
  const rows = await api("/api/admin/reports");
  const box = $("reports");
  box.replaceChildren();
  if (!rows.length) box.append(el("p", { class: "muted" }, "No open reports."));
  for (const r of rows) {
    box.append(el("div", { class: "card stack" }, el("div", {}, el("a", { href: `/l/${r.listing.slug}` }, r.listing.title), el("span", { class: "muted small" }, ` · by ${r.reporter}`)), el("p", { class: "small" }, r.reason), el("div", { class: "row" }, btn("Remove listing", "btn-danger", () => api(`/api/admin/listings/${r.listing.id}/remove`, { method: "POST" })), btn("Resolve", "btn-ghost", () => api(`/api/admin/reports/${r.id}/resolve`, { method: "POST" })))));
  }
}

async function loadUsers() {
  const q = $("user-q").value.trim();
  const rows = await api(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const tbody = $("users");
  tbody.replaceChildren();
  for (const u of rows) {
    tbody.append(el("tr", {}, el("td", {}, u.email), el("td", {}, u.name || "—"), el("td", {}, u.github || "—"), el("td", { class: "num-cell" }, String(u.listings)), el("td", { class: "num-cell" }, String(u.sales)), el("td", { class: "num-cell" }, String(u.purchases)), el("td", {}, u.banned ? btn("Unban", "btn-ghost", () => api(`/api/admin/users/${u.id}/unban`, { method: "POST" })) : btn("Ban", "btn-danger", async () => { if (confirm(`Ban ${u.email}? Their listings come down.`)) await api(`/api/admin/users/${u.id}/ban`, { method: "POST" }); }))));
  }
}

async function loadJobs() {
  const jobs = await api("/api/admin/jobs");
  const tbody = $("jobs");
  tbody.replaceChildren();
  if (!jobs.length) tbody.append(el("tr", {}, el("td", { colspan: "3", class: "muted" }, "None. All good.")));
  for (const j of jobs) tbody.append(el("tr", {}, el("td", {}, j.type), el("td", { class: "err" }, j.lastError || ""), el("td", {}, btn("Retry", "btn-ghost", () => api(`/api/admin/jobs/${j.id}/retry`, { method: "POST" })))));
}

async function loadAudit() {
  const rows = await api("/api/admin/audit?limit=100");
  $("audit").replaceChildren(...rows.map((a) => el("tr", {}, el("td", { class: "small" }, when(a.createdAt)), el("td", { class: "small" }, a.actorEmail || "system"), el("td", { class: "small" }, a.action))));
}

async function refresh() {
  await Promise.all([loadOverview(), loadReview(), loadDeals(), loadReports(), loadUsers(), loadJobs(), loadAudit()]);
}

$("coldstart").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api("/api/admin/listings", {
      method: "POST",
      body: { sellerEmail: f.sellerEmail.value, sellerName: f.sellerName.value, permissionNote: f.permissionNote.value, type: f.type.value, title: f.title.value, summary: f.summary.value, description: f.description.value, techStack: f.techStack.value.split(",").map((s) => s.trim()).filter(Boolean), price: Number(f.price.value) },
    });
    say(`Published: /l/${r.slug}. The seller was emailed.`, true);
    f.reset();
    refresh();
  } catch (err) {
    say(err.message, false);
  }
});
$("deal-filter").addEventListener("change", loadDeals);
$("user-q").addEventListener("change", loadUsers);
$("logout").addEventListener("click", () => signOut());

initAuth({
  form: $("login-form"),
  googleBtn: $("google-btn"),
  hint: $("login-hint"),
  say: (t, ok) => message($("login-msg"), t, ok),
  onSignedIn: async () => {
    try {
      const me = await api("/api/me");
      $("who").textContent = me.email;
      if (!me.isAdmin) {
        show("login");
        message($("login-msg"), "This account is not an admin.", false);
        return;
      }
      show("app");
      await refresh();
    } catch (err) {
      message($("login-msg"), err.message, false);
    }
  },
  onSignedOut: () => show("login"),
});
