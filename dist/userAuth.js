import { parseCookies } from "./session.js";
import { verifyUserSessionCookie } from "./userSession.js";
export const USER_SESSION_COOKIE_NAME = "recall_user_session";
export function requireUserSession(secret) {
    return (req, res, next) => {
        const cookies = parseCookies(req.headers.cookie);
        const session = verifyUserSessionCookie(cookies[USER_SESSION_COOKIE_NAME], secret);
        if (!session) {
            res.status(401).json({ error: "no_active_session" });
            return;
        }
        req.workspaceId = session.workspaceId;
        req.slackUserId = session.slackUserId;
        next();
    };
}
//# sourceMappingURL=userAuth.js.map