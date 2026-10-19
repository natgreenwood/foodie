import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, vi } from "vitest";
import { chooseIngredients } from "../import/match-ingredients.js";
import { dbTest } from "../test/db.js";
import type { TestTransaction } from "../test/db.js";
import {
  AiNotConfiguredError,
  AiProviderError,
  complete,
  MAX_RESPONSE_BYTES,
} from "./complete.js";
import {
  setModelSelection,
  setProviderCredential,
  type AiProvider,
} from "./settings.js";

const settingsKey = randomBytes(32);
const API_KEY = "sk-complete-test-key";
const request = {
  system: "You extract ingredients.",
  user: "2 eggs, 100 g flour",
  maxTokens: 256,
};

// For the one test that needs a real request.
const realFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => {
  fetchMock.mockReset();
});

async function configure(
  tx: TestTransaction,
  provider: AiProvider,
  model: string,
  credential = API_KEY,
) {
  await setProviderCredential(tx, settingsKey, provider, credential);
  await setModelSelection(tx, { procedure: "default", provider, model });
}

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

// The one request complete sent: its URL, headers and parsed JSON body.
function sent() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    // complete passes the URL as a string and the body as JSON text.
    url: url as string,
    headers: new Headers(init?.headers),
    body: JSON.parse(init?.body as string) as unknown,
  };
}

const chatAnswer = {
  choices: [{ message: { role: "assistant", content: "eggs, flour" } }],
};
const anthropicAnswer = { content: [{ type: "text", text: "eggs, flour" }] };

dbTest("calls Anthropic's Messages API", async ({ tx }) => {
  await configure(tx, "anthropic", "claude-haiku-5-5");
  respond(200, {
    content: [
      { type: "text", text: "eggs, " },
      { type: "text", text: "flour" },
    ],
  });

  await expect(complete({ db: tx, settingsKey }, request)).resolves.toEqual({
    text: "eggs, flour",
    provider: "anthropic",
    model: "claude-haiku-5-5",
  });
  const { url, headers, body } = sent();
  expect(url).toBe("https://api.anthropic.com/v1/messages");
  expect(headers.get("x-api-key")).toBe(API_KEY);
  expect(headers.get("anthropic-version")).toBe("2023-06-01");
  expect(headers.get("content-type")).toBe("application/json");
  expect(body).toEqual({
    model: "claude-haiku-5-5",
    max_tokens: 256,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
  });
});

const chatMessages = [
  { role: "system", content: request.system },
  { role: "user", content: request.user },
];

dbTest("calls OpenAI's chat completions", async ({ tx }) => {
  await configure(tx, "openai", "gpt-5-mini");
  respond(200, chatAnswer);

  await expect(complete({ db: tx, settingsKey }, request)).resolves.toEqual({
    text: "eggs, flour",
    provider: "openai",
    model: "gpt-5-mini",
  });
  const { url, headers, body } = sent();
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  expect(body).toEqual({
    model: "gpt-5-mini",
    messages: chatMessages,
    max_completion_tokens: 256,
  });
});

dbTest("calls OpenRouter's chat completions", async ({ tx }) => {
  await configure(tx, "openrouter", "google/gemini-flash");
  respond(200, chatAnswer);

  await expect(complete({ db: tx, settingsKey }, request)).resolves.toEqual({
    text: "eggs, flour",
    provider: "openrouter",
    model: "google/gemini-flash",
  });
  const { url, headers, body } = sent();
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  expect(body).toEqual({
    model: "google/gemini-flash",
    messages: chatMessages,
    max_tokens: 256,
  });
});

dbTest(
  "calls Ollama's chat completions at its stored base URL",
  async ({ tx }) => {
    await configure(tx, "ollama", "llama3.1:8b", "http://ollama:11434");
    respond(200, chatAnswer);

    await expect(complete({ db: tx, settingsKey }, request)).resolves.toEqual({
      text: "eggs, flour",
      provider: "ollama",
      model: "llama3.1:8b",
    });
    const { url, headers, body } = sent();
    expect(url).toBe("http://ollama:11434/v1/chat/completions");
    expect(headers.has("authorization")).toBe(false);
    expect(body).toEqual({
      model: "llama3.1:8b",
      messages: chatMessages,
      max_tokens: 256,
    });
  },
);

