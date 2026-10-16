ALTER TABLE "measurement" ADD COLUMN "key" text;--> statement-breakpoint
-- Stores the keys 0001_seed_measurement_units.sql gave the 25 system units,
-- finding each by the canonical en-GB name that seed gave it (unique per
-- locale, so one row per name). A system unit whose en-GB name was edited
-- since is left with a null key; user-created units are never matched.
UPDATE "measurement" SET "key" = "unit"."key"
FROM "measurement_name", (
	VALUES
		('gram', 'gram'),
		('kilogram', 'kilogram'),
		('ounce', 'ounce'),
		('pound', 'pound'),
		('millilitre', 'millilitre'),
		('litre', 'litre'),
		('teaspoon', 'teaspoon'),
		('tablespoon', 'tablespoon'),
		('cup_us', 'US cup'),
		('cup_metric', 'cup'),
		('fl_oz_us', 'US fluid ounce'),
		('fl_oz_imperial', 'fluid ounce'),
		('pint_us', 'US pint'),
		('pint_imperial', 'pint'),
		('quart_us', 'US quart'),
		('each', 'each'),
		('clove', 'clove'),
		('pinch', 'pinch'),
		('dash', 'dash'),
		('slice', 'slice'),
		('can', 'tin'),
		('bunch', 'bunch'),
		('sprig', 'sprig'),
		('handful', 'handful'),
		('packet', 'packet')
) AS "unit" ("key", "gb_name")
WHERE "measurement_name"."measurement_id" = "measurement"."id"
	AND "measurement"."is_system"
	AND "measurement_name"."locale" = 'en-GB'
	AND "measurement_name"."is_canonical"
	AND "measurement_name"."name" = "unit"."gb_name";--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_key_key" ON "measurement" USING btree ("key");
