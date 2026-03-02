import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";

const REPOS = [
  { owner: "microsoft", repo: "typespec" },
  { owner: "Azure", repo: "typespec-azure" },
] as const;

const COPILOT_AUTHOR = "@copilot";

/**
 * Area path mappings from each repo's area.ts / labels.ts config.
 * Keys are area label names, values are arrays of path prefixes.
 */
const AREA_PATHS: Record<string, Record<string, string[]>> = {
  "microsoft/typespec": {
    "compiler:core": ["packages/compiler/"],
    "emitter-framework": ["packages/emitter-framework/"],
    ide: ["packages/typespec-vscode/", "packages/typespec-vs/"],
    "lib:http": ["packages/http/"],
    "lib:openapi": ["packages/openapi/"],
    "lib:rest": ["packages/rest/"],
    "lib:versioning": ["packages/versioning/"],
    "lib:http-specs": ["packages/http-specs/"],
    "meta:blog": ["blog/"],
    "meta:website": ["website/"],
    tspd: ["packages/tspd/"],
    "emitter:client:js": ["packages/http-client-js/"],
    "emitter:client:csharp": ["packages/http-client-csharp/"],
    "emitter:client:java": ["packages/http-client-java/"],
    "emitter:client:python": ["packages/http-client-python/"],
    "emitter:graphql": ["packages/graphql/"],
    "emitter:json-schema": ["packages/json-schema/"],
    "emitter:protobuf": ["packages/protobuf/"],
    "emitter:openapi3": ["packages/openapi3/"],
    "openapi3:converter": ["packages/openapi3/src/cli/actions/convert/"],
    "emitter:service:csharp": ["packages/http-server-csharp/"],
    "emitter:service:js": ["packages/http-server-js/"],
    eng: ["eng/", ".github/"],
    "ui:playground": ["packages/playground/"],
    "ui:type-graph-viewer": ["packages/html-program-viewer/"],
    spector: ["packages/spector/", "packages/http-specs/"],
  },
  "Azure/typespec-azure": {
    eng: ["eng/", ".github/"],
    "lib:azure-core": ["packages/typespec-azure-core/"],
    "lib:azure-resource-manager": ["packages/typespec-azure-resource-manager/"],
    "emitter:autorest": ["packages/typespec-autorest/"],
    "lib:tcgc": ["packages/typespec-client-generator-core/"],
    "lib:azure-http-specs": ["packages/azure-http-specs/"],
    "meta:website": ["website/"],
  },
};

/** All known area label prefixes used to identify area labels on a PR */
const AREA_LABEL_PREFIXES = [
  "compiler:",
  "emitter",
  "lib:",
  "meta:",
  "ide",
  "eng",
  "tspd",
  "spector",
  "ui:",
  "openapi3:",
  "cli/psh",
];

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

function hasAreaLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => AREA_LABEL_PREFIXES.some((p) => l.name.startsWith(p)));
}

