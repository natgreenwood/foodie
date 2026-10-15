CREATE TYPE "public"."measurement_type" AS ENUM('mass', 'volume', 'count');--> statement-breakpoint
CREATE TABLE "measurement" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "measurement_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" "measurement_type" NOT NULL,
	"factor_to_base" numeric,
	"is_system" boolean DEFAULT false NOT NULL,
	CONSTRAINT "measurement_factor_to_base_positive" CHECK ("measurement"."factor_to_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "measurement_name" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "measurement_name_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"measurement_id" bigint NOT NULL,
	"name" text NOT NULL,
	"normalised_name" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("measurement_name"."name", '\s+', ' ', 'g')))) STORED NOT NULL,
	"abbreviation" text,
	"normalised_abbreviation" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("measurement_name"."abbreviation", '\s+', ' ', 'g')))) STORED,
	"locale" text NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	CONSTRAINT "measurement_name_name_not_blank" CHECK ("measurement_name"."normalised_name" <> ''),
	CONSTRAINT "measurement_name_abbreviation_not_blank" CHECK ("measurement_name"."normalised_abbreviation" <> '')
);
--> statement-breakpoint
ALTER TABLE "measurement_name" ADD CONSTRAINT "measurement_name_measurement_id_measurement_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public"."measurement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_name_locale_name_key" ON "measurement_name" USING btree ("locale","normalised_name");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_name_locale_abbreviation_key" ON "measurement_name" USING btree ("locale","normalised_abbreviation");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_name_canonical_key" ON "measurement_name" USING btree ("measurement_id","locale") WHERE "measurement_name"."is_canonical";--> statement-breakpoint
CREATE INDEX "measurement_name_measurement_id_idx" ON "measurement_name" USING btree ("measurement_id");