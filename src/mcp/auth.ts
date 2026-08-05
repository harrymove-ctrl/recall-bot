import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashDelegateKey } from "../keys/delegateKeys.js";

export interface DelegateUser {
  id: string;
  workspaceId: string;
  slackUserId: string;
}

export interface AuthedRequest extends Request {
  delegateUser?: DelegateUser;
}

export function requireDelegateKey(db: Database): RequestHandler {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer_token" });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      res.status(401).json({ error: "missing_bearer_token" });
      return;
    }

    const hash = hashDelegateKey(token);
    const [user] = await db.select().from(users).where(eq(users.delegateKeyHash, hash));
    if (!user) {
      res.status(401).json({ error: "invalid_delegate_key" });
      return;
    }

    req.delegateUser = { id: user.id, workspaceId: user.workspaceId, slackUserId: user.slackUserId };
    next();
  };
}
