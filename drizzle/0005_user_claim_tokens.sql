CREATE TABLE "user_claim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" varchar(32) NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_claim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "user_claim_tokens" ADD CONSTRAINT "user_claim_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_claim_tokens_workspace_id_idx" ON "user_claim_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "user_claim_tokens_workspace_slack_user_idx" ON "user_claim_tokens" USING btree ("workspace_id","slack_user_id");