import { randomBytes } from "node:crypto";
import { afterEach, expect, vi } from "vitest";
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
  "reports a non-2xx with provider, model, status and message",
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
      providerMessage: "invalid x-api-key",
      message:
        "anthropic claude-haiku-5-5: http_error, status 401: invalid x-api-key",
    });
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
  });
});

dbTest("reports a connection failure with its cause", async ({ tx }) => {
  await configure(tx, "ollama", "llama3.1:8b", "http://ollama:11434");
  fetchMock.mockRejectedValue(
    new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 10.0.0.5:11434"),
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
