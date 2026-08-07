import type { NextFunction, Request, RequestHandler, Response } from "express";
import { parseCookies } from "./session.js";
import { verifyUserSessionCookie } from "./userSession.js";

export const USER_SESSION_COOKIE_NAME = "recall_user_session";

export interface UserSessionRequest extends Request {
  workspaceId?: string;
  slackUserId?: string;
}

export function requireUserSession(secret: string): RequestHandler {
  return (req: UserSessionRequest, res: Response, next: NextFunction) => {
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
