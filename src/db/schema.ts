import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const namespaceStatusEnum = pgEnum("namespace_status", ["active", "archived"]);
export const fileStatusEnum = pgEnum("file_status", ["pending", "stored", "failed"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slackTeamId: varchar("slack_team_id", { length: 32 }).notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const installations = pgTable("installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" })
    .unique(),
  botToken: text("bot_token").notNull(),
  botUserId: varchar("bot_user_id", { length: 32 }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceClaimTokens = pgTable(
  "workspace_claim_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_claim_tokens_workspace_id_idx").on(t.workspaceId)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    delegateKeyHash: text("delegate_key_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("users_workspace_slack_user_unique").on(t.workspaceId, t.slackUserId),
    index("users_delegate_key_hash_idx").on(t.delegateKeyHash),
  ],
);

export const namespaces = pgTable(
  "namespaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    threadTs: varchar("thread_ts", { length: 32 }).notNull(),
    label: text("label"),
    status: namespaceStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("namespaces_workspace_channel_thread_unique").on(t.workspaceId, t.channelId, t.threadTs),
    index("namespaces_workspace_id_idx").on(t.workspaceId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    text: text("text").notNull(),
    slackTs: varchar("slack_ts", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("messages_namespace_slack_ts_unique").on(t.namespaceId, t.slackTs),
    index("messages_namespace_id_idx").on(t.namespaceId),
    index("messages_slack_user_id_idx").on(t.slackUserId),
  ],
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    bucketKey: text("bucket_key"),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    status: fileStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_message_id_idx").on(t.messageId)],
);

export const namespaceLinearIssues = pgTable(
  "namespace_linear_issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    workspaceSlug: varchar("workspace_slug", { length: 64 }).notNull(),
    issueIdentifier: varchar("issue_identifier", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("namespace_linear_issues_namespace_identifier_unique").on(t.namespaceId, t.issueIdentifier),
    index("namespace_linear_issues_namespace_id_idx").on(t.namespaceId),
  ],
);

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  installation: one(installations, {
    fields: [workspaces.id],
    references: [installations.workspaceId],
  }),
  users: many(users),
  namespaces: many(namespaces),
}));

export const installationsRelations = relations(installations, ({ one }) => ({
  workspace: one(workspaces, { fields: [installations.workspaceId], references: [workspaces.id] }),
}));

export const usersRelations = relations(users, ({ one }) => ({
  workspace: one(workspaces, { fields: [users.workspaceId], references: [workspaces.id] }),
}));

export const namespacesRelations = relations(namespaces, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [namespaces.workspaceId], references: [workspaces.id] }),
  messages: many(messages),
  linearIssues: many(namespaceLinearIssues),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  namespace: one(namespaces, { fields: [messages.namespaceId], references: [namespaces.id] }),
  files: many(files),
}));

export const filesRelations = relations(files, ({ one }) => ({
  message: one(messages, { fields: [files.messageId], references: [messages.id] }),
}));

export const namespaceLinearIssuesRelations = relations(namespaceLinearIssues, ({ one }) => ({
  namespace: one(namespaces, { fields: [namespaceLinearIssues.namespaceId], references: [namespaces.id] }),
}));
