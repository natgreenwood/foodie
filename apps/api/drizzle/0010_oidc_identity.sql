CREATE TABLE "oidc_identity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "oidc_identity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_login" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"user_id" bigint,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oidc_identity" ADD CONSTRAINT "oidc_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_login" ADD CONSTRAINT "oidc_login_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_identity_issuer_subject_key" ON "oidc_identity" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_identity_user_issuer_key" ON "oidc_identity" USING btree ("user_id","issuer");--> statement-breakpoint
CREATE INDEX "oidc_login_user_id_idx" ON "oidc_login" USING btree ("user_id");