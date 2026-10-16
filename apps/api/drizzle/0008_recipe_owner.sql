ALTER TABLE "recipe" ADD COLUMN "owner_id" bigint;--> statement-breakpoint
-- Recipes made before accounts existed go to the bootstrap admin, the
-- lowest-id admin. With recipes and no admin there is no one to give them
-- to, so stop rather than guess; the migrations run in one transaction, so
-- nothing is left half-applied.
DO $$
DECLARE
	recipes bigint;
	admin_id bigint;
BEGIN
	SELECT count(*) INTO recipes FROM "recipe";
	IF recipes = 0 THEN
		RETURN;
	END IF;
	SELECT "id" INTO admin_id FROM "user" WHERE "is_admin" ORDER BY "id" LIMIT 1;
	IF admin_id IS NULL THEN
		RAISE EXCEPTION 'recipe.owner_id: % existing recipe(s) need an owner but there is no admin user to assign them to', recipes
			USING HINT = 'Make an account an admin (UPDATE "user" SET is_admin = true WHERE id = ...) or delete the recipes, then migrate again.';
	END IF;
	UPDATE "recipe" SET "owner_id" = admin_id;
END $$;--> statement-breakpoint
ALTER TABLE "recipe" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_owner_id_idx" ON "recipe" USING btree ("owner_id");
