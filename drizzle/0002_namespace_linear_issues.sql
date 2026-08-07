CREATE TABLE "namespace_linear_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"workspace_slug" varchar(64) NOT NULL,
	"issue_identifier" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "namespace_linear_issues_namespace_identifier_unique" UNIQUE("namespace_id","issue_identifier")
);
--> statement-breakpoint
ALTER TABLE "namespace_linear_issues" ADD CONSTRAINT "namespace_linear_issues_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "namespace_linear_issues_namespace_id_idx" ON "namespace_linear_issues" USING btree ("namespace_id");