dbTest(
  "keeps an Ollama base URL's path and sends its user as Basic auth",
  async ({ tx }) => {
    await configure(
      tx,
      "ollama",
      "llama3.1:8b",
      "https://me:p%40ss@proxy.lan/ollama",
    );
    respond(200, chatAnswer);

    await complete({ db: tx, settingsKey }, request);
    const { url, headers } = sent();
    expect(url).toBe("https://proxy.lan/ollama/v1/chat/completions");
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("me:p@ss").toString("base64")}`,
    );
  },
);

for (const baseUrl of ["http://ollama:11434/v1", "http://ollama:11434/v1/"]) {
  dbTest(
    `does not repeat /v1 from the Ollama base URL ${baseUrl}`,
    async ({ tx }) => {
      await configure(tx, "ollama", "llama3.1:8b", baseUrl);
      respond(200, chatAnswer);

      await complete({ db: tx, settingsKey }, request);
      expect(sent().url).toBe("http://ollama:11434/v1/chat/completions");
    },
  );
}

describe("reasoning level", () => {
  async function configureAt(
    tx: TestTransaction,
    provider: AiProvider,
    model: string,
  ) {
    await setProviderCredential(
      tx,
      settingsKey,
      provider,
      provider === "ollama" ? "http://ollama:11434" : API_KEY,
    );
    await setModelSelection(tx, {
      procedure: "default",
      provider,
      model,
      reasoningLevel: "high",
    });
  }

  dbTest.for([
    ["anthropic", "claude-haiku-5-5", { output_config: { effort: "high" } }],
    [
      "anthropic",
      "claude-opus-4-5-20251101",
      { output_config: { effort: "high" } },
    ],
    ["openai", "gpt-5-mini", { reasoning_effort: "high" }],
    ["openai", "o4-mini-2025-04-16", { reasoning_effort: "high" }],
    ["openrouter", "openai/gpt-5-mini", { reasoning: { effort: "high" } }],
  ] as const)(
    "is sent to %s %s as the provider's own parameter",
    async ([provider, model, fields], { tx }) => {
      await configureAt(tx, provider, model);
      respond(200, provider === "anthropic" ? anthropicAnswer : chatAnswer);

      await complete({ db: tx, settingsKey }, request);
      expect(sent().body).toMatchObject({ model, ...fields });
    },
  );

  dbTest.for([
    ["anthropic", "claude-haiku-4-5"],
    ["anthropic", "claude-sonnet-4-5-20250929"],
    ["anthropic", "claude-some-future-model"],
    ["openai", "gpt-4.1-mini"],
    ["openai", "o1-mini"],
    ["openai", "gpt-5-chat-latest"],
    ["openrouter", "openai/gpt-4.1-mini"],
    ["openrouter", "anthropic/claude-haiku-5.5"],
    ["openrouter", "google/gemini-flash"],
    ["ollama", "llama3.1:8b"],
  ] as const)(
    "is left out for %s %s, which may not take it",
    async ([provider, model], { tx }) => {
      await configureAt(tx, provider, model);
      respond(200, provider === "anthropic" ? anthropicAnswer : chatAnswer);

      await complete({ db: tx, settingsKey }, request);
      const body = sent().body as Record<string, unknown>;
      expect(body.model).toBe(model);
      expect(body).not.toHaveProperty("output_config");
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("reasoning");
    },
  );
});

dbTest("refuses when no provider is selected", async ({ tx }) => {
  await setProviderCredential(tx, settingsKey, "openai", API_KEY);

  const err = await complete({ db: tx, settingsKey }, request).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AiNotConfiguredError);
  expect(err).toMatchObject({
    reason: "no_selection",
    procedure: "default",
    provider: null,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

dbTest(
  "refuses when the selected provider has no credential",
  async ({ tx }) => {
    await setModelSelection(tx, {
      procedure: "default",
      provider: "anthropic",
      model: "claude-haiku-5-5",
    });

    const err = await complete({ db: tx, settingsKey }, request).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiNotConfiguredError);
    expect(err).toMatchObject({
      reason: "no_credential",
      procedure: "default",
      provider: "anthropic",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

dbTest(
  "reports a non-2xx with provider, model, status and error code",
  async ({ tx }) => {
    await configure(tx, "anthropic", "claude-haiku-5-5");
    respond(401, {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });

    const err = await complete({ db: tx, settingsKey }, request).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      reason: "http_error",
      status: 401,
      code: "authentication_error",
      providerMessage: "HTTP 401 (authentication_error)",
      message:
        "anthropic claude-haiku-5-5: http_error, status 401 (authentication_error)",
    });
    expect((err as Error).message).not.toContain("invalid x-api-key");
    expect((err as Error).message).not.toContain(API_KEY);
    expect((err as Error).message).not.toContain(request.user);
  },
);

dbTest(
  "reports a non-2xx without a JSON body by its status",
  async ({ tx }) => {
    await configure(tx, "openrouter", "google/gemini-flash");
    respond(502, "<html>Bad gateway</html>");

    await expect(
      complete({ db: tx, settingsKey }, request),
    ).rejects.toMatchObject({
      reason: "http_error",
      status: 502,
      code: null,
      providerMessage: "HTTP 502",
    });
  },
);

dbTest("reports a 2xx without text as a bad response", async ({ tx }) => {
  await configure(tx, "openai", "gpt-5-mini");
  respond(200, { choices: [] });

  await expect(
    complete({ db: tx, settingsKey }, request),
  ).rejects.toMatchObject({
    provider: "openai",
    model: "gpt-5-mini",
    reason: "bad_response",
    status: 200,
  });
});

describe("a 2xx that is not a whole answer", () => {
  const models = {
    anthropic: "claude-haiku-5-5",
    openai: "gpt-5-mini",
    openrouter: "google/gemini-flash",
    ollama: "llama3.1:8b",
  } as const;

  // The provider's own words in these bodies, none of which may be quoted.
  const providerWords = [
    "I can't help",
    "upstream provider error",
    "upstream died",
    "Policy says no",
  ];

  // [provider, 2xx body, reason, providerMessage, code]. The first nine are
  // the rows of NATG-330's table, in order.
  dbTest.for([
    [
      "anthropic",
      { content: [] },
      "bad_response",
      "no text in the response",
      null,
    ],
    [
      "anthropic",
      { content: [{ type: "text", text: "" }] },
      "bad_response",
      "empty text in the response",
      null,
    ],
    [
      "anthropic",
      {
        content: [{ type: "text", text: "2 eggs, 10" }],
        stop_reason: "max_tokens",
      },
      "truncated",
      "answer cut off at the token limit",
      null,
    ],
    [
      "openai",
      { choices: [] },
      "bad_response",
      "no text in the response",
      null,
    ],
    [
      "openai",
      { choices: [{ message: { content: "" }, finish_reason: "length" }] },
      "truncated",
      "answer cut off at the token limit",
      null,
    ],
    [
      "openai",
      {
        choices: [
          { message: { content: "2 eggs, 10" }, finish_reason: "length" },
        ],
      },
      "truncated",
      "answer cut off at the token limit",
      null,
    ],
    [
      "openai",
      {
        choices: [
          {
            message: { content: null, refusal: "I can't help" },
            finish_reason: "stop",
          },
        ],
      },
      "bad_response",
      "model refused",
      null,
    ],
    [
      "openrouter",
      { error: { code: 502, message: "upstream provider error" } },
      "bad_response",
      "provider reported an error",
      null,
    ],
    [
      "openrouter",
      {
        choices: [
          {
            message: { content: "" },
            finish_reason: "error",
            error: { message: "upstream died" },
          },
        ],
      },
      "bad_response",
      "provider reported an error",
      null,
    ],
    // The decisions beyond the table.
    [
      "anthropic",
      {
        content: [{ type: "text", text: "Policy says no" }],
        stop_reason: "refusal",
      },
      "bad_response",
      "model refused",
      null,
    ],
    [
      "anthropic",
      {
        content: [{ type: "text", text: "2 eggs, 10" }],
        stop_reason: "model_context_window_exceeded",
      },
      "truncated",
      "answer cut off at the token limit",
      null,
    ],
    [
      "openai",
      {
        choices: [
          {
            message: { content: "2 eggs, 10" },
            finish_reason: "content_filter",
          },
        ],
      },
      "bad_response",
      "answer filtered by the provider",
      null,
    ],
    [
      "anthropic",
      { content: [{ type: "text", text: " \n\t" }], stop_reason: "end_turn" },
      "bad_response",
      "empty text in the response",
      null,
    ],
    [
      "ollama",
      { choices: [{ message: { content: "  \n" }, finish_reason: "stop" }] },
      "bad_response",
      "empty text in the response",
      null,
    ],
    [
      "openrouter",
      {
        choices: [
          {
            message: { content: "eggs" },
            finish_reason: "error",
            error: { code: "server_error", message: "upstream died" },
          },
        ],
      },
      "bad_response",
      "provider reported an error (server_error)",
      "server_error",
    ],
    [
      "openrouter",
      { error: { code: 2100, message: "upstream provider error" } },
      "bad_response",
      "provider reported an error",
      null,
    ],
    [
      "openrouter",
      { error: "upstream provider error" },
      "bad_response",
      "provider reported an error",
      null,
    ],
  ] as const)(
    "rejects %s %j as %s",
    async ([provider, body, reason, providerMessage, code], { tx }) => {
      const model = models[provider];
      await configure(
        tx,
        provider,
        model,
        provider === "ollama" ? "http://ollama:11434" : API_KEY,
      );
      respond(200, body);

      const err = (await complete({ db: tx, settingsKey }, request).catch(
        (e: unknown) => e,
      )) as AiProviderError;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err).toMatchObject({
        provider,
        model,
        reason,
        status: 200,
        code,
        providerMessage,
        message: `${provider} ${model}: ${reason}, status 200: ${providerMessage}`,
      });
      for (const words of providerWords) {
        expect(err.message).not.toContain(words);
      }
    },
  );

  // SEC-1: a numeric code that is a fragment of the prompt or the key, which
  // the scrub of whole secrets cannot catch, so no numeric code is kept.
  dbTest.for([
    ["top-level", { error: { code: 314 } }],
    [
      "choice-level",
      {
        choices: [
          {
            message: { content: "" },
            finish_reason: "error",
            error: { code: 314 },
          },
        ],
      },
    ],
  ] as const)(
    "keeps a numeric %s error code that is part of the prompt out of the error and the log",
    async ([, body], { tx }) => {
      const prompt = "Private reference 314159";
      await configure(
        tx,
        "openrouter",
        "google/gemini-flash",
        "sk-example-314159-demo",
      );
      respond(200, body);

      const err = (await complete(
        { db: tx, settingsKey },
        { ...request, user: prompt },
      ).catch((e: unknown) => e)) as AiProviderError;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err).toMatchObject({
        reason: "bad_response",
        status: 200,
        code: null,
        providerMessage: "provider reported an error",
      });
      for (const field of [err.message, err.providerMessage, err.code]) {
        expect(String(field)).not.toContain("314");
      }

      // One level up: the line holding the digits is in the prompt
      // chooseIngredients sends, and its warning names no code.
      fetchMock.mockReset();
      respond(200, body);
      const log = { info: vi.fn(), warn: vi.fn() };
      const { matching } = await chooseIngredients(
        [
          {
            position: 1,
            ingredientText: prompt,
            candidates: [
              {
                ingredientId: 12,
                name: "egg",
                locale: "en-GB",
                similarity: 0.5,
              },
            ],
          },
        ],
        (req) => complete({ db: tx, settingsKey }, req),
        log,
      );
      expect(JSON.stringify(sent().body)).toContain(prompt);
      expect(matching.status).toBe("ai_failed");
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]![0]).toMatchObject({ code: null });
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain("314");
    },
  );

  dbTest(
    "keeps a reported error's code that holds the prompt out",
    async ({ tx }) => {
      await configure(tx, "openrouter", "google/gemini-flash");
      // A code from the set, with a prompt that is exactly that code.
      respond(200, { error: { code: "server_error" } });

      await expect(
        complete({ db: tx, settingsKey }, { ...request, user: "server_error" }),
      ).rejects.toMatchObject({
        reason: "bad_response",
        code: null,
        providerMessage: "provider reported an error",
      });
    },
  );

  dbTest.for([
    [
      "anthropic",
      {
        content: [{ type: "text", text: "eggs, flour" }],
        stop_reason: "end_turn",
      },
    ],
    [
      "openai",
      {
        choices: [
          {
            message: { content: "eggs, flour", refusal: null },
            finish_reason: "stop",
          },
        ],
      },
    ],
    [
      "openrouter",
      {
        choices: [
          { message: { content: "eggs, flour" }, finish_reason: "stop" },
        ],
        error: null,
      },
    ],
  ] as const)(
    "still returns a whole answer from %s",
    async ([provider, body], { tx }) => {
      const model = models[provider];
      await configure(tx, provider, model);
      respond(200, body);

      await expect(complete({ db: tx, settingsKey }, request)).resolves.toEqual(
        { text: "eggs, flour", provider, model },
      );
    },
  );
});

dbTest("refuses a response past MAX_RESPONSE_BYTES", async ({ tx }) => {
  await configure(tx, "openai", "gpt-5-mini");
  respond(200, "x".repeat(MAX_RESPONSE_BYTES + 1));

  await expect(
    complete({ db: tx, settingsKey }, request),
  ).rejects.toMatchObject({ reason: "bad_response", status: 200 });
});

dbTest("gives up after the timeout", async ({ tx }) => {
  await configure(tx, "ollama", "llama3.1:8b", "http://ollama:11434");
  // Answers only when aborted, as a provider that never replies would.
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason as Error),
        );
      }),
  );

  await expect(
    complete({ db: tx, settingsKey, timeoutMs: 20 }, request),
  ).rejects.toMatchObject({
    provider: "ollama",
    model: "llama3.1:8b",
    reason: "timeout",
    status: null,
    cause: { name: "TimeoutError", code: null },
  });
});

dbTest(
  "keeps the status when the body times out after the headers",
  async ({ tx }) => {
    await configure(tx, "ollama", "llama3.1:8b", "http://ollama:11434");
    // Headers at once, then a body that never ends until aborted.
    fetchMock.mockImplementation((_url, init) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"choices":'));
          signal.addEventListener("abort", () =>
            controller.error(signal.reason),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    await expect(
      complete({ db: tx, settingsKey, timeoutMs: 20 }, request),
    ).rejects.toMatchObject({ reason: "timeout", status: 200 });
  },
);

dbTest("reports a connection failure with its cause", async ({ tx }) => {
  await configure(tx, "ollama", "llama3.1:8b", "http://ollama:11434");
  fetchMock.mockRejectedValue(
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:11434"), {
        code: "ECONNREFUSED",
      }),
    }),
  );

  await expect(
    complete({ db: tx, settingsKey }, request),
  ).rejects.toMatchObject({
    reason: "unreachable",
    status: null,
    providerMessage: "connect ECONNREFUSED 10.0.0.5:11434",
  });
});

dbTest(
  "gives a connection failure a cause of only its name and code",
  async ({ tx }) => {
    const baseUrl = "http://me:s3cret-pass@ollama.lan:11434";
    await configure(tx, "ollama", "llama3.1:8b", baseUrl);
    const inner = Object.assign(
      new Error(`connect ECONNREFUSED ${baseUrl} ${request.user}`),
      { code: "ECONNREFUSED" },
    );
    fetchMock.mockRejectedValue(
      new TypeError(`fetch failed for ${baseUrl}`, { cause: inner }),
    );

    const err = (await complete({ db: tx, settingsKey }, request).catch(
      (e: unknown) => e,
    )) as AiProviderError;
    expect(err).toBeInstanceOf(AiProviderError);
    // Exactly these keys: no message, no nested cause.
    expect(err.cause).toStrictEqual({
      name: "TypeError",
      code: "ECONNREFUSED",
    });
    expect(JSON.stringify(err.cause)).not.toContain("s3cret-pass");
  },
);

dbTest(
  "never quotes a provider's error.message, which may echo the key and prompt",
  async ({ tx }) => {
    await configure(tx, "openai", "gpt-5-mini");
    respond(401, {
      error: {
        message: `Invalid key ${API_KEY} for "${request.system}" / "${request.user}"`,
      },
    });

    const err = (await complete({ db: tx, settingsKey }, request).catch(
      (e: unknown) => e,
    )) as AiProviderError;
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.status).toBe(401);
    expect(err.providerMessage).toBe("HTTP 401");
    expect(err.message).toBe("openai gpt-5-mini: http_error, status 401");
    for (const secret of [API_KEY, request.system, request.user]) {
      expect(err.message).not.toContain(secret);
    }
  },
);

dbTest(
  "scrubs an echoed Ollama URL, with or without its password",
  async ({ tx }) => {
    const baseUrl = "http://me:s3cret-pass@ollama.lan:11434";
    await configure(tx, "ollama", "llama3.1:8b", baseUrl);
    respond(401, {
      error: {
        message: `denied ${baseUrl} (http://ollama.lan:11434/v1/chat/completions, http://ollama.lan:11434) pw s3cret-pass prompt ${request.user}`,
      },
    });

    const err = (await complete({ db: tx, settingsKey }, request).catch(
      (e: unknown) => e,
    )) as AiProviderError;
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.status).toBe(401);
    for (const secret of [
      baseUrl,
      "s3cret-pass",
      "ollama.lan:11434",
      request.user,
    ]) {
      expect(err.message).not.toContain(secret);
    }
  },
);

