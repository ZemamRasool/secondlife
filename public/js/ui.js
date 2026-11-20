// Shared bits for SecondLife pages: listing cards and small formatters.
import { el, money } from "./auth.js";

export const TYPE_LABEL = { codebase: "Codebase", domain: "Domain", website: "Website" };

export function priceText(l) {
  return money(l.price, l.currency);
}

export function verifiedBadge(verified) {
  return el("span", { class: `badge ${verified ? "verified" : "unverified"}`, title: verified ? "Ownership proven through GitHub or DNS" : "Ownership not proven yet" }, verified ? "✓ Verified" : "Not verified");
}

export function listingCard(l) {
  const thumb = el("div", { class: "thumb" });
  if (l.screenshots && l.screenshots[0]) thumb.append(el("img", { src: l.screenshots[0], alt: "", loading: "lazy" }));
  else thumb.append(TYPE_LABEL[l.type] || l.type);
  return el(
    "a",
    { class: "card lcard", href: `/l/${l.slug}` },
    thumb,
    el("div", { class: "row" }, el("span", { class: "badge type" }, TYPE_LABEL[l.type]), verifiedBadge(l.verified), l.healthReport ? el("span", { class: "badge type", title: "Project health score" }, `Health ${l.healthReport.score}`) : ""),
    el("h3", {}, l.title),
    el("p", {}, l.summary),
    el("div", { class: "tags" }, (l.techStack || []).slice(0, 5).map((t) => el("span", { class: "tag" }, t))),
    el("div", { class: "meta" }, el("span", { class: "price" }, priceText(l)), el("span", { class: "muted small" }, l.seller.name)),
  );
}

export function date(d) {
  return d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
}
