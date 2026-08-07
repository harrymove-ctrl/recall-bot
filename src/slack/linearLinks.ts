import type { Database } from "../db/client.js";
import { namespaceLinearIssues } from "../db/schema.js";

// Matches `linear.app/<slug>/issue/<KEY>-<digits>` anywhere in the text, unanchored — this
// handles Slack's own <url> and <url|label> bracket markup, and plain unwrapped URLs, without
// needing to strip Slack's <...|...> syntax first. Deliberately does NOT match non-issue
// linear.app URLs (e.g. linear.app/mysten-labs/settings) since those lack the /issue/<KEY>-<n>
// segment.
//
// The leading (?<!...) lookbehind requires "linear.app" not be directly preceded by an
// alnum/hyphen character, so a mid-string substring like "notlinear.app" or "fake-linear.app"
// never matches. The slug group is bounded to 64 chars (matching the workspaceSlug column's
// varchar(64)) rather than unbounded `*`, so a long run of slug-like characters with no valid
// /issue/<KEY>-<n> segment can't cause backtracking proportional to input length.
const LINEAR_ISSUE_URL_RE =
  /(?<![a-zA-Z0-9-])linear\.app\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)\/issue\/([a-zA-Z][a-zA-Z0-9]{1,9}-\d+)/g;

export interface LinearIssueRef {
  workspaceSlug: string;
  issueIdentifier: string; // normalized uppercase, e.g. "WALM-297"
}

/**
 * Pure extraction, deduped within the call. Dedup key is issueIdentifier alone (matching the
 * namespace_linear_issues unique constraint, which is (namespaceId, issueIdentifier) without
 * workspaceSlug) — first-seen workspaceSlug for a given identifier wins.
 */
export function extractLinearIssueRefs(text: string): LinearIssueRef[] {
  const refs = new Map<string, LinearIssueRef>();
  for (const match of text.matchAll(LINEAR_ISSUE_URL_RE)) {
    const [, workspaceSlug, rawIdentifier] = match;
    const issueIdentifier = rawIdentifier.toUpperCase();
    if (!refs.has(issueIdentifier)) {
      refs.set(issueIdentifier, { workspaceSlug, issueIdentifier });
    }
  }
  return [...refs.values()];
}

export function linearIssueUrl(ref: LinearIssueRef): string {
  return `https://linear.app/${ref.workspaceSlug}/issue/${ref.issueIdentifier}`;
}

/**
 * Best-effort: each ref is inserted independently, and a failure on one must never block the
 * others or bubble up to the caller (capture must never fail because of link detection). Mirrors
 * captureSlackFile's per-item defensive posture in ./files.ts.
 */
export async function recordLinearIssueLinks(params: {
  db: Database;
  namespaceId: string;
  text: string;
}): Promise<void> {
  const { db, namespaceId, text } = params;
  const refs = extractLinearIssueRefs(text);

  for (const ref of refs) {
    try {
      await db
        .insert(namespaceLinearIssues)
        .values({ namespaceId, workspaceSlug: ref.workspaceSlug, issueIdentifier: ref.issueIdentifier })
        .onConflictDoNothing({
          target: [namespaceLinearIssues.namespaceId, namespaceLinearIssues.issueIdentifier],
        });
    } catch (error) {
      console.error(
        `recordLinearIssueLinks: failed to record ${ref.issueIdentifier} for namespace ${namespaceId}:`,
        error,
      );
    }
  }
}
