ALTER TABLE "measurement" DROP CONSTRAINT "measurement_factor_to_base_positive";--> statement-breakpoint
ALTER TABLE "recipe_ingredient" DROP CONSTRAINT "recipe_ingredient_quantity_positive";--> statement-breakpoint
ALTER TABLE "measurement" ADD CONSTRAINT "measurement_factor_to_base_positive" CHECK ("measurement"."factor_to_base" > 0 AND "measurement"."factor_to_base" < 'Infinity');--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_quantity_positive" CHECK ("recipe_ingredient"."quantity" > 0 AND "recipe_ingredient"."quantity" < 'Infinity');