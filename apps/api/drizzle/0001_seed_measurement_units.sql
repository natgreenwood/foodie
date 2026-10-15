-- Seeds the 25 system units approved on NATG-211 (factors, names and
-- abbreviations as in that table), each with one canonical en-GB and en-US
-- name. measurement.id is GENERATED ALWAYS, so the identity assigns the IDs.
-- MERGE ... RETURNING (Postgres 17+) can return the source row's key next to
-- the new id, which INSERT ... RETURNING cannot; `key` exists only here.
-- Count units have a null factor: they have no base unit and only sum with
-- the same measurement.id (NATG-213).
WITH "unit" ("key", "type", "factor_to_base", "gb_name", "gb_abbreviation", "us_name", "us_abbreviation") AS (
	VALUES
		('gram', 'mass'::"measurement_type", 1, 'gram', 'g', 'gram', 'g'),
		('kilogram', 'mass', 1000, 'kilogram', 'kg', 'kilogram', 'kg'),
		('ounce', 'mass', 28.349523125, 'ounce', 'oz', 'ounce', 'oz'),
		('pound', 'mass', 453.59237, 'pound', 'lb', 'pound', 'lb'),
		('millilitre', 'volume', 1, 'millilitre', 'ml', 'milliliter', 'mL'),
		('litre', 'volume', 1000, 'litre', 'l', 'liter', 'L'),
		('teaspoon', 'volume', 5, 'teaspoon', 'tsp', 'teaspoon', 'tsp'),
		('tablespoon', 'volume', 15, 'tablespoon', 'tbsp', 'tablespoon', 'tbsp'),
		('cup_us', 'volume', 236.5882365, 'US cup', 'US cup', 'cup', 'cup'),
		('cup_metric', 'volume', 250, 'cup', 'cup', 'metric cup', 'metric cup'),
		('fl_oz_us', 'volume', 29.5735295625, 'US fluid ounce', 'US fl oz', 'fluid ounce', 'fl oz'),
		('fl_oz_imperial', 'volume', 28.4130625, 'fluid ounce', 'fl oz', 'imperial fluid ounce', 'imp fl oz'),
		('pint_us', 'volume', 473.176473, 'US pint', 'US pt', 'pint', 'pt'),
		('pint_imperial', 'volume', 568.26125, 'pint', 'pt', 'imperial pint', 'imp pt'),
		('quart_us', 'volume', 946.352946, 'US quart', 'US qt', 'quart', 'qt'),
		('each', 'count', NULL, 'each', 'ea', 'each', 'ea'),
		('clove', 'count', NULL, 'clove', NULL, 'clove', NULL),
		('pinch', 'count', NULL, 'pinch', NULL, 'pinch', NULL),
		('dash', 'count', NULL, 'dash', NULL, 'dash', NULL),
		('slice', 'count', NULL, 'slice', NULL, 'slice', NULL),
		('can', 'count', NULL, 'tin', NULL, 'can', NULL),
		('bunch', 'count', NULL, 'bunch', NULL, 'bunch', NULL),
		('sprig', 'count', NULL, 'sprig', NULL, 'sprig', NULL),
		('handful', 'count', NULL, 'handful', NULL, 'handful', NULL),
		('packet', 'count', NULL, 'packet', NULL, 'package', 'pkg')
),
"inserted" AS (
	MERGE INTO "measurement" USING "unit" ON false
	WHEN NOT MATCHED THEN
		INSERT ("type", "factor_to_base", "is_system")
		VALUES ("unit"."type", "unit"."factor_to_base", true)
	RETURNING "unit"."key", "measurement"."id"
)
INSERT INTO "measurement_name" ("measurement_id", "locale", "name", "abbreviation", "is_canonical")
SELECT "inserted"."id", "n"."locale", "n"."name", "n"."abbreviation", true
FROM "inserted"
JOIN "unit" USING ("key")
CROSS JOIN LATERAL (
	VALUES
		('en-GB', "unit"."gb_name", "unit"."gb_abbreviation"),
		('en-US', "unit"."us_name", "unit"."us_abbreviation")
) AS "n" ("locale", "name", "abbreviation");
