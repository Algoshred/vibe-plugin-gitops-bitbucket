/**
 * BitbucketProvider — implements GitOpsProvider over Bitbucket Cloud REST v2.
 *
 * Auth: Basic with "username:app_password" — credentials concatenated and
 * sent as a Basic header. Stored as a single PAT string by convention.
 *
 * Storage namespace: `gitops-bitbucket`
 */

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";
import { BoundLogger } from "@vibecontrols/plugin-sdk";

import {
  GitOpsError,
  type AuthInput,
  type AuthValidation,
  type Branch,
  type Contributor,
  type Environment,
  type GitOpsProvider,
  type HealthSnapshot,
  type IssueSummary,
  type NormalisedRepo,
  type OrgRollup,
  type Pipeline,
  type PipelineAnalytics,
  type PipelineRun,
  type PullRequest,
  type PullRequestAnalytics,
  type RepoPage,
  type SecurityAlert,
  type Webhook,
} from "./types.js";

const STORAGE_NS = "gitops-bitbucket";
const KEY_PAT = "pat:default";
const API_BASE = "https://api.bitbucket.org/2.0";

/**
 * Resolve the REST API base. Defaults to Bitbucket Cloud, but honours an
 * explicit `meta.baseUrl` (or `meta.host`) so self-hosted Bitbucket Server /
 * Data Center — and deterministic E2E replay against a local mock — work
 * without code changes. The override is normalised (trailing slash trimmed).
 */
function resolveApiBase(meta?: Record<string, string>): string {
  const override = meta?.["baseUrl"] ?? meta?.["host"];
  return override ? override.replace(/\/$/, "") : API_BASE;
}

interface StoredAuth {
  kind: "pat" | "oauth" | "app";
  token: string;
  meta?: Record<string, string>;
  savedAt: string;
}

interface CacheEntry<T> {
  ts: number;
  ttlMs: number;
  value: T;
}

interface BbPaged<T> {
  values: T[];
  next?: string;
}

interface BbRepo {
  full_name: string;
  is_private: boolean;
  description?: string | null;
  mainbranch?: { name: string };
  language?: string;
  size?: number;
  links?: { html?: { href?: string }; clone?: Array<{ href: string }> };
  created_on: string;
  updated_on: string;
}

interface BbPr {
  id: number;
  title: string;
  state: string;
  draft?: boolean;
  author?: { display_name?: string; nickname?: string };
  reviewers?: Array<{ display_name?: string; nickname?: string }>;
  created_on: string;
  updated_on: string;
  closed_on?: string;
  links?: { html?: { href?: string } };
}

interface BbPipeline {
  uuid: string;
  build_number?: number;
  state?: { name: string; result?: { name: string } };
  target?: { ref_name?: string; commit?: { hash?: string } };
  created_on: string;
  completed_on?: string;
  duration_in_seconds?: number;
  creator?: { display_name?: string };
}

export class BitbucketProvider implements GitOpsProvider {
  readonly name = "bitbucket" as const;
  private readonly host: HostServices;
  private readonly log: BoundLogger;
  private token: string | null = null;
  private apiBase = API_BASE;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(host: HostServices) {
    this.host = host;
    this.log = new BoundLogger(host.logger, "gitops-bitbucket");
  }

  async init(): Promise<void> {
    const s = await this.loadAuth();
    if (s) {
      this.token = s.token;
      this.apiBase = resolveApiBase(s.meta);
      this.log.info("Loaded persisted Bitbucket app-password");
    }
  }

  private async loadAuth(): Promise<StoredAuth | null> {
    const raw = await this.host.storage?.get<string>(STORAGE_NS, KEY_PAT);
    if (!raw) return null;
    try {
      return typeof raw === "string"
        ? (JSON.parse(raw) as StoredAuth)
        : (raw as StoredAuth);
    } catch {
      return null;
    }
  }

  private headers(): Headers {
    const h = new Headers({
      "User-Agent": "vibecontrols-gitops-bitbucket/0.1",
      Accept: "application/json",
    });
    if (this.token) {
      // Token format: "username:app_password" — encode whole thing as Basic.
      h.set("Authorization", "Basic " + btoa(this.token));
    }
    return h;
  }

  private mapStatus(s: number, body: string): GitOpsError {
    if (s === 401) return new GitOpsError("AUTH", "Bitbucket: unauthorized");
    if (s === 403) return new GitOpsError("FORBIDDEN", "Bitbucket: forbidden");
    if (s === 404) return new GitOpsError("NOT_FOUND", "Bitbucket: not found");
    if (s === 429)
      return new GitOpsError("RATE_LIMITED", "Bitbucket: rate-limited");
    return new GitOpsError(
      "UPSTREAM",
      "Bitbucket: " + s + " " + body.slice(0, 200),
    );
  }

