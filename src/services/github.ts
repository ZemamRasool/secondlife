// GitHub: proves a seller owns a repo, and reads the facts the health report needs.
// We only READ. The seller's token is encrypted in the database and can be removed any time.
//
// Scope: "read:user" lets us check public repos. GitHub OAuth apps have no read-only scope
// for private repos, so a seller with a private repo can choose "repo" scope; we still only read.

export interface RepoInfo {
  fullName: string;
  ownerLogin: string;
  isAdmin: boolean;
  private: boolean;
  description: string | null;
  stars: number;
  forks: number;
  sizeKb: number;
  defaultBranch: string;
  pushedAt: string | null;
  createdAt: string | null;
  license: string | null;
}

export interface GitHubApi {
  authorizeUrl(state: string, redirectUri: string, privateRepos: boolean): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ token: string; scope: string } | null>;
  getLogin(token: string): Promise<string | null>;
  getRepo(token: string, fullName: string): Promise<RepoInfo | null>;
  getLanguages(token: string, fullName: string): Promise<Record<string, number>>;
  getCommitStats(token: string, fullName: string): Promise<{ count: number; lastCommitAt: string | null }>;
  getTree(token: string, fullName: string, branch: string): Promise<string[]>;
  getFile(token: string, fullName: string, path: string): Promise<string | null>;
}

export function createGitHubApi(clientId: string, clientSecret: string): GitHubApi {
  const api = async (token: string, path: string, accept = "application/vnd.github+json") => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SecondLife" },
    });
    return res;
  };

  return {
    authorizeUrl(state, redirectUri, privateRepos) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: privateRepos ? "read:user repo" : "read:user",
        state,
        allow_signup: "false",
      });
      return `https://github.com/login/oauth/authorize?${params}`;
    },

    async exchangeCode(code, redirectUri) {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      });
      const data = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string };
      return data.access_token ? { token: data.access_token, scope: data.scope ?? "" } : null;
    },

    async getLogin(token) {
      const res = await api(token, "/user");
      if (!res.ok) return null;
      return ((await res.json()) as { login?: string }).login ?? null;
    },

    async getRepo(token, fullName) {
      const res = await api(token, `/repos/${fullName}`);
      if (!res.ok) return null;
      const r = (await res.json()) as Record<string, any>;
      return {
        fullName: r.full_name,
        ownerLogin: r.owner?.login,
        isAdmin: Boolean(r.permissions?.admin),
        private: Boolean(r.private),
        description: r.description ?? null,
        stars: r.stargazers_count ?? 0,
        forks: r.forks_count ?? 0,
        sizeKb: r.size ?? 0,
        defaultBranch: r.default_branch ?? "main",
        pushedAt: r.pushed_at ?? null,
        createdAt: r.created_at ?? null,
        license: r.license?.spdx_id ?? null,
      };
    },

    async getLanguages(token, fullName) {
      const res = await api(token, `/repos/${fullName}/languages`);
      return res.ok ? ((await res.json()) as Record<string, number>) : {};
    },

    async getCommitStats(token, fullName) {
      // One commit per page: the "last" page number in the Link header = total commits.
      const res = await api(token, `/repos/${fullName}/commits?per_page=1`);
      if (!res.ok) return { count: 0, lastCommitAt: null };
      const list = (await res.json()) as { commit?: { committer?: { date?: string } } }[];
      const link = res.headers.get("link") ?? "";
      const last = /[?&]page=(\d+)>; rel="last"/.exec(link);
      return { count: last ? Number(last[1]) : list.length, lastCommitAt: list[0]?.commit?.committer?.date ?? null };
    },

    async getTree(token, fullName, branch) {
      const res = await api(token, `/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (!res.ok) return [];
      const data = (await res.json()) as { tree?: { path: string; type: string }[] };
      return (data.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path).slice(0, 20_000);
    },

    async getFile(token, fullName, path) {
      const res = await api(token, `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.github.raw+json");
      if (!res.ok) return null;
      const text = await res.text();
      return text.slice(0, 200_000);
    },
  };
}
