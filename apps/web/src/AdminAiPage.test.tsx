import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function respondWith(status: number, body?: unknown) {
  return Promise.resolve(
    body === undefined
      ? new Response(null, { status })
      : Response.json(body, { status }),
  );
}

const admin = {
  id: 1,
  email: "sam@example.com",
  displayName: "Sam",
  locale: "en-GB",
  isAdmin: true,
};

const providers = ["anthropic", "openai", "openrouter", "ollama"] as const;
type Provider = (typeof providers)[number];

interface Stored {
  configured: Record<Provider, boolean>;
  provider: Provider | null;
  model: string | null;
  reasoningLevel: string | null;
}

type Handler = (init?: RequestInit) => Promise<Response>;

// The admin AI api over `stored`, which a test can read and which a reload
// sees, with `overrides` answering in its place.
function stubApi(stored: Stored, overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    "GET /api/me": () => respondWith(200, admin),
    "GET /api/admin/ai": () =>
      respondWith(200, {
        providers: providers.map((provider) => ({
          provider,
          configured: stored.configured[provider],
        })),
        models: [
          {
            procedure: "default",
            provider: stored.provider,
            model: stored.model,
            reasoningLevel: stored.reasoningLevel,
          },
        ],
      }),
    "PUT /api/admin/ai/models/default": (init) => {
      const body = JSON.parse(init?.body as string) as {
        provider: Provider;
        model: string;
        reasoningLevel: string | null;
      };
      stored.provider = body.provider;
      stored.model = body.model;
      stored.reasoningLevel = body.reasoningLevel;
      return respondWith(200, {
        procedure: "default",
        provider: stored.provider,
        model: stored.model,
        reasoningLevel: stored.reasoningLevel,
      });
    },
  };
  for (const provider of providers) {
    routes[`PUT /api/admin/ai/providers/${provider}`] = () => {
      stored.configured[provider] = true;
      return respondWith(200, { provider, configured: true });
    };
    routes[`DELETE /api/admin/ai/providers/${provider}`] = () => {
      stored.configured[provider] = false;
      return respondWith(204);
    };
  }
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    const handler = { ...routes, ...overrides }[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodiesOf(fetchMock: ReturnType<typeof stubApi>, key: string) {
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${input}` === key)
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);
}

function stored(changes: Partial<Stored> = {}): Stored {
  return {
    configured: {
      anthropic: false,
      openai: false,
      openrouter: false,
      ollama: false,
    },
    provider: null,
    model: null,
    reasoningLevel: null,
    ...changes,
  };
}

// A response held back until the test lets it go.
function held(response: () => Promise<Response>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

function visit() {
  window.history.replaceState(null, "", "/admin/ai");
  return render(<App />);
}

async function row(name: string) {
  const list = await screen.findByRole("list", {
    name: "Provider credentials",
  });
  const item = within(list)
    .getAllByRole("listitem")
    .find(
      (entry) =>
        entry.querySelector(".identity-name span")?.textContent === name,
    );
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

describe("AI settings page", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the four providers in order, each configured or not set", async () => {
    stubApi(
      stored({
        configured: {
          anthropic: true,
          openai: false,
          openrouter: false,
          ollama: true,
        },
      }),
    );

    visit();

    const list = await screen.findByRole("list", {
      name: "Provider credentials",
    });
    const rows = within(list).getAllByRole("listitem");
    expect(
      rows.map((entry) => entry.querySelector(".identity-name")?.textContent),
    ).toEqual([
      "Anthropic Configured",
      "OpenAI Not set",
      "OpenRouter Not set",
      "Ollama Configured",
    ]);
    expect(
      within(rows[0]!)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Replace", "Clear"]);
    expect(
      within(rows[1]!)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Set"]);
    expect(
      within(rows[1]!)
        .getByRole("button", { name: "Set" })
        .getAttribute("aria-describedby"),
    ).toBe("ai-openai-name");
  });

  it("marks a key configured only once the api confirms it, and empties the input", async () => {
    const save = held(() =>
      respondWith(200, { provider: "anthropic", configured: true }),
    );
    const fetchMock = stubApi(stored(), {
      "PUT /api/admin/ai/providers/anthropic": save.handler,
    });
    const user = userEvent.setup();

    const { container } = visit();
    const anthropic = await row("Anthropic");
    await user.click(within(anthropic).getByRole("button", { name: "Set" }));
    const input = within(anthropic).getByLabelText("Anthropic API key");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    await user.type(input, "sk-ant-secret");
    await user.click(within(anthropic).getByRole("button", { name: "Save" }));

    expect(within(anthropic).getByRole("status").textContent).toBe(
      "Saving the Anthropic API key…",
    );
    expect(within(anthropic).getByText("Not set")).toBeDefined();
    save.release();

    expect(await within(anthropic).findByText("Configured")).toBeDefined();
    expect(within(anthropic).getByRole("status").textContent).toBe(
      "Anthropic API key saved.",
    );
    expect(within(anthropic).queryByRole("textbox")).toBeNull();
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(container.innerHTML).not.toContain("sk-ant-secret");
    expect(document.activeElement).toBe(
      within(anthropic).getByRole("button", { name: "Replace" }),
    );
    expect(
      bodiesOf(fetchMock, "PUT /api/admin/ai/providers/anthropic"),
    ).toEqual([{ apiKey: "sk-ant-secret" }]);
  });

  it("replaces a configured key, and Ollama's server URL is sent as baseUrl", async () => {
    const fetchMock = stubApi(
      stored({
        configured: {
          anthropic: false,
          openai: true,
          openrouter: false,
          ollama: false,
        },
      }),
    );
    const user = userEvent.setup();

    visit();
    const openai = await row("OpenAI");
    await user.click(within(openai).getByRole("button", { name: "Replace" }));
    await user.type(
      within(openai).getByLabelText("New OpenAI API key"),
      "sk-new",
    );
    await user.click(within(openai).getByRole("button", { name: "Save" }));
    expect(
      await within(openai).findByText("OpenAI API key saved."),
    ).toBeDefined();

    const ollama = await row("Ollama");
    await user.click(within(ollama).getByRole("button", { name: "Set" }));
    const url = within(ollama).getByLabelText("Ollama server URL");
    expect(url.getAttribute("type")).toBe("url");
    await user.type(url, "http://ollama:11434");
    await user.click(within(ollama).getByRole("button", { name: "Save" }));
    expect(await within(ollama).findByText("Configured")).toBeDefined();

    expect(bodiesOf(fetchMock, "PUT /api/admin/ai/providers/openai")).toEqual([
      { apiKey: "sk-new" },
    ]);
    expect(bodiesOf(fetchMock, "PUT /api/admin/ai/providers/ollama")).toEqual([
      { baseUrl: "http://ollama:11434" },
    ]);
  });

  it("discards a typed key on Cancel or Escape, and returns focus", async () => {
    const fetchMock = stubApi(stored());
    const user = userEvent.setup();

    visit();
    const anthropic = await row("Anthropic");
    await user.click(within(anthropic).getByRole("button", { name: "Set" }));
    await user.type(
      within(anthropic).getByLabelText("Anthropic API key"),
      "sk-typo",
    );
    await user.keyboard("{Escape}");

    const set = within(anthropic).getByRole("button", { name: "Set" });
    expect(document.activeElement).toBe(set);
    await user.click(set);
    const input = within(anthropic).getByLabelText("Anthropic API key");
    expect((input as HTMLInputElement).value).toBe("");
    await user.click(within(anthropic).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      within(anthropic).getByRole("button", { name: "Set" }),
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
  });

  it.each([
    ["the first", ["anthropic", "openai"]],
    ["the second", ["openai", "anthropic"]],
  ] as const)(
    "keeps both rows configured when two saves overlap and %s finishes first",
    async (_, order) => {
      const saves = {
        anthropic: held(() =>
          respondWith(200, { provider: "anthropic", configured: true }),
        ),
        openai: held(() =>
          respondWith(200, { provider: "openai", configured: true }),
        ),
      };
      stubApi(stored({ provider: "anthropic", model: "claude-haiku-4-5" }), {
        "PUT /api/admin/ai/providers/anthropic": saves.anthropic.handler,
        "PUT /api/admin/ai/providers/openai": saves.openai.handler,
      });
      const user = userEvent.setup();

      visit();
      const anthropic = await row("Anthropic");
      const openai = await row("OpenAI");
      await user.click(within(anthropic).getByRole("button", { name: "Set" }));
      await user.type(
        within(anthropic).getByLabelText("Anthropic API key"),
        "sk-ant-1",
      );
      await user.click(within(anthropic).getByRole("button", { name: "Save" }));
      await user.click(within(openai).getByRole("button", { name: "Set" }));
      await user.type(within(openai).getByLabelText("OpenAI API key"), "sk-1");
      await user.click(within(openai).getByRole("button", { name: "Save" }));
      expect(within(anthropic).getByText("Not set")).toBeDefined();
      expect(within(openai).getByText("Not set")).toBeDefined();

      const rows = { anthropic, openai };
      const [first, second] = order;
      saves[first].release();
      expect(await within(rows[first]).findByText("Configured")).toBeDefined();
      expect(within(rows[second]).getByText("Not set")).toBeDefined();
      saves[second].release();
      expect(await within(rows[second]).findByText("Configured")).toBeDefined();

      expect(within(anthropic).getByText("Configured")).toBeDefined();
      expect(within(openai).getByText("Configured")).toBeDefined();
      expect(document.getElementById("ai-default-provider-notice")).toBeNull();
    },
  );

  it("clears a key only after confirmation", async () => {
    const fetchMock = stubApi(
      stored({
        configured: {
          anthropic: true,
          openai: false,
          openrouter: false,
          ollama: false,
        },
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    );
    const user = userEvent.setup();

    visit();
    const anthropic = await row("Anthropic");
    await user.click(within(anthropic).getByRole("button", { name: "Clear" }));
    const confirm = within(anthropic).getByRole("group");
    expect(confirm.textContent).toContain(
      "Clear the Anthropic API key? Anything that uses Anthropic stops working until a new API key is set.",
    );
    expect(confirm.textContent).toContain(
      "Anthropic is the default provider, so AI tasks will fail until a new API key is set.",
    );
    expect(document.activeElement).toBe(
      within(confirm).getByRole("button", { name: "Clear key" }),
    );
    await user.click(within(confirm).getByRole("button", { name: "Keep key" }));
    expect(document.activeElement).toBe(
      within(anthropic).getByRole("button", { name: "Clear" }),
    );
    expect(within(anthropic).getByText("Configured")).toBeDefined();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);

    await user.click(within(anthropic).getByRole("button", { name: "Clear" }));
    await user.click(
      within(anthropic).getByRole("button", { name: "Clear key" }),
    );

    expect(
      await within(anthropic).findByText("Anthropic API key cleared."),
    ).toBeDefined();
    expect(within(anthropic).getByText("Not set")).toBeDefined();
    expect(document.activeElement).toBe(
      within(anthropic).getByRole("button", { name: "Set" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/ai/providers/anthropic",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("saves the default model and reasoning level, and shows them after a reload", async () => {
    const api = stored({
      configured: {
        anthropic: true,
        openai: false,
        openrouter: false,
        ollama: false,
      },
    });
    const fetchMock = stubApi(api);
    const user = userEvent.setup();

    visit();
    const providerSelect =
      await screen.findByLabelText<HTMLSelectElement>("Provider");
    expect(providerSelect.value).toBe("");
    expect(
      screen.getByRole("option", { name: "Choose a provider" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByLabelText<HTMLSelectElement>("Reasoning level").value,
    ).toBe("");

    await user.selectOptions(providerSelect, "Anthropic");
    expect(
      screen.getByText(
        "Exactly as Anthropic names it, for example claude-haiku-4-5.",
      ),
    ).toBeDefined();
    await user.type(screen.getByLabelText("Model id"), "claude-haiku-4-5");
    await user.selectOptions(screen.getByLabelText("Reasoning level"), "High");
    await user.click(
      within(screen.getByRole("region", { name: "Default model" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );

    expect(await screen.findByText("Default model saved.")).toBeDefined();
    expect(bodiesOf(fetchMock, "PUT /api/admin/ai/models/default")).toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        reasoningLevel: "high",
      },
    ]);

    cleanup();
    visit();
    const reloaded =
      await screen.findByLabelText<HTMLSelectElement>("Provider");
    expect(reloaded.value).toBe("anthropic");
    expect(
      screen.queryByRole("option", { name: "Choose a provider" }),
    ).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Model id").value).toBe(
      "claude-haiku-4-5",
    );
    expect(
      screen.getByLabelText<HTMLSelectElement>("Reasoning level").value,
    ).toBe("high");

    await user.selectOptions(
      screen.getByLabelText("Reasoning level"),
      "Not set",
    );
    await user.click(
      within(screen.getByRole("region", { name: "Default model" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );
    expect(await screen.findByText("Default model saved.")).toBeDefined();
    expect(
      bodiesOf(fetchMock, "PUT /api/admin/ai/models/default").at(-1),
    ).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoningLevel: null,
    });
    expect(api.reasoningLevel).toBeNull();
  });

  it("warns while the chosen default provider is not configured, and links to its Set", async () => {
    stubApi(stored());
    const user = userEvent.setup();

    visit();
    const providerSelect = await screen.findByLabelText("Provider");
    await user.selectOptions(providerSelect, "OpenAI");

    const notice = document.getElementById("ai-default-provider-notice");
    expect(notice?.textContent).toContain(
      "OpenAI isn't configured yet, so AI tasks will fail until its API key is set.",
    );
    expect(providerSelect.getAttribute("aria-describedby")).toBe(
      "ai-default-provider-notice",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(
      screen.getByRole("link", { name: "Set the OpenAI API key" }),
    );
    const openai = await row("OpenAI");
    expect(document.activeElement).toBe(
      within(openai).getByRole("button", { name: "Set" }),
    );

    await user.click(within(openai).getByRole("button", { name: "Set" }));
    await user.type(within(openai).getByLabelText("OpenAI API key"), "sk-1");
    await user.click(within(openai).getByRole("button", { name: "Save" }));
    await within(openai).findByText("Configured");
    expect(document.getElementById("ai-default-provider-notice")).toBeNull();
    expect(providerSelect.getAttribute("aria-describedby")).toBeNull();
  });

  describe("a failed save leaves everything as it was", () => {
    it("for a key", async () => {
      const api = stored();
      stubApi(api, {
        "PUT /api/admin/ai/providers/anthropic": () =>
          respondWith(500, {
            error: "internal_error",
            message: "something went wrong",
          }),
      });
      const user = userEvent.setup();

      visit();
      const anthropic = await row("Anthropic");
      await user.click(within(anthropic).getByRole("button", { name: "Set" }));
      const input = within(anthropic).getByLabelText("Anthropic API key");
      await user.type(input, "sk-ant-secret");
      await user.click(within(anthropic).getByRole("button", { name: "Save" }));

      expect((await within(anthropic).findByRole("alert")).textContent).toBe(
        "Couldn't save the Anthropic API key: something went wrong. Nothing was changed. Try again.",
      );
      expect(within(anthropic).getByText("Not set")).toBeDefined();
      expect((input as HTMLInputElement).value).toBe("sk-ant-secret");
      expect(document.activeElement).toBe(input);
    });

    it("for a clear", async () => {
      stubApi(
        stored({
          configured: {
            anthropic: true,
            openai: false,
            openrouter: false,
            ollama: false,
          },
        }),
        {
          "DELETE /api/admin/ai/providers/anthropic": () =>
            Promise.reject(new TypeError("Failed to fetch")),
        },
      );
      const user = userEvent.setup();

      visit();
      const anthropic = await row("Anthropic");
      await user.click(
        within(anthropic).getByRole("button", { name: "Clear" }),
      );
      await user.click(
        within(anthropic).getByRole("button", { name: "Clear key" }),
      );

      expect((await within(anthropic).findByRole("alert")).textContent).toBe(
        "Couldn't clear the Anthropic API key: the request failed before a response arrived. It's still saved. Try again.",
      );
      expect(within(anthropic).getByText("Configured")).toBeDefined();
      expect(document.activeElement).toBe(
        within(anthropic).getByRole("button", { name: "Clear" }),
      );
    });

    it("for the default model", async () => {
      const api = stored({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        reasoningLevel: "medium",
      });
      stubApi(api, {
        "PUT /api/admin/ai/models/default": () => respondWith(502),
      });
      const user = userEvent.setup();

      visit();
      const providerSelect =
        await screen.findByLabelText<HTMLSelectElement>("Provider");
      await user.selectOptions(providerSelect, "OpenRouter");
      const model = screen.getByLabelText<HTMLInputElement>("Model id");
      await user.clear(model);
      await user.type(model, "anthropic/claude-haiku-4.5");
      await user.selectOptions(
        screen.getByLabelText("Reasoning level"),
        "High",
      );
      const save = within(
        screen.getByRole("region", { name: "Default model" }),
      ).getByRole("button", { name: "Save" });
      await user.click(save);

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Couldn't save the default model: the server answered with HTTP 502. Nothing was changed. Try again.",
      );
      expect(providerSelect.value).toBe("openrouter");
      expect(model.value).toBe("anthropic/claude-haiku-4.5");
      expect(
        screen.getByLabelText<HTMLSelectElement>("Reasoning level").value,
      ).toBe("high");
      await waitFor(() => expect(document.activeElement).toBe(save));
      expect(api).toMatchObject({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        reasoningLevel: "medium",
      });
    });
  });

  it("says while it loads, explains a failed load and recovers on retry", async () => {
    let fail = true;
    const load = held(() =>
      fail
        ? respondWith(500, {
            error: "internal_error",
            message: "something went wrong",
          })
        : respondWith(200, {
            providers: providers.map((provider) => ({
              provider,
              configured: false,
            })),
            models: [
              {
                procedure: "default",
                provider: null,
                model: null,
                reasoningLevel: null,
              },
            ],
          }),
    );
    stubApi(stored(), { "GET /api/admin/ai": load.handler });
    const user = userEvent.setup();

    visit();
    expect(
      (await screen.findByText("Loading AI settings…")).getAttribute("role"),
    ).toBe("status");
    load.release();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't load AI settings: something went wrong. Try again.",
    );
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("list", { name: "Provider credentials" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
