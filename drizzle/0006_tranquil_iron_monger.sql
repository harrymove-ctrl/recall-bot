ALTER TABLE "messages" ADD COLUMN "walrus_blob_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "walrus_storage_status" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "walrus_stored_at" timestamp with time zone;