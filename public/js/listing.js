// Public listing page: details, proof of ownership, health report, make an offer, report.
import { api, ApiError, el, initAuth, message } from "./auth.js";
import { date, priceText, TYPE_LABEL, verifiedBadge } from "./ui.js";

const slug = decodeURIComponent(location.pathname.split("/").pop());
const page = document.getElementById("page");
await initAuth();


function proofList(l) {
  if (!l.proofs.length) return el("p", { class: "muted small" }, "The seller hasn't added a repository or domain yet.");
  return el(
    "div",
    { class: "stack" },
    l.proofs.map((p) =>
      el(
        "div",
        { class: "row" },
        el("span", { class: `badge ${p.verified ? "verified" : "unverified"}` }, p.verified ? "✓ Proven" : "Not proven"),
        el("span", { class: "strong" }, p.kind === "repo" ? `GitHub: ${p.reference}` : `Domain: ${p.reference}`),
        p.facts ? el("span", { class: "muted small" }, `${p.facts.commits} commits · ★ ${p.facts.stars} · last commit ${date(p.facts.lastCommitAt)}${p.facts.private ? " · private repo" : ""}`) : "",
      ),
    ),
  );
}

function healthCard(h) {
  if (!h) return "";
  const r = h.report;
  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Project health report"), el("div", { class: "score", title: "out of 100" }, String(h.score))),
    el("p", {}, h.summary),
    el("ul", { class: "checks" }, r.checks.map((c) => el("li", { class: c.ok ? "" : "no" }, el("span", { class: "strong" }, c.label), el("span", { class: "muted" }, ` — ${c.detail}`)))),
    r.metrics.outdated.length ? el("p", { class: "small muted" }, `Packages a major version behind: ${r.metrics.outdated.map((o) => `${o.name} (${o.wanted} → ${o.latest})`).join(", ")}`) : "",
    el("p", { class: "small muted" }, `Languages: ${r.metrics.languages.map((x) => `${x.name} ${x.share}%`).join(", ")} · ${r.metrics.files} files · checked ${date(h.createdAt)}`),
  );
}

function offerBox(l) {
  const box = el("div", { class: "card sticky" });
  box.append(el("div", { class: "price" }, priceText(l)), el("p", { class: "muted small" }, "Asking price. You can offer less."));
  if (l.status !== "published") {
    box.append(el("p", { class: "msg ok" }, l.status === "sold" ? "This project has been sold." : "This project is under offer."));
    return box;
  }
  const out = el("div");
  const amount = el("input", { type: "number", min: "1", step: "1", value: String(l.price), "aria-label": "Your offer in USD" });
  const note = el("textarea", { rows: "4", placeholder: "Say who you are and what you'd do with it. Ask anything." });
  const send = el("button", { class: "btn btn-primary full", type: "button" }, "Make an offer");
  send.addEventListener("click", async () => {
    send.disabled = true;
    try {
      await api(`/api/listings/${l.id}/offers`, { method: "POST", body: { amount: Number(amount.value), message: note.value || undefined } });
      message(out, "Offer sent. The seller has been emailed; follow the conversation under My account → Offers.", true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) location.href = "/app";
      message(out, err.message, false);
    } finally {
      send.disabled = false;
    }
  });
  box.append(el("div", { class: "stack" }, amount, note, send, out));
  box.append(el("p", { class: "muted small" }, "Your money is held by a licensed escrow company until you confirm the handover. Never pay a seller directly."));
  return box;
}

function reportLink(l) {
  const a = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Report this listing");
  a.addEventListener("click", async () => {
    const reason = prompt("What's wrong? (stolen code, scam, misleading…)");
    if (!reason) return;
    try {
      await api(`/api/listings/${l.id}/report`, { method: "POST", body: { reason } });
      alert("Thanks. Our team will review it.");
    } catch (err) {
      alert(err.status === 401 ? "Please log in to report a listing." : err.message);
    }
  });
  return a;
}

try {
  const res = await fetch(`/api/listings/${encodeURIComponent(slug)}`);
  const l = await res.json();
  if (!res.ok) throw new Error(l.error || "Not found");
  document.title = `${l.title} — SecondLife`;
  const facts = el("dl", { class: "kv" }, el("dt", {}, "Type"), el("dd", {}, TYPE_LABEL[l.type]), el("dt", {}, "Listed"), el("dd", {}, date(l.publishedAt)));
  if (l.monthlyVisitors) facts.append(el("dt", {}, "Monthly visitors"), el("dd", {}, l.monthlyVisitors.toLocaleString()));
  if (l.traction) facts.append(el("dt", {}, "Traction"), el("dd", {}, l.traction));
  page.replaceChildren(
    el(
      "div",
      { class: "detail" },
      el(
        "div",
        { class: "stack" },
        el("div", { class: "row" }, el("span", { class: "badge type" }, TYPE_LABEL[l.type]), verifiedBadge(l.verified)),
        el("h1", {}, l.title),
        el("p", { class: "lead muted" }, l.summary),
        el("div", { class: "tags" }, l.techStack.map((t) => el("a", { class: "tag", href: `/?tech=${encodeURIComponent(t)}` }, t))),
        l.screenshots.length ? el("div", { class: "shots" }, l.screenshots.map((s) => el("a", { href: s, target: "_blank" }, el("img", { src: s, alt: "Screenshot", loading: "lazy" })))) : "",
        el("div", { class: "card" }, el("h2", {}, "About this project"), el("div", { class: "prose-text" }, l.description)),
        l.whatsMissing ? el("div", { class: "card" }, el("h2", {}, "What's missing"), el("div", { class: "prose-text" }, l.whatsMissing)) : "",
        el("div", { class: "card" }, el("h2", {}, "Proof of ownership"), proofList(l)),
        healthCard(l.healthReport),
      ),
      el(
        "div",
        { class: "stack" },
        offerBox(l),
        el("div", { class: "card" }, el("h2", {}, "Seller"), el("p", {}, el("a", { href: `/u/${l.seller.id}` }, l.seller.name), l.seller.github ? el("span", { class: "muted small" }, ` · GitHub: ${l.seller.github}`) : ""), el("p", { class: "muted small" }, `Member since ${date(l.seller.memberSince)}`)),
        el("div", { class: "card" }, facts),
        reportLink(l),
      ),
    ),
  );
} catch (err) {
  page.replaceChildren(el("div", { class: "card empty" }, el("h2", {}, "Listing not found"), el("p", { class: "muted" }, "It may have been sold or removed."), el("a", { class: "btn btn-primary", href: "/" }, "Browse projects")));
}
