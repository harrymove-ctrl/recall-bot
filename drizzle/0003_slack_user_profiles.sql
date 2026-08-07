CREATE TABLE "slack_user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" varchar(32) NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"resolved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_profiles_workspace_slack_user_unique" UNIQUE("workspace_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "slack_user_profiles" ADD CONSTRAINT "slack_user_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_user_profiles_workspace_id_idx" ON "slack_user_profiles" USING btree ("workspace_id");