dbTest("quotes nothing from an error body without a code", async ({ tx }) => {
  await configure(tx, "openrouter", "google/gemini-flash");
  respond(401, { error: `bad key, prompt was ${request.user}`, detail: "x" });

  await expect(
    complete({ db: tx, settingsKey }, request),
  ).rejects.toMatchObject({ status: 401, providerMessage: "HTTP 401" });
});

// Every character here is absent from the error's own words for this model
// and status, so a match can only be a leak.
for (const [password, prompt] of [
  ["Q", "W"],
  ["QZ", "WG"],
  ["QZX", "WGF"],
] as const) {
  dbTest(
    `keeps a ${password.length}-character password and prompt out of a 401`,
    async ({ tx }) => {
      const baseUrl = `http://Kq:${password}@ollama.lan:11434`;
      await configure(tx, "ollama", "llama3.1:8b", baseUrl);
      const short = { ...request, user: prompt };
      respond(401, {
        error: {
          code: "invalid_api_key",
          message: `key ${baseUrl} user Kq pw=${password} prompt=${prompt}`,
        },
      });

      const err = (await complete({ db: tx, settingsKey }, short).catch(
        (e: unknown) => e,
      )) as AiProviderError;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err).toMatchObject({
        status: 401,
        code: "invalid_api_key",
        providerMessage: "HTTP 401 (invalid_api_key)",
        message: "ollama llama3.1:8b: http_error, status 401 (invalid_api_key)",
      });
      for (const secret of [baseUrl, "Kq", password, prompt]) {
        expect(err.message).not.toContain(secret);
        expect(err.providerMessage).not.toContain(secret);
      }
    },
  );
}

