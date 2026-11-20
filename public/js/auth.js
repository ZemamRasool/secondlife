// Shared login + API helper for the app and admin pages.
// Login uses Firebase (email link or Google). In dev mode it just uses the typed email.
const FIREBASE_VERSION = "11.10.0";

let getToken = async () => null;
let signOutFn = async () => {};
let onSignedOutCb = () => {};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, options = {}) {
  const token = await getToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    onSignedOutCb();
    throw new ApiError(401, data.error || "Please log in.");
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export async function signOut() {
  await signOutFn();
  onSignedOutCb();
}

/**
 * Sets up login. `form` is the email form, `googleBtn` the Google button, `say(text, ok)` shows messages.
 * Calls onSignedIn() once a user is logged in, and onSignedOut() when they are not.
 */
export async function initAuth({ form, googleBtn, hint, say = () => {}, onSignedIn = () => {}, onSignedOut = () => {} } = {}) {
  // Pages without a login form (e.g. a listing page) call initAuth() with nothing, just to know who is logged in.
  onSignedOutCb = onSignedOut;
  const cfg = await fetch("/api/config").then((r) => r.json());

  if (cfg.authMode === "dev") {
    if (hint) hint.textContent = "Dev mode: type any email to log in (no email is sent).";
    let email = null;
    try { email = localStorage.getItem("rr-dev-email"); } catch {}
    getToken = async () => (email ? `dev:${email}` : null);
    signOutFn = async () => {
      email = null;
      try { localStorage.removeItem("rr-dev-email"); } catch {}
    };
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      email = form.email.value.trim().toLowerCase();
      try { localStorage.setItem("rr-dev-email", email); } catch {}
      onSignedIn();
    });
    if (email) onSignedIn();
    else onSignedOut();
    return cfg;
  }

  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fa = await import(`${base}/firebase-auth.js`);
  const auth = fa.getAuth(initializeApp(cfg.firebase));
  getToken = async () => (auth.currentUser ? auth.currentUser.getIdToken() : null);
  signOutFn = () => fa.signOut(auth);

  // Coming back from the email sign-in link
  if (form && fa.isSignInWithEmailLink(auth, location.href)) {
    let email = null;
    try { email = localStorage.getItem("rr-email-for-signin"); } catch {}
    if (!email) email = window.prompt("Please confirm your email address");
    try {
      await fa.signInWithEmailLink(auth, email, location.href);
      try { localStorage.removeItem("rr-email-for-signin"); } catch {}
    } catch (err) {
      say(err.message, false);
    }
    history.replaceState(null, "", location.pathname);
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    try {
      await fa.sendSignInLinkToEmail(auth, email, { url: `${location.origin}${location.pathname}`, handleCodeInApp: true });
      try { localStorage.setItem("rr-email-for-signin", email); } catch {}
      say("Check your inbox for a sign-in link.", true);
    } catch (err) {
      say(err.message, false);
    }
  });
  if (googleBtn) {
    googleBtn.classList.remove("hidden");
    googleBtn.addEventListener("click", () => fa.signInWithPopup(auth, new fa.GoogleAuthProvider()).catch((err) => say(err.message, false)));
  }

  fa.onAuthStateChanged(auth, (user) => (user ? onSignedIn() : onSignedOut()));
  return cfg;
}

// ---- small DOM helpers (all text goes in with textContent, never innerHTML) ----
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

export function money(amount, currency) {
  if (amount === null || amount === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${currency || ""}`;
  }
}

export function totalsText(totals) {
  const parts = Object.entries(totals || {}).map(([cur, n]) => money(n, cur));
  return parts.length ? parts.join(" + ") : null;
}

export function message(container, text, ok) {
  container.replaceChildren();
  if (text) container.append(el("div", { class: `msg ${ok ? "ok" : "bad"}`, role: "status" }, text));
}
