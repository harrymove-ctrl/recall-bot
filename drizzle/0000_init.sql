CREATE TYPE "public"."file_status" AS ENUM('pending', 'stored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."namespace_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"bucket_key" text,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_token" text NOT NULL,
	"bot_user_id" varchar(32) NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"slack_user_id" varchar(32) NOT NULL,
	"text" text NOT NULL,
	"slack_ts" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_namespace_slack_ts_unique" UNIQUE("namespace_id","slack_ts")
);
--> statement-breakpoint
CREATE TABLE "namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" varchar(32) NOT NULL,
	"thread_ts" varchar(32) NOT NULL,
	"status" "namespace_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "namespaces_workspace_channel_thread_unique" UNIQUE("workspace_id","channel_id","thread_ts")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" varchar(32) NOT NULL,
	"delegate_key_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_workspace_slack_user_unique" UNIQUE("workspace_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_team_id" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slack_team_id_unique" UNIQUE("slack_team_id")
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_message_id_idx" ON "files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_namespace_id_idx" ON "messages" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "messages_slack_user_id_idx" ON "messages" USING btree ("slack_user_id");--> statement-breakpoint
CREATE INDEX "namespaces_workspace_id_idx" ON "namespaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "users_delegate_key_hash_idx" ON "users" USING btree ("delegate_key_hash");