  private async rest<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.mapStatus(res.status, text);
    }
    return (await res.json()) as T;
  }

  private cached<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const e = this.cache.get(key) as CacheEntry<T> | undefined;
    if (e && Date.now() - e.ts < e.ttlMs) return Promise.resolve(e.value);
    return fn().then((v) => {
      this.cache.set(key, { ts: Date.now(), ttlMs, value: v });
      return v;
    });
  }

  private mapRepo(r: BbRepo): NormalisedRepo {
    return {
      fqn: r.full_name,
      provider: "bitbucket",
      visibility: r.is_private ? "private" : "public",
      defaultBranch: r.mainbranch?.name ?? "main",
      description: r.description ?? undefined,
      language: r.language,
      isArchived: false,
      isFork: false,
      size: r.size,
      url: r.links?.html?.href ?? "",
      createdAt: r.created_on,
      updatedAt: r.updated_on,
      pushedAt: r.updated_on,
    };
  }

  private mapPr(p: BbPr): PullRequest {
    const state =
      p.state === "MERGED"
        ? "merged"
        : p.state === "DECLINED" || p.state === "SUPERSEDED"
          ? "closed"
          : "open";
    return {
      id: String(p.id),
      number: p.id,
      title: p.title,
      state,
      isDraft: !!p.draft,
      author: p.author?.display_name ?? p.author?.nickname ?? "unknown",
      reviewers: (p.reviewers ?? []).map(
        (r) => r.display_name ?? r.nickname ?? "",
      ),
      createdAt: p.created_on,
      updatedAt: p.updated_on,
      mergedAt: state === "merged" ? p.closed_on : undefined,
      durationOpenSeconds: p.closed_on
        ? Math.floor(
            (Date.parse(p.closed_on) - Date.parse(p.created_on)) / 1000,
          )
        : undefined,
      url: p.links?.html?.href ?? "",
      labels: [],
    };
  }

  private mapPipeline(p: BbPipeline): PipelineRun {
    const state = p.state?.name ?? "";
    const result = p.state?.result?.name ?? "";
    return {
      id: p.uuid,
      pipelineName: `build-${p.build_number ?? p.uuid}`,
      branch: p.target?.ref_name ?? "",
      status:
        state === "IN_PROGRESS"
          ? "running"
          : state === "PENDING"
            ? "queued"
            : "completed",
      conclusion:
        result === "SUCCESSFUL"
          ? "success"
          : result === "FAILED"
            ? "failure"
            : result === "STOPPED"
              ? "cancelled"
              : undefined,
      startedAt: p.created_on,
      completedAt: p.completed_on,
      durationSeconds: p.duration_in_seconds,
      url: "",
      actor: p.creator?.display_name ?? "unknown",
      commitSha: p.target?.commit?.hash,
    };
  }

  // ── auth ────────────────────────────────────────────────────────────

  async saveCredentials(input: AuthInput): Promise<void> {
    const env: StoredAuth = {
      kind: input.kind,
      token: input.token,
      meta: input.meta,
      savedAt: new Date().toISOString(),
    };
    await this.host.storage?.set(STORAGE_NS, KEY_PAT, JSON.stringify(env));
    this.token = input.token;
    this.apiBase = resolveApiBase(input.meta);
    this.cache.clear();
  }

  async validateCredentials(): Promise<AuthValidation> {
    if (!this.token) {
      const s = await this.loadAuth();
      if (!s) return { ok: false, message: "No credentials stored" };
      this.token = s.token;
    }
    try {
      const u = await this.rest<{ username?: string; display_name?: string }>(
        "/user",
      );
      return {
        ok: true,
        account: u.username ?? u.display_name ?? "unknown",
        scopes: ["repository:read", "pullrequest:read", "pipeline:read"],
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rotateCredentials(input: AuthInput): Promise<AuthValidation> {
    await this.saveCredentials(input);
    return this.validateCredentials();
  }

  async revokeCredentials(): Promise<void> {
    await this.host.storage?.delete(STORAGE_NS, KEY_PAT);
    this.token = null;
    this.cache.clear();
  }

  async healthCheck(): Promise<HealthSnapshot> {
    try {
      await this.rest("/user");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── repos ───────────────────────────────────────────────────────────

  async listRepos(opts: {
    org?: string;
    limit?: number;
    cursor?: string;
  }): Promise<RepoPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
    const path =
      opts.cursor ??
      (opts.org
        ? `/repositories/${encodeURIComponent(opts.org)}?pagelen=${limit}&sort=-updated_on`
        : `/repositories?role=member&pagelen=${limit}&sort=-updated_on`);
    const data = await this.rest<BbPaged<BbRepo>>(path);
    return {
      items: data.values.map((r) => this.mapRepo(r)),
      nextCursor: data.next,
    };
  }

  async getRepo(fqn: string): Promise<NormalisedRepo> {
    return this.cached(`repo:${fqn}`, 60_000, async () => {
      const r = await this.rest<BbRepo>(`/repositories/${fqn}`);
      return this.mapRepo(r);
    });
  }

  async listBranches(fqn: string): Promise<Branch[]> {
    const data = await this.rest<
      BbPaged<{
        name: string;
        target: { hash: string };
        merge_strategies?: string[];
      }>
    >(`/repositories/${fqn}/refs/branches?pagelen=100`);
    return data.values.map((b) => ({
      name: b.name,
      isProtected: false, // Bitbucket has branch restrictions API but it's separate
      lastCommitSha: b.target.hash,
    }));
  }

  async listLanguages(fqn: string): Promise<Record<string, number>> {
    return this.cached(`langs:${fqn}`, 5 * 60_000, async () => {
      const r = await this.rest<BbRepo>(`/repositories/${fqn}`);
      return r.language ? { [r.language]: 1 } : {};
    });
  }

  async listContributors(
    fqn: string,
    opts?: { limit?: number },
  ): Promise<Contributor[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
    try {
      // Use commits as proxy — Bitbucket has no /contributors endpoint
      const data = await this.rest<
        BbPaged<{
          author?: { user?: { display_name?: string; nickname?: string } };
        }>
      >(`/repositories/${fqn}/commits?pagelen=${limit}`);
      const counts = new Map<string, number>();
      for (const c of data.values) {
        const login = c.author?.user?.display_name ?? c.author?.user?.nickname;
        if (!login) continue;
        counts.set(login, (counts.get(login) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([login, contributions]) => ({ login, contributions }));
    } catch {
      return [];
    }
  }

  // ── PRs ─────────────────────────────────────────────────────────────

  async listPullRequests(
    fqn: string,
    opts?: { state?: "open" | "closed" | "all"; limit?: number },
  ): Promise<PullRequest[]> {
    const stateMap: Record<string, string> = {
      open: "OPEN",
      closed: "MERGED,DECLINED",
      all: "OPEN,MERGED,DECLINED,SUPERSEDED",
    };
    const state = stateMap[opts?.state ?? "open"] ?? "OPEN";
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 50));
    const data = await this.rest<BbPaged<BbPr>>(
      `/repositories/${fqn}/pullrequests?state=${state}&pagelen=${limit}`,
    );
    return data.values.map((p) => this.mapPr(p));
  }

  async getPullRequest(fqn: string, id: number): Promise<PullRequest> {
    const p = await this.rest<BbPr>(`/repositories/${fqn}/pullrequests/${id}`);
    return this.mapPr(p);
  }

  async pullRequestAnalytics(fqn: string): Promise<PullRequestAnalytics> {
    const open = await this.listPullRequests(fqn, { state: "open", limit: 50 });
    const merged = await this.listPullRequests(fqn, {
      state: "closed",
      limit: 50,
    });
    const onlyMerged = merged.filter((m) => m.state === "merged");
    const sorted = [...onlyMerged]
      .filter((m) => typeof m.durationOpenSeconds === "number")
      .sort(
        (a, b) => (a.durationOpenSeconds ?? 0) - (b.durationOpenSeconds ?? 0),
      );
    const median = sorted.length
      ? (sorted[Math.floor(sorted.length / 2)]?.durationOpenSeconds ?? 0) / 3600
      : 0;
    return {
      slowest: sorted.slice(-5).reverse(),
      fastest: sorted.slice(0, 5),
      medianAgeHours: Math.round(median * 10) / 10,
      awaitingReview: open,
      awaitingApproval: [],
    };
  }

  // ── issues ──────────────────────────────────────────────────────────

  async listIssues(
    fqn: string,
    opts?: { state?: "open" | "closed"; limit?: number },
  ): Promise<IssueSummary[]> {
    try {
      const limit = Math.max(1, Math.min(opts?.limit ?? 30, 50));
      const data = await this.rest<
        BbPaged<{
          id: number;
          title: string;
          state: string;
          links?: { html?: { href?: string } };
          created_on: string;
        }>
      >(`/repositories/${fqn}/issues?pagelen=${limit}`);
      return data.values
        .filter((i) => {
          const s = opts?.state;
          if (!s) return true;
          if (s === "open")
            return i.state !== "closed" && i.state !== "resolved";
          return i.state === "closed" || i.state === "resolved";
        })
        .map((i) => ({
          id: String(i.id),
          number: i.id,
          title: i.title,
          state: i.state,
          labels: [],
          url: i.links?.html?.href ?? "",
          createdAt: i.created_on,
        }));
    } catch {
      return [];
    }
  }

  async labelStats(_fqn: string): Promise<Record<string, number>> {
    return {};
  }

  // ── CI ──────────────────────────────────────────────────────────────

  async listPipelines(_fqn: string): Promise<Pipeline[]> {
    // Bitbucket Pipelines doesn't have named workflows.
    return [{ id: "default", name: "Pipelines", state: "active" }];
  }

  async listRecentRuns(
    fqn: string,
    opts?: { limit?: number; branch?: string },
  ): Promise<PipelineRun[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const branchQs = opts?.branch
      ? `&target.branch=${encodeURIComponent(opts.branch)}`
      : "";
    const data = await this.rest<BbPaged<BbPipeline>>(
      `/repositories/${fqn}/pipelines?pagelen=${limit}&sort=-created_on${branchQs}`,
    );
    return data.values.map((p) => this.mapPipeline(p));
  }

  async getRun(fqn: string, runId: string): Promise<PipelineRun> {
    const p = await this.rest<BbPipeline>(
      `/repositories/${fqn}/pipelines/${runId}`,
    );
    return this.mapPipeline(p);
  }

  async pipelineAnalytics(fqn: string): Promise<PipelineAnalytics> {
    const runs = await this.listRecentRuns(fqn, { limit: 100 });
    const completed = runs.filter((r) => r.status === "completed");
    const succ = completed.filter((r) => r.conclusion === "success").length;
    const durations = completed
      .map((r) => r.durationSeconds ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const pct = (p: number) =>
      durations.length === 0
        ? 0
        : (durations[
            Math.min(durations.length - 1, Math.floor(durations.length * p))
          ] ?? 0);
    return {
      successRate: completed.length ? succ / completed.length : 0,
      durationP50: pct(0.5),
      durationP95: pct(0.95),
      slowest: [...completed]
        .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0))
        .slice(0, 5),
      fastest: [...completed]
        .filter((r) => (r.durationSeconds ?? 0) > 0)
        .sort((a, b) => (a.durationSeconds ?? 0) - (b.durationSeconds ?? 0))
        .slice(0, 5),
      running: runs.filter((r) => r.status === "running"),
      queued: runs.filter((r) => r.status === "queued"),
      pendingApproval: runs.filter((r) => r.status === "waiting"),
      totalRunsLast30Days: runs.length,
    };
  }

  async listEnvironments(fqn: string): Promise<Environment[]> {
    try {
      const data = await this.rest<
        BbPaged<{
          uuid: string;
          name: string;
          category?: { name?: string };
          type?: string;
        }>
      >(`/repositories/${fqn}/environments`);
      return data.values.map((e) => ({
        name: e.name,
        state: e.type ?? "active",
      }));
    } catch {
      return [];
    }
  }

  async listSecurityAlerts(
    _fqn: string,
    _opts?: { kind?: SecurityAlert["type"] },
  ): Promise<SecurityAlert[]> {
    // Bitbucket Cloud has limited native security alerting. Return empty
    // until we wire up the Snyk / Atlassian Marketplace integrations.
    return [];
  }

  async orgRollup(org: string): Promise<OrgRollup> {
    return this.cached(`rollup:${org}`, 5 * 60_000, async () => {
      const first = await this.listRepos({ org, limit: 100 });
      const items = [...first.items];
      let cursor = first.nextCursor;
      let pages = 1;
      while (cursor && pages < 5) {
        const next = await this.listRepos({ cursor });
        items.push(...next.items);
        cursor = next.nextCursor;
        pages++;
      }
      const byVis = { public: 0, private: 0, internal: 0 } as Record<
        "public" | "private" | "internal",
        number
      >;
      const byLang: Record<string, number> = {};
      const now = Date.now();
      let stale30d = 0;
      for (const r of items) {
        byVis[r.visibility] += 1;
        if (r.language) byLang[r.language] = (byLang[r.language] ?? 0) + 1;
        const pushed = Date.parse(r.pushedAt ?? r.updatedAt);
        if (now - pushed > 30 * 24 * 3600 * 1000) stale30d++;
      }
      return {
        totalRepos: items.length,
        byVisibility: byVis,
        byLanguage: byLang,
        archived: 0,
        stale30d,
        totalOpenPRs: 0,
        totalOpenIssues: 0,
      };
    });
  }

  async listWebhooks(fqn: string): Promise<Webhook[]> {
    try {
      const data = await this.rest<
        BbPaged<{
          uuid: string;
          url: string;
          events: string[];
          active: boolean;
        }>
      >(`/repositories/${fqn}/hooks`);
      return data.values.map((h) => ({
        id: h.uuid,
        url: h.url,
        events: h.events,
        active: h.active,
      }));
    } catch {
      return [];
    }
  }
}
