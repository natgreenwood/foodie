import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { aiModelSelection, aiProviderSetting } from "../db/schema.js";
import { DecryptError } from "../settings/encryption.js";
import { dbTest } from "../test/db.js";
import {
  clearProviderCredential,
  configuredProviders,
  listModelSelections,
  providerCredential,
  setModelSelection,
  setProviderCredential,
} from "./settings.js";

const key = randomBytes(32);
const API_KEY = "sk-or-v1-settings-test-key";

dbTest("stores a credential encrypted and reads it back", async ({ tx }) => {
  await setProviderCredential(tx, key, "openrouter", API_KEY);

  const [row] = await tx
    .select()
    .from(aiProviderSetting)
    .where(eq(aiProviderSetting.provider, "openrouter"));
  expect(row?.credential).toMatch(/^v1\./);
  expect(row?.credential).not.toContain(API_KEY);
  expect(await providerCredential(tx, key, "openrouter")).toBe(API_KEY);
});

dbTest("refuses a stored credential that was altered", async ({ tx }) => {
  await setProviderCredential(tx, key, "openai", API_KEY);
  const [row] = await tx
    .select({ credential: aiProviderSetting.credential })
    .from(aiProviderSetting)
    .where(eq(aiProviderSetting.provider, "openai"));
  const parts = row!.credential.split(".");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  ciphertext[0]! ^= 1;
  parts[3] = ciphertext.toString("base64url");
  await tx
    .update(aiProviderSetting)
    .set({ credential: parts.join(".") })
    .where(eq(aiProviderSetting.provider, "openai"));

  await expect(providerCredential(tx, key, "openai")).rejects.toThrow(
    DecryptError,
  );
});

dbTest(
  "refuses a credential copied to another provider's row",
  async ({ tx }) => {
    await setProviderCredential(tx, key, "openai", API_KEY);
    const [row] = await tx
      .select({ credential: aiProviderSetting.credential })
      .from(aiProviderSetting)
      .where(eq(aiProviderSetting.provider, "openai"));
    await tx
      .insert(aiProviderSetting)
      .values({ provider: "anthropic", credential: row!.credential });

    await expect(providerCredential(tx, key, "anthropic")).rejects.toThrow(
      DecryptError,
    );
  },
);

dbTest("refuses a credential under a different key", async ({ tx }) => {
  await setProviderCredential(tx, key, "anthropic", API_KEY);

  await expect(
    providerCredential(tx, randomBytes(32), "anthropic"),
  ).rejects.toThrow(DecryptError);
});

dbTest("replaces, then clears, a credential", async ({ tx }) => {
  await setProviderCredential(tx, key, "ollama", "http://ollama:11434");
  await setProviderCredential(tx, key, "ollama", "http://gpu-box:11434");

  expect(await providerCredential(tx, key, "ollama")).toBe(
    "http://gpu-box:11434",
  );
  expect(await configuredProviders(tx)).toEqual([
    { provider: "anthropic", configured: false },
    { provider: "openai", configured: false },
    { provider: "openrouter", configured: false },
    { provider: "ollama", configured: true },
  ]);

  await clearProviderCredential(tx, "ollama");
  await clearProviderCredential(tx, "ollama");

  expect(await providerCredential(tx, key, "ollama")).toBeNull();
  expect((await configuredProviders(tx)).every((p) => !p.configured)).toBe(
    true,
  );
});

dbTest("keeps one model selection per procedure", async ({ tx }) => {
  await setModelSelection(tx, {
    procedure: "default",
    provider: "openai",
    model: "gpt-5-mini",
  });
  await setModelSelection(tx, {
    procedure: "default",
    provider: "anthropic",
    model: "claude-haiku-5-5",
  });
  // A procedure the api does not know yet is still just a row.
  await setModelSelection(tx, {
    procedure: "recipe_import",
    provider: "ollama",
    model: "llama3.1:8b",
  });

  expect(await listModelSelections(tx)).toEqual([
    { procedure: "default", provider: "anthropic", model: "claude-haiku-5-5" },
    { procedure: "recipe_import", provider: "ollama", model: "llama3.1:8b" },
  ]);
});

dbTest("refuses an unknown provider in either table", async ({ tx }) => {
  await expect(
    tx.transaction((sp) =>
      sp
        .insert(aiProviderSetting)
        .values({ provider: "gemini", credential: "v1.x.y.z" }),
    ),
  ).rejects.toMatchObject({
    cause: { constraint: "ai_provider_setting_provider_known" },
  });
  await expect(
    tx.transaction((sp) =>
      sp
        .insert(aiModelSelection)
        .values({ procedure: "default", provider: "gemini", model: "x" }),
    ),
  ).rejects.toMatchObject({
    cause: { constraint: "ai_model_selection_provider_known" },
  });
});
