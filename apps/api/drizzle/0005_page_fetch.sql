CREATE TABLE "page_fetch" (
	"normalised_url" text PRIMARY KEY NOT NULL,
	"final_url" text NOT NULL,
	"status" integer NOT NULL,
	"strategy" text NOT NULL,
	"html" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