function matchAreaLabels(files: string[], areaPaths: Record<string, string[]>): string[] {
  const matched = new Set<string>();

  // Sort area entries by path length descending so more specific paths match first
  const entries = Object.entries(areaPaths)
    .flatMap(([label, paths]) => paths.map((p) => ({ label, path: p })))
    .sort((a, b) => b.path.length - a.path.length);

  for (const file of files) {
    for (const { label, path } of entries) {
      if (file.startsWith(path)) {
        matched.add(label);
      }
    }
  }

  return [...matched];
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 5000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      const status = err?.status ?? err?.response?.status;
      if (status === 403 && err?.response?.headers?.["x-ratelimit-remaining"] === "0") {
        const resetAt = parseInt(err.response.headers["x-ratelimit-reset"] ?? "0") * 1000;
        const waitMs = Math.max(1000, resetAt - Date.now() + 1000);
        console.log(`  Rate limit hit, waiting ${Math.ceil(waitMs / 1000)}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (status && status >= 400 && status < 500 && status !== 403) throw err;
      console.log(`  Retrying after error (attempt ${i + 2}/${retries})...`);
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

async function findCopilotPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ number: number; labels: { name: string }[] }[]> {
  const prs: { number: number; labels: { name: string }[] }[] = [];

  for (const stateFilter of ["is:open", "is:merged", "is:unmerged"]) {
    let page = 1;
    while (true) {
      const { data } = await withRetry(() =>
        octokit.request("GET /search/issues", {
          q: `is:pr author:${COPILOT_AUTHOR} ${stateFilter} repo:${owner}/${repo}`,
          per_page: 100,
          page,
        }),
      );

      if (data.items.length === 0) break;

      for (const item of data.items) {
        prs.push({
          number: item.number,
          labels: (item.labels as { name?: string }[])
            .filter((l): l is { name: string } => typeof l.name === "string"),
        });
      }

      console.log(`  Search ${stateFilter} page ${page}: ${data.items.length} results (total: ${data.total_count})`);

      if (page * 100 >= Math.min(data.total_count, 1000)) break;
      page++;
    }
  }

  return prs;
}

async function getPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const files: string[] = [];
  let page = 1;
  while (true) {
    const { data } = await withRetry(() =>
      octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100, page }),
    );
    if (data.length === 0) break;
    files.push(...data.map((f) => f.filename));
    if (data.length < 100) break;
    page++;
  }
  return files;
}

async function main() {
  const applyMode = process.argv.includes("--apply");

  if (applyMode) {
    console.log("🔧 APPLY mode — labels will be added to PRs\n");
  } else {
    console.log("🔍 DRY RUN mode — no labels will be changed (use --apply to apply)\n");
  }

  const token = getToken();
  const octokit = new Octokit({ auth: token });

  const { data: rateLimit } = await octokit.rateLimit.get();
  console.log(
    `GitHub API rate limit: ${rateLimit.rate.remaining}/${rateLimit.rate.limit} (resets at ${new Date(rateLimit.rate.reset * 1000).toISOString()})`,
  );

  let totalLabeled = 0;
  let totalSkipped = 0;

  for (const { owner, repo } of REPOS) {
    const repoKey = `${owner}/${repo}`;
    const areaPaths = AREA_PATHS[repoKey];
    if (!areaPaths) {
      console.log(`\n⚠️  No area paths configured for ${repoKey}, skipping`);
      continue;
    }

    console.log(`\n📦 Processing ${repoKey}...`);

    // Find all copilot PRs
    const allPRs = await findCopilotPRs(octokit, owner, repo);
    console.log(`  Found ${allPRs.length} copilot PRs total`);

    // Filter to PRs missing area labels
    const prsWithoutArea = allPRs.filter((pr) => !hasAreaLabel(pr.labels));
    console.log(`  ${prsWithoutArea.length} PRs missing area labels`);

    if (prsWithoutArea.length === 0) continue;

    // Process each PR
    const CONCURRENCY = 5;
    for (let i = 0; i < prsWithoutArea.length; i += CONCURRENCY) {
      const batch = prsWithoutArea.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (pr) => {
          const files = await getPRFiles(octokit, owner, repo, pr.number);
          const labels = matchAreaLabels(files, areaPaths);

          const prUrl = `https://github.com/${owner}/${repo}/pull/${pr.number}`;

          if (labels.length === 0) {
            console.log(`  #${pr.number}: no matching area for ${files.length} changed files (${prUrl})`);
            totalSkipped++;
            return;
          }

          if (applyMode) {
            await withRetry(() =>
              octokit.issues.addLabels({ owner, repo, issue_number: pr.number, labels }),
            );
            console.log(`  #${pr.number}: ✅ applied [${labels.join(", ")}] (${prUrl})`);
          } else {
            console.log(`  #${pr.number}: would apply [${labels.join(", ")}] (${prUrl})`);
          }
          totalLabeled++;
        }),
      );
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`  ${totalLabeled} PRs ${applyMode ? "labeled" : "would be labeled"}`);
  console.log(`  ${totalSkipped} PRs skipped (no matching area)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
