-- Added by hand: drizzle-kit does not emit CREATE EXTENSION. pg_trgm backs the
-- trigram index on ingredient_name.normalised_name for fuzzy name search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "ingredient" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingredient_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category" text,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "ingredient_name" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingredient_name_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ingredient_id" bigint NOT NULL,
	"name" text NOT NULL,
	"normalised_name" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("ingredient_name"."name", '\s+', ' ', 'g')))) STORED NOT NULL,
	"locale" text NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"source" text,
	CONSTRAINT "ingredient_name_name_not_blank" CHECK ("ingredient_name"."normalised_name" <> '')
);
--> statement-breakpoint
ALTER TABLE "ingredient_name" ADD CONSTRAINT "ingredient_name_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_name_locale_name_key" ON "ingredient_name" USING btree ("locale","normalised_name");--> statement-breakpoint
CREATE INDEX "ingredient_name_normalised_name_trgm_idx" ON "ingredient_name" USING gin ("normalised_name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_name_canonical_key" ON "ingredient_name" USING btree ("ingredient_id","locale") WHERE "ingredient_name"."is_canonical";--> statement-breakpoint
CREATE INDEX "ingredient_name_ingredient_id_idx" ON "ingredient_name" USING btree ("ingredient_id");