ALTER TABLE "ingredient" ADD COLUMN "created_by" bigint;--> statement-breakpoint
ALTER TABLE "ingredient_name" ADD COLUMN "created_by" bigint;--> statement-breakpoint
ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_name" ADD CONSTRAINT "ingredient_name_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_created_by_idx" ON "ingredient" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ingredient_name_created_by_idx" ON "ingredient_name" USING btree ("created_by");