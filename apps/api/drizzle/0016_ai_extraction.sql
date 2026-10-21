CREATE TABLE "ai_extraction" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_extraction_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_url" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"page_text" text NOT NULL,
	"raw_output" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_outcome_known" CHECK ("ai_extraction"."outcome" IN ('accepted', 'ungrounded', 'no_recipe', 'unreadable'))
);
