CREATE TABLE "recall_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"delegate_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_events_namespace_id_idx" ON "recall_events" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "recall_events_namespace_id_created_at_idx" ON "recall_events" USING btree ("namespace_id","created_at");