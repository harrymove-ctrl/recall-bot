import type { NextFunction, Request, RequestHandler, Response } from "express";
import { parseCookies, verifySessionCookie } from "./session.js";

export const DASHBOARD_COOKIE_NAME = "recall_dashboard_session";

export interface DashboardRequest extends Request {
  workspaceId?: string;
}

export function requireDashboardSession(secret: string): RequestHandler {
  return (req: DashboardRequest, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySessionCookie(cookies[DASHBOARD_COOKIE_NAME], secret);
    if (!session) {
      res.status(401).json({ error: "no_active_session" });
      return;
    }
    req.workspaceId = session.workspaceId;
    next();
  };
}