dbTest(
  "falls back to error.type when an OpenAI-compatible error has no code",
  async ({ tx }) => {
    await configure(tx, "openrouter", "google/gemini-flash");
    respond(400, {
      error: { code: null, type: "invalid_request_error", message: "x" },
    });

    await expect(
      complete({ db: tx, settingsKey }, request),
    ).rejects.toMatchObject({
      code: "invalid_request_error",
      providerMessage: "HTTP 400 (invalid_request_error)",
    });
  },
);

for (const [what, code] of [
  ["spaces", "invalid api key"],
  ["a prompt fragment", "2 eggs, 100 g"],
  ["more than 64 characters", "x".repeat(65)],
  ["a number", 401],
  ["an object", { message: request.user }],
  ["a well-formed code not in the set", "abc"],
] as const) {
  dbTest(
    `gives only the status for an error code of ${what}`,
    async ({ tx }) => {
      await configure(tx, "openai", "gpt-5-mini");
      respond(401, {
        error: { code, type: code, message: `prompt was ${request.user}` },
      });

      await expect(
        complete({ db: tx, settingsKey }, request),
      ).rejects.toMatchObject({
        code: null,
        providerMessage: "HTTP 401",
        message: "openai gpt-5-mini: http_error, status 401",
      });
    },
  );
}

