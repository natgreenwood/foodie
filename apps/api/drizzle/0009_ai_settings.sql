CREATE TABLE "ai_model_selection" (
	"procedure" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_selection_provider_known" CHECK ("ai_model_selection"."provider" IN ('anthropic', 'openai', 'openrouter', 'ollama')),
	CONSTRAINT "ai_model_selection_procedure_not_blank" CHECK (btrim("ai_model_selection"."procedure") <> ''),
	CONSTRAINT "ai_model_selection_model_not_blank" CHECK (btrim("ai_model_selection"."model") <> '')
);
--> statement-breakpoint
CREATE TABLE "ai_provider_setting" (
	"provider" text PRIMARY KEY NOT NULL,
	"credential" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_setting_provider_known" CHECK ("ai_provider_setting"."provider" IN ('anthropic', 'openai', 'openrouter', 'ollama'))
);
