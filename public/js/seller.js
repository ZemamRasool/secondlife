// Public seller profile.
import { el } from "./auth.js";
import { date, listingCard } from "./ui.js";

const id = decodeURIComponent(location.pathname.split("/").pop());
const page = document.getElementById("page");
const res = await fetch(`/api/sellers/${encodeURIComponent(id)}`);
const s = await res.json();
if (!res.ok) {
  page.replaceChildren(el("div", { class: "card empty" }, el("h2", {}, "Seller not found")));
} else {
  document.title = `${s.name} — SecondLife`;
  page.replaceChildren(
    el(
      "div",
      { class: "card" },
      el("h1", {}, s.name),
      s.bio ? el("p", { class: "prose-text" }, s.bio) : "",
      el("p", { class: "muted small" }, `Member since ${date(s.memberSince)} · ${s.sold} sold`, s.github ? ` · GitHub: ${s.github}` : "", s.website ? " · " : "", s.website ? el("a", { href: s.website, rel: "nofollow noopener", target: "_blank" }, "website") : ""),
    ),
    el("h3", { class: "group-title" }, "For sale"),
    s.listings.length ? el("div", { class: "grid" }, s.listings.map(listingCard)) : el("p", { class: "muted" }, "Nothing for sale right now."),
  );
}