for (const password of ["Q", "QZ", "QZX"]) {
  dbTest(
    `gives only the status for a ${password.length}-character password or prompt as the code`,
    async ({ tx }) => {
      await configure(
        tx,
        "ollama",
        "llama3.1:8b",
        `http://Kq:${password}@ollama.lan:11434`,
      );
      // The prompt is as short, and placed in error.type.
      const prompt = password.replace(/./g, "W");
      respond(401, { error: { code: password, type: prompt } });

      const err = (await complete(
        { db: tx, settingsKey },
        { ...request, user: prompt },
      ).catch((e: unknown) => e)) as AiProviderError;
      expect(err).toMatchObject({
        code: null,
        providerMessage: "HTTP 401",
        message: "ollama llama3.1:8b: http_error, status 401",
      });
      expect(err.message).not.toContain(password);
      expect(err.message).not.toContain(prompt);
    },
  );
}

dbTest(
  "fails on a redirect without following it to the second origin",
  async ({ tx }) => {
    let reached = 0;
    const second = createServer((req, res) => {
      reached += 1;
      req.resume();
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      second.listen(0, "127.0.0.1", resolve),
    );
    const secondUrl = `http://127.0.0.1:${(second.address() as AddressInfo).port}/v1/chat/completions`;
    const first = createServer((req, res) => {
      req.resume();
      res.writeHead(307, { location: secondUrl });
      res.end();
    });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const { port } = first.address() as AddressInfo;
    fetchMock.mockImplementation(realFetch);

    try {
      await configure(
        tx,
        "ollama",
        "llama3.1:8b",
        `http://me:s3cret-pass@127.0.0.1:${port}`,
      );
      const err = (await complete({ db: tx, settingsKey }, request).catch(
        (e: unknown) => e,
      )) as AiProviderError;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err).toMatchObject({ reason: "unreachable", status: null });
      expect(err.cause).toStrictEqual({ name: "TypeError", code: null });
      for (const secret of ["s3cret-pass", request.user]) {
        expect(err.message).not.toContain(secret);
      }
      expect(reached).toBe(0);
    } finally {
      first.close();
      second.close();
    }
  },
);

dbTest(
  "refuses an Ollama URL whose password does not decode",
  async ({ tx }) => {
    await configure(tx, "ollama", "llama3.1:8b", "http://u:%ZZ@host");

    const err = await complete({ db: tx, settingsKey }, request).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiNotConfiguredError);
    expect(err).toMatchObject({
      reason: "invalid_credential",
      procedure: "default",
      provider: "ollama",
    });
    expect((err as Error).message).not.toContain("%ZZ");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
