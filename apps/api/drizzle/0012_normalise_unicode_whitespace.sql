-- The normalised columns are generated, and Postgres cannot change a
-- generated expression in place, so drizzle-kit drops and re-adds them.
-- Dropping a column also drops every index and constraint on it, which
-- drizzle-kit does not put back; they are recreated by hand at the end, as
-- 0000, 0002 and 0003 created them. If existing rows now normalise to the
-- same value, recreating a unique index fails and, since the migrations run
-- in one transaction, nothing is applied.
ALTER TABLE "recipe" DROP CONSTRAINT "recipe_title_not_blank";--> statement-breakpoint
ALTER TABLE "recipe_step" DROP CONSTRAINT "recipe_step_text_not_blank";--> statement-breakpoint
ALTER TABLE "ingredient_name" drop column "normalised_name";--> statement-breakpoint
ALTER TABLE "ingredient_name" ADD COLUMN "normalised_name" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("ingredient_name"."name", '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "measurement_name" drop column "normalised_name";--> statement-breakpoint
ALTER TABLE "measurement_name" ADD COLUMN "normalised_name" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("measurement_name"."name", '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "measurement_name" drop column "normalised_abbreviation";--> statement-breakpoint
ALTER TABLE "measurement_name" ADD COLUMN "normalised_abbreviation" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("measurement_name"."abbreviation", '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')))) STORED;--> statement-breakpoint
ALTER TABLE "recipe_tag" drop column "normalised_tag";--> statement-breakpoint
ALTER TABLE "recipe_tag" ADD COLUMN "normalised_tag" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("recipe_tag"."tag", '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_title_not_blank" CHECK (lower(btrim(regexp_replace("recipe"."title", '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'))) <> '');--> statement-breakpoint
ALTER TABLE "recipe_step" ADD CONSTRAINT "recipe_step_text_not_blank" CHECK (lower(btrim(regexp_replace("recipe_step"."text", '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'))) <> '');--> statement-breakpoint
-- Added by hand: what dropping the columns above dropped.
CREATE UNIQUE INDEX "ingredient_name_locale_name_key" ON "ingredient_name" USING btree ("locale","normalised_name");--> statement-breakpoint
CREATE INDEX "ingredient_name_normalised_name_trgm_idx" ON "ingredient_name" USING gin ("normalised_name" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "ingredient_name" ADD CONSTRAINT "ingredient_name_name_not_blank" CHECK ("ingredient_name"."normalised_name" <> '');--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_name_locale_name_key" ON "measurement_name" USING btree ("locale","normalised_name");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_name_locale_abbreviation_key" ON "measurement_name" USING btree ("locale","normalised_abbreviation");--> statement-breakpoint
ALTER TABLE "measurement_name" ADD CONSTRAINT "measurement_name_name_not_blank" CHECK ("measurement_name"."normalised_name" <> '');--> statement-breakpoint
ALTER TABLE "measurement_name" ADD CONSTRAINT "measurement_name_abbreviation_not_blank" CHECK ("measurement_name"."normalised_abbreviation" <> '');--> statement-breakpoint
ALTER TABLE "recipe_tag" ADD CONSTRAINT "recipe_tag_recipe_id_normalised_tag_pk" PRIMARY KEY("recipe_id","normalised_tag");--> statement-breakpoint
CREATE INDEX "recipe_tag_normalised_tag_idx" ON "recipe_tag" USING btree ("normalised_tag");--> statement-breakpoint
ALTER TABLE "recipe_tag" ADD CONSTRAINT "recipe_tag_tag_not_blank" CHECK ("recipe_tag"."normalised_tag" <> '');
