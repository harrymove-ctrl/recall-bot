const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
/**
 * IDs referenced by Slack's `<@U123>` (or `<@U123|label>`) user-mention syntax within a
 * message's raw text — not to be confused with the message's own author id. Both dashboard
 * message-list routes (src/dashboard/api.ts, src/dashboard/meApi.ts) resolve these alongside
 * author ids so the mrkdwn renderer can show a real name instead of a raw user id.
 */
export function extractMentionedUserIds(text) {
    return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))];
}
//# sourceMappingURL=mentions.js.map