CREATE TABLE "recipe" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"source_url" text,
	"servings" integer,
	"prep_minutes" integer,
	"cook_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_title_not_blank" CHECK (lower(btrim(regexp_replace("recipe"."title", '\s+', ' ', 'g'))) <> ''),
	CONSTRAINT "recipe_servings_positive" CHECK ("recipe"."servings" > 0),
	CONSTRAINT "recipe_prep_minutes_not_negative" CHECK ("recipe"."prep_minutes" >= 0),
	CONSTRAINT "recipe_cook_minutes_not_negative" CHECK ("recipe"."cook_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredient" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_ingredient_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipe_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"ingredient_id" bigint NOT NULL,
	"measurement_id" bigint,
	"quantity" numeric,
	"prep_notes" text,
	"notes" text,
	CONSTRAINT "recipe_ingredient_quantity_positive" CHECK ("recipe_ingredient"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_step" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_step_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipe_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "recipe_step_text_not_blank" CHECK (lower(btrim(regexp_replace("recipe_step"."text", '\s+', ' ', 'g'))) <> '')
);
--> statement-breakpoint
CREATE TABLE "recipe_tag" (
	"recipe_id" bigint NOT NULL,
	"tag" text NOT NULL,
	"normalised_tag" text GENERATED ALWAYS AS (lower(btrim(regexp_replace("recipe_tag"."tag", '\s+', ' ', 'g')))) STORED NOT NULL,
	CONSTRAINT "recipe_tag_recipe_id_normalised_tag_pk" PRIMARY KEY("recipe_id","normalised_tag"),
	CONSTRAINT "recipe_tag_tag_not_blank" CHECK ("recipe_tag"."normalised_tag" <> '')
);
--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_measurement_id_measurement_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public"."measurement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step" ADD CONSTRAINT "recipe_step_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_tag" ADD CONSTRAINT "recipe_tag_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_ingredient_recipe_position_key" ON "recipe_ingredient" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_ingredient_id_idx" ON "recipe_ingredient" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_measurement_id_idx" ON "recipe_ingredient" USING btree ("measurement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_step_recipe_position_key" ON "recipe_step" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "recipe_tag_normalised_tag_idx" ON "recipe_tag" USING btree ("normalised_tag");