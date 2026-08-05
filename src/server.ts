import express from "express";
import type { Express } from "express";

export function buildApp(): Express {
  const app = express();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`recall-bot listening on port ${port}`);
  });
}
