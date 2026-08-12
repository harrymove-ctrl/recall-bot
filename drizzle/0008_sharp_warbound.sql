CREATE TABLE "message_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"slack_user_id" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_mentions_message_user_unique" UNIQUE("message_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_user_idx" ON "message_mentions" USING btree ("slack_user_id");--> statement-breakpoint
CREATE INDEX "message_mentions_message_idx" ON "message_mentions" USING btree ("message_id");