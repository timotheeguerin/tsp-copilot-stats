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

const COPILOT_COAUTHOR_SEARCH = "Co-authored-by: Copilot";

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 5000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      const status = err?.status ?? err?.response?.status;
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
}

interface RepoData {
  prs: PRData[];
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

// Use GitHub commit search to find Copilot co-authored commits, then map to PRs
async function findCopilotPRNumbers(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Set<number>> {
  const prNumbers = new Set<number>();
  let page = 1;

  console.log(`  Searching for Copilot co-authored commits (merged)...`);

  // Search commits with the co-author trailer (only finds commits on default branch = merged PRs)
  while (true) {
    const { data } = await withRetry(() => octokit.rest.search.commits({
      q: `"${COPILOT_COAUTHOR_SEARCH}" repo:${owner}/${repo}`,
      per_page: 100,
      page,
    }));

    if (data.items.length === 0) break;

    console.log(`  Search page ${page}: ${data.items.length} commits (total: ${data.total_count})`);

    for (const item of data.items) {
      try {
        const { data: associatedPRs } = await octokit.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: item.sha,
          per_page: 10,
        });
        for (const pr of associatedPRs) {
          prNumbers.add(pr.number);
        }
      } catch {
        // skip if we can't get associated PRs
      }
    }

    // GitHub search API caps at 1000 results
    if (page * 100 >= Math.min(data.total_count, 1000)) break;
    page++;
  }

  console.log(`  Found ${prNumbers.size} merged PRs via commit search.`);

  // Also search closed-unmerged PRs for Copilot co-authorship
  console.log(`  Scanning closed-unmerged PRs for Copilot co-authorship...`);
  let unmPage = 1;
  let unmTotal = 0;
  let unmCopilot = 0;

  while (true) {
    const { data: closedPRs } = await withRetry(() => octokit.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page: unmPage,
    }));

    if (closedPRs.length === 0) break;

    // Filter to only unmerged PRs
    const unmergedPRs = closedPRs.filter((pr) => !pr.merged_at);
    unmTotal += unmergedPRs.length;

    for (const pr of unmergedPRs) {
      if (prNumbers.has(pr.number)) continue;
      try {
        const { data: commits } = await octokit.pulls.listCommits({
          owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });
        const hasCopilot = commits.some((c) =>
          c.commit.message.includes(COPILOT_COAUTHOR_SEARCH),
        );
        if (hasCopilot) {
          prNumbers.add(pr.number);
          unmCopilot++;
        }
      } catch {
        // skip
      }
    }

    console.log(`  Scanned page ${unmPage} (${unmTotal} unmerged PRs, ${unmCopilot} Copilot)`);
    unmPage++;
  }

  console.log(`  Total: ${prNumbers.size} unique Copilot PRs (${unmCopilot} abandoned).`);
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

  // Step 2: Fetch details for just those PRs
  const results: PRData[] = [];
  console.log(`  Fetching details for ${copilotPRNumbers.size} PRs...`);

  for (const prNumber of copilotPRNumbers) {
    try {
      const { data: pr } = await withRetry(() => octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      }));

      // Only include closed PRs
      if (pr.state !== "closed") continue;

      const state: "merged" | "abandoned" = pr.merged_at ? "merged" : "abandoned";
      const areas = extractAreaLabels(pr.labels as { name: string }[]);

      let timeToMergeDays: number | null = null;
      if (pr.merged_at) {
        const created = new Date(pr.created_at).getTime();
        const merged = new Date(pr.merged_at).getTime();
        timeToMergeDays = Math.round(((merged - created) / (1000 * 60 * 60 * 24)) * 10) / 10;
      }

      results.push({
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
      });

      console.log(`    ✓ PR #${pr.number} (${state}, areas: [${areas.join(", ")}])`);
    } catch {
      console.log(`    ✗ PR #${prNumber} — failed to fetch`);
    }
  }

  // Sort by creation date
  results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  console.log(`  Total: ${results.length} closed Copilot PRs (${results.filter((p) => p.state === "merged").length} merged, ${results.filter((p) => p.state === "abandoned").length} abandoned)`);
  return results;
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
    output.repos[`${owner}/${repo}`] = { prs };
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
