/**
 * Resolves the workspace row for a Slack team id.
 *
 * Every Slack entrypoint (app_mention events, message events, slash commands) needs this
 * exact lookup to turn Slack's `team_id` into our internal workspace id. It lives here, as a
 * dependency-free db query, so the three call sites cannot drift apart and so it is directly
 * unit-testable without standing up a Bolt app.
 */
export async function resolveWorkspaceByTeamId(db, teamId) {
    return db.query.workspaces.findFirst({
        where: (w, { eq }) => eq(w.slackTeamId, teamId),
        columns: { id: true },
    });
}
//# sourceMappingURL=workspaces.js.map