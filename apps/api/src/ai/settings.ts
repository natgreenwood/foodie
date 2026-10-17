import { eq, sql } from "drizzle-orm";
import type { Db } from "../auth/accounts.js";
import { aiModelSelection, aiProviderSetting } from "../db/schema.js";
import { decryptSetting, encryptSetting } from "../settings/encryption.js";

// The platform-wide AI settings an admin manages (NATG-277): a credential per
// provider, stored encrypted, and the provider and model per procedure.

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "ollama",
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// The procedures a model can be chosen for. `default` is the fallback for a
// procedure without its own selection; NATG-238 adds more.
export const AI_PROCEDURES = ["default"] as const;
export type AiProcedure = (typeof AI_PROCEDURES)[number];

export interface ModelSelection {
  procedure: string;
  provider: AiProvider;
  model: string;
}

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function isAiProcedure(value: string): value is AiProcedure {
  return (AI_PROCEDURES as readonly string[]).includes(value);
}

// Authenticated with the ciphertext, so a provider's stored credential does
// not decrypt as another provider's.
function credentialContext(provider: AiProvider): string {
  return `ai_provider:${provider}`;
}

// Stores the provider's API key (or Ollama base URL), replacing any earlier
// one. Repeating it is harmless.
export async function setProviderCredential(
  db: Db,
  key: Buffer,
  provider: AiProvider,
  credential: string,
): Promise<void> {
  const encrypted = encryptSetting(
    key,
    credentialContext(provider),
    credential,
  );
  await db
    .insert(aiProviderSetting)
    .values({ provider, credential: encrypted })
    .onConflictDoUpdate({
      target: aiProviderSetting.provider,
      set: { credential: encrypted, updatedAt: sql`now()` },
    });
}

// Removes the provider's credential, if any. Repeating it is harmless.
export async function clearProviderCredential(
  db: Db,
  provider: AiProvider,
): Promise<void> {
  await db
    .delete(aiProviderSetting)
    .where(eq(aiProviderSetting.provider, provider));
}

// Whether each provider has a credential, without decrypting any.
export async function configuredProviders(
  db: Db,
): Promise<{ provider: AiProvider; configured: boolean }[]> {
  const rows = await db
    .select({ provider: aiProviderSetting.provider })
    .from(aiProviderSetting);
  const configured = new Set(rows.map((r) => r.provider));
  return AI_PROVIDERS.map((provider) => ({
    provider,
    configured: configured.has(provider),
  }));
}

// The provider's decrypted credential, or null when none is set. For the
// code that calls the provider; never for a response or a log line. Throws
// DecryptError if the stored value was altered or SETTINGS_ENCRYPTION_KEY
// has changed since it was saved.
export async function providerCredential(
  db: Db,
  key: Buffer,
  provider: AiProvider,
): Promise<string | null> {
  const [row] = await db
    .select({ credential: aiProviderSetting.credential })
    .from(aiProviderSetting)
    .where(eq(aiProviderSetting.provider, provider));
  if (!row) return null;
  return decryptSetting(key, credentialContext(provider), row.credential);
}

export async function listModelSelections(db: Db): Promise<ModelSelection[]> {
  const rows = await db
    .select({
      procedure: aiModelSelection.procedure,
      provider: aiModelSelection.provider,
      model: aiModelSelection.model,
    })
    .from(aiModelSelection)
    .orderBy(aiModelSelection.procedure);
  // The table's check constraint holds provider to AI_PROVIDERS.
  return rows as ModelSelection[];
}

// Sets the procedure's provider and model, replacing any earlier choice.
export async function setModelSelection(
  db: Db,
  selection: ModelSelection,
): Promise<void> {
  await db
    .insert(aiModelSelection)
    .values(selection)
    .onConflictDoUpdate({
      target: aiModelSelection.procedure,
      set: {
        provider: selection.provider,
        model: selection.model,
        updatedAt: sql`now()`,
      },
    });
}
