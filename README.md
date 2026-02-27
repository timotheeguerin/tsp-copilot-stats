# Copilot PR Dashboard

Dashboard showing stats over time for PRs co-authored by GitHub Copilot in `microsoft/typespec` and `Azure/typespec-azure`.

## Metrics

- **Merged vs Abandoned ratio** — weekly stacked bar chart
- **Comments per PR** — average issue + review comments per week
- **Time to merge** — average hours from PR creation to merge per week
- **Per-area breakdown** — filterable by area labels from each repo's `area.ts`

## Setup

```bash
npm install
```

## Fetching Data

Requires a GitHub token with repo read access:

```bash
# Option 1: Use gh CLI (auto-detects token)
npm run fetch

# Option 2: Explicit token
GITHUB_TOKEN=ghp_xxx npm run fetch
```

This scans all closed PRs in both repos, checks commit messages for `Co-authored-by: Copilot` trailers, and writes `data/pr-stats.json`.

> **Note:** First run may take a while due to API rate limits (fetches commits for each PR). ~5000 requests/hour with authentication.

## Viewing the Dashboard

Serve locally (needed for fetch to work from the HTML):

```bash
npx serve .
```

Then open `http://localhost:3000/dashboard/` in your browser.

Alternatively, open `dashboard/index.html` directly and use the file picker to load `data/pr-stats.json`.

## Project Structure

```
├── src/
│   └── fetch-data.ts      # Data fetching script (TypeScript)
├── data/
│   └── pr-stats.json       # Generated data (git-ignored)
├── dashboard/
│   └── index.html           # Static dashboard with Chart.js
├── package.json
└── tsconfig.json
```
