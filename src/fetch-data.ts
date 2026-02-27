import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

const REPOS = [
  { owner: "microsoft", repo: "typespec" },
  { owner: "Azure", repo: "typespec-azure" },
] as const;

const COPILOT_AUTHOR = "@copilot";

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 5000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      const status = err?.status ?? err?.response?.status;
      // Search rate limit (403) — wait for reset
      if (status === 403 && err?.response?.headers?.["x-ratelimit-remaining"] === "0") {
        const resetAt = parseInt(err.response.headers["x-ratelimit-reset"] ?? "0") * 1000;
        const waitMs = Math.max(1000, resetAt - Date.now() + 1000);
        console.log(`    Search rate limit hit, waiting ${Math.ceil(waitMs / 1000)}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (status && status >= 400 && status < 500 && status !== 403) throw err;
      console.log(`    Retrying after error (attempt ${i + 2}/${retries})...`);
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

interface PRData {
  number: number;
  title: string;
  author: string;
  state: "merged" | "abandoned";
  areas: string[];
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  timeToMergeDays: number | null;
  commentCount: number;
  reviewCommentCount: number;
  abandonReason?: string;
  supersededBy?: { number: number; title: string; author: string } | null;
}

interface AbandonReasonSummary {
  reason: string;
  count: number;
  percentage: number;
  description: string;
}

interface RepoData {
  prs: PRData[];
  abandonReasons: AbandonReasonSummary[];
}

interface OutputData {
  generatedAt: string;
  repos: Record<string, RepoData>;
}

function getToken(): string {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  try {
    return execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    console.error("No GITHUB_TOKEN env var and `gh auth token` failed. Please authenticate.");
    process.exit(1);
  }
}

function extractAreaLabels(labels: { name: string }[]): string[] {
  const areaPrefixes = [
    "compiler:", "emitter", "lib:", "meta:", "ide", "eng",
    "tspd", "spector", "ui:", "openapi3:", "cli/psh",
  ];
  return labels
    .map((l) => l.name)
    .filter((name) => areaPrefixes.some((p) => name.startsWith(p)));
}

// Use GitHub search to find PRs authored by @copilot
async function findCopilotPRNumbers(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Set<number>> {
  const prNumbers = new Set<number>();

  console.log(`  Searching for PRs authored by ${COPILOT_AUTHOR}...`);

  // Search closed PRs authored by copilot
  for (const stateFilter of ["is:merged", "is:unmerged"]) {
    let page = 1;
    while (true) {
      const { data } = await withRetry(() => octokit.request("GET /search/issues", {
        q: `is:pr state:closed author:${COPILOT_AUTHOR} ${stateFilter} repo:${owner}/${repo}`,
        per_page: 100,
        page,
      }));

      if (data.items.length === 0) break;

      for (const item of data.items) {
        prNumbers.add(item.number);
      }

      console.log(`  Search ${stateFilter} page ${page}: ${data.items.length} PRs (total: ${data.total_count})`);

      if (page * 100 >= Math.min(data.total_count, 1000)) break;
      page++;
    }
  }

  console.log(`  Found ${prNumbers.size} Copilot-authored PRs.`);
  return prNumbers;
}

async function fetchRepoPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<PRData[]> {
  console.log(`\nProcessing ${owner}/${repo}...`);

  // Step 1: Find PR numbers via commit search (fast)
  const copilotPRNumbers = await findCopilotPRNumbers(octokit, owner, repo);

  // Step 2: Fetch details for those PRs (parallel, 10 at a time)
  const results: PRData[] = [];
  const prList = [...copilotPRNumbers];
  const CONCURRENCY = 10;
  console.log(`  Fetching details for ${prList.length} PRs (concurrency: ${CONCURRENCY})...`);

  let completed = 0;
  for (let i = 0; i < prList.length; i += CONCURRENCY) {
    const batch = prList.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (prNumber) => {
        const { data: pr } = await withRetry(() => octokit.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        }));

        if (pr.state !== "closed") return null;

        const state: "merged" | "abandoned" = pr.merged_at ? "merged" : "abandoned";
        const areas = extractAreaLabels(pr.labels as { name: string }[]);

        let timeToMergeDays: number | null = null;
        if (pr.merged_at) {
          const created = new Date(pr.created_at).getTime();
          const merged = new Date(pr.merged_at).getTime();
          timeToMergeDays = Math.round(((merged - created) / (1000 * 60 * 60 * 24)) * 10) / 10;
        }

        return {
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? "unknown",
          state,
          areas,
          createdAt: pr.created_at,
          closedAt: pr.closed_at,
          mergedAt: pr.merged_at,
          timeToMergeDays,
          commentCount: pr.comments ?? 0,
          reviewCommentCount: pr.review_comments ?? 0,
        } satisfies PRData;
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }
    completed += batch.length;
    console.log(`    Fetched ${completed}/${prList.length} PRs`);
  }

  // Sort by creation date
  results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  console.log(`  Total: ${results.length} closed Copilot PRs (${results.filter((p) => p.state === "merged").length} merged, ${results.filter((p) => p.state === "abandoned").length} abandoned)`);
  return results;
}

function classifyAbandonReason(
  pr: PRData,
  comments: string[],
  lastReviewState: string,
): string {
  // Filter out stale bot comments to find the real signal
  const realComments = comments.filter(
    (c) => !c.includes("no update for 60 days") && !c.includes("no update for 30 days") && !c.includes("marked as a stale PR"),
  );
  const lc = (realComments.length > 0 ? realComments[realComments.length - 1] : "").toLowerCase();
  const allComments = comments.join("\n").toLowerCase();
  const title = pr.title.toLowerCase();

  // Superseded — explicit mention in comments
  if (/replaced by|moved to|closing in favo|handled in|instead|new pr|target release branch|favour of #|favor of #/.test(allComments)) return "superseded";
  // WIP loop
  if (title.startsWith("[wip]") || title.startsWith("wip")) return "wip_stuck";
  // Review feedback copilot couldn't address
  if (lastReviewState === "CHANGES_REQUESTED") return "failed_review_feedback";
  if (pr.reviewCommentCount > 5) return "failed_review_feedback";
  // Agent errors
  if (allComments.includes("unable to handle") || allComments.includes("copilot is unable")) return "agent_unable";
  if (allComments.includes("unexpected error")) return "agent_error";
  // Firewall/permissions — not a root cause, look deeper
  // (removed: "blocked by firewall" is a transient issue, not the reason for abandonment)
  // Dep upgrades
  if (/upgrade dep|update dep|bump|update node|update packages/.test(title)) return "failed_dep_upgrade";
  // Not needed
  if (/not a bug|close for now|not needed|nvm|no this should|close this/.test(lc)) return "not_needed";
  // Merge conflicts
  if (lc.includes("conflict")) return "merge_conflicts";
  // Silently closed
  if (pr.commentCount === 0 && pr.reviewCommentCount === 0) return "silently_closed";
  return "other";
}

const REASON_DESCRIPTIONS: Record<string, string> = {
  silently_closed: "Silently closed with no comments or reviews",
  failed_review_feedback: "Failed to address review feedback",
  wip_stuck: "Agent stuck in WIP loop (repeated attempts)",
  duplicate_retry: "Duplicate retry attempts (same task)",
  superseded_by_copilot: "Superseded by another Copilot PR",
  superseded_by_human: "Superseded by a human PR",
  superseded: "Superseded by another PR (unknown author)",
  failed_dep_upgrade: "Failed dependency upgrade",
  not_needed: "Scope mismatch / not actually needed",
  agent_unable: "Agent explicitly unable to complete",
  agent_error: "Agent crashed with unexpected error",
  merge_conflicts: "Unresolved merge conflicts",
  other: "Other / unclear reason",
};

function extractPRReferences(text: string): number[] {
  const refs = new Set<number>();
  for (const m of text.matchAll(/#(\d{3,})/g)) refs.add(parseInt(m[1]));
  for (const m of text.matchAll(/\/pull\/(\d+)/g)) refs.add(parseInt(m[1]));
  return [...refs];
}

async function classifyAbandonedPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
  prs: PRData[],
): Promise<AbandonReasonSummary[]> {
  const abandoned = prs.filter((p) => p.state === "abandoned");
  if (abandoned.length === 0) return [];

  console.log(`  Classifying ${abandoned.length} abandoned PRs...`);

  const CONCURRENCY = 10;
  let completed = 0;

  for (let i = 0; i < abandoned.length; i += CONCURRENCY) {
    const batch = abandoned.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (pr) => {
        let allCommentBodies: string[] = [];
        let lastReviewState = "";
        try {
          const { data: comments } = await withRetry(() => octokit.issues.listComments({
            owner, repo, issue_number: pr.number, per_page: 100,
          }));
          allCommentBodies = comments.map((c) => c.body ?? "");
        } catch { /* ignore */ }

        try {
          const { data: reviews } = await withRetry(() => octokit.pulls.listReviews({
            owner, repo, pull_number: pr.number, per_page: 100,
          }));
          const actionReviews = reviews.filter((r) => r.state !== "COMMENTED" && r.state !== "PENDING");
          if (actionReviews.length > 0) {
            lastReviewState = actionReviews[actionReviews.length - 1].state ?? "";
          }
        } catch { /* ignore */ }

        pr.abandonReason = classifyAbandonReason(pr, allCommentBodies, lastReviewState);

        // Check for superseding PR via references in comments
        if (pr.abandonReason === "superseded" || pr.abandonReason === "other" || pr.abandonReason === "silently_closed") {
          const allText = allCommentBodies.join("\n");
          const referencedPRs = extractPRReferences(allText).filter((n) => n !== pr.number);

          for (const refNum of referencedPRs) {
            try {
              const { data: refPR } = await withRetry(() => octokit.pulls.get({
                owner, repo, pull_number: refNum,
              }));
              if (refPR.merged_at) {
                pr.supersededBy = {
                  number: refPR.number,
                  title: refPR.title,
                  author: refPR.user?.login ?? "unknown",
                };
                pr.abandonReason = "superseded";
                break;
              }
            } catch { /* ignore — ref may not be a PR */ }
          }
        }
      }),
    );
    completed += batch.length;
    console.log(`    Classified ${completed}/${abandoned.length}`);
  }

  // Check for duplicate titles (retry pattern)
  const titleCounts = new Map<string, number>();
  for (const pr of abandoned) {
    const norm = pr.title.toLowerCase().replace(/\[(wip|python|copilot|http-client-\w+)\]\s*/g, "").trim();
    titleCounts.set(norm, (titleCounts.get(norm) ?? 0) + 1);
  }
  for (const pr of abandoned) {
    const norm = pr.title.toLowerCase().replace(/\[(wip|python|copilot|http-client-\w+)\]\s*/g, "").trim();
    if ((titleCounts.get(norm) ?? 0) > 1 && pr.abandonReason !== "wip_stuck") {
      pr.abandonReason = "duplicate_retry";
    }
  }

  // Search for superseding merged PRs by title similarity for remaining unclassified
  const needsSupersededCheck = abandoned.filter(
    (p) => !p.supersededBy && (p.abandonReason === "other" || p.abandonReason === "silently_closed" || p.abandonReason === "superseded"),
  );
  if (needsSupersededCheck.length > 0) {
    console.log(`  Searching for superseding PRs for ${needsSupersededCheck.length} unclassified PRs...`);
    let checked = 0;
    // Use concurrency of 2 to avoid hitting search rate limit (30/min)
    for (let i = 0; i < needsSupersededCheck.length; i += 2) {
      const batch = needsSupersededCheck.slice(i, i + 2);
      await Promise.allSettled(
        batch.map(async (pr) => {
          const keywords = pr.title
            .replace(/\[.*?\]/g, "")
            .replace(/[^a-zA-Z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .slice(0, 4)
            .join(" ");
          if (!keywords) return;

          try {
            const { data } = await withRetry(() => octokit.request("GET /search/issues", {
              q: `is:pr is:merged repo:${owner}/${repo} ${keywords}`,
              per_page: 5,
            }));
            const prCreated = new Date(pr.createdAt).getTime();
            for (const item of data.items) {
              if (item.number === pr.number) continue;
              const itemCreated = new Date(item.created_at).getTime();
              if (Math.abs(itemCreated - prCreated) < 60 * 24 * 60 * 60 * 1000) {
                pr.supersededBy = {
                  number: item.number,
                  title: item.title,
                  author: (item.user as any)?.login ?? "unknown",
                };
                pr.abandonReason = "superseded";
                break;
              }
            }
          } catch { /* ignore search errors */ }
        }),
      );
      checked += batch.length;
      console.log(`    Checked ${checked}/${needsSupersededCheck.length}`);
    }
  }

  // Split "superseded" into copilot vs human based on supersededBy author
  for (const pr of abandoned) {
    if (pr.abandonReason === "superseded" && pr.supersededBy) {
      const author = pr.supersededBy.author.toLowerCase();
      pr.abandonReason = (author === "copilot" || author === "copilot[bot]")
        ? "superseded_by_copilot"
        : "superseded_by_human";
    }
  }

  // Summarize
  const counts = new Map<string, number>();
  for (const pr of abandoned) {
    const reason = pr.abandonReason ?? "other";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  const total = abandoned.length;
  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({
      reason,
      count,
      percentage: Math.round((count / total) * 100),
      description: REASON_DESCRIPTIONS[reason] ?? reason,
    }));
}

async function main() {
  const token = getToken();
  const octokit = new Octokit({ auth: token });

  const { data: rateLimit } = await octokit.rateLimit.get();
  console.log(
    `GitHub API rate limit: ${rateLimit.rate.remaining}/${rateLimit.rate.limit} (resets at ${new Date(rateLimit.rate.reset * 1000).toISOString()})`,
  );

  const output: OutputData = {
    generatedAt: new Date().toISOString(),
    repos: {},
  };

  for (const { owner, repo } of REPOS) {
    const prs = await fetchRepoPRs(octokit, owner, repo);
    const abandonReasons = await classifyAbandonedPRs(octokit, owner, repo, prs);
    output.repos[`${owner}/${repo}`] = { prs, abandonReasons };
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outputPath = join(DATA_DIR, "pr-stats.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nData written to ${outputPath}`);

  for (const [repoName, repoData] of Object.entries(output.repos)) {
    const merged = repoData.prs.filter((p) => p.state === "merged").length;
    const abandoned = repoData.prs.filter((p) => p.state === "abandoned").length;
    console.log(`${repoName}: ${repoData.prs.length} Copilot PRs (${merged} merged, ${abandoned} abandoned)`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
