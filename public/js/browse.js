// Home page: search, filters and results. Filters live in the URL so searches can be shared.
import { el } from "./auth.js";
import { listingCard } from "./ui.js";

const $ = (id) => document.getElementById(id);
const form = $("search");
const fields = { type: $("f-type"), tech: $("f-tech"), min: $("f-min"), max: $("f-max"), sort: $("f-sort") };

function readUrl() {
  const p = new URLSearchParams(location.search);
  form.q.value = p.get("q") || "";
  for (const [k, input] of Object.entries(fields)) input.value = p.get(k) || "";
  $("f-verified").checked = p.get("verified") === "1";
  return Number(p.get("page") || 1);
}

function params(page = 1) {
  const p = new URLSearchParams();
  if (form.q.value.trim()) p.set("q", form.q.value.trim());
  for (const [k, input] of Object.entries(fields)) if (input.value) p.set(k, input.value);
  if ($("f-verified").checked) p.set("verified", "1");
  if (page > 1) p.set("page", String(page));
  return p;
}

async function run(page = 1, push = true) {
  const p = params(page);
  if (push) history.replaceState(null, "", p.toString() ? `/?${p}` : "/");
  const res = await fetch(`/api/listings?${p}`);
  const data = await res.json();
  const out = $("results");
  out.replaceChildren();
  if (!res.ok) {
    out.append(el("p", { class: "msg bad" }, data.error || "Search failed."));
    return;
  }
  $("count").textContent = `${data.total} project${data.total === 1 ? "" : "s"} for sale`;
  if (!data.results.length) out.append(el("div", { class: "card empty" }, el("h2", {}, "Nothing matches yet"), el("p", { class: "muted" }, "Try fewer filters, or check back soon: new projects are listed every week.")));
  for (const l of data.results) out.append(listingCard(l));
  const pages = Math.ceil(data.total / data.pageSize);
  const pager = $("pager");
  pager.replaceChildren();
  if (pages > 1) {
    if (page > 1) pager.append(el("button", { class: "btn btn-ghost", onclick: () => run(page - 1) }, "← Previous"));
    pager.append(el("span", { class: "muted" }, `Page ${page} of ${pages}`));
    if (page < pages) pager.append(el("button", { class: "btn btn-ghost", onclick: () => run(page + 1) }, "Next →"));
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(1);
});
for (const input of [...Object.values(fields), $("f-verified")]) input.addEventListener("change", () => run(1));

const tags = await fetch("/api/tags").then((r) => r.json()).catch(() => []);
for (const t of tags) fields.tech.append(el("option", { value: t.tag }, `${t.tag} (${t.count})`));
const page = readUrl();
run(page, false);
