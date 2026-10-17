import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, returnPath } from "./App";
import { leaveFor } from "./router";

// Full page loads (to the api's OIDC routes and the provider) cannot happen
// in jsdom; the tests check where the page was sent instead.
vi.mock("./router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./router")>()),
  leaveFor: vi.fn(),
}));

function respondWith(status: number, body?: unknown) {
  return Promise.resolve(
    body === undefined
      ? new Response(null, { status })
      : Response.json(body, { status }),
  );
}

const sam = {
  id: 7,
  email: "sam@example.com",
  displayName: "Sam",
  locale: "en-GB",
  isAdmin: false,
};

const unauthenticated = {
  error: "unauthenticated",
  message: "sign in required",
};

const oidcOff = () => respondWith(200, { enabled: false, displayName: null });

const oidcAs = (displayName: string | null) => () =>
  respondWith(200, { enabled: true, displayName });

const oidcOn = oidcAs("Household SSO");

type Handler = (init?: RequestInit) => Promise<Response>;

// OIDC is off unless a test says otherwise.
const defaultRoutes: Record<string, Handler> = {
  "GET /api/auth/oidc/config": oidcOff,
};

// Answers each "METHOD /path" from `routes`; anything else fails the test.
function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    const handler = { ...defaultRoutes, ...routes }[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, key: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => `${init?.method ?? "GET"} ${input}` === key,
  );
  const body = call?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : undefined;
}

const health = () => respondWith(200, { status: "ok", db: "up" });

function visit(path: string) {
  window.history.replaceState(null, "", path);
  render(<App />);
}

async function signInAs(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("App", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(leaveFor).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a visitor to sign-in and back to the page they asked for", async () => {
    let signedIn = false;
    const fetchMock = stubApi({
      "GET /api/me": () =>
        signedIn ? respondWith(200, sam) : respondWith(401, unauthenticated),
      "POST /api/auth/login": () => {
        signedIn = true;
        return respondWith(200, sam);
      },
    });

    visit("/profile");

    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeDefined();
    expect(window.location.pathname + window.location.search).toBe(
      "/sign-in?next=%2Fprofile",
    );

    await signInAs("sam@example.com", "correct horse");

    expect(
      await screen.findByRole("heading", { name: "Profile" }),
    ).toBeDefined();
    expect(window.location.pathname).toBe("/profile");
    expect(screen.getByText("Signed in as Sam")).toBeDefined();
    expect(bodyOf(fetchMock, "POST /api/auth/login")).toEqual({
      email: "sam@example.com",
      password: "correct horse",
    });
  });

  it("sends the user to sign-in when a protected request answers 401, and back after", async () => {
    stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "GET /api/health": health,
      "POST /api/imports/preview": () => respondWith(401, unauthenticated),
      "POST /api/auth/login": () => respondWith(200, sam),
    });
    const user = userEvent.setup();

    visit("/");
    await user.type(
      await screen.findByLabelText("Recipe page address"),
      "https://example.com/pancakes",
    );
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeDefined();
    expect(
      screen.getByText("Your session has ended. Sign in again to carry on."),
    ).toBeDefined();
    expect(screen.queryByText(/Signed in as/)).toBeNull();

    await signInAs("sam@example.com", "correct horse");

    expect(
      await screen.findByRole("heading", { name: "Import from URL" }),
    ).toBeDefined();
    expect(window.location.pathname).toBe("/");
  });

  it("never shows a signed-in user the sign-in page", async () => {
    stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "GET /api/health": health,
    });

    visit("/sign-in?next=%2F");

    expect(
      await screen.findByRole("heading", { name: "Import from URL" }),
    ).toBeDefined();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("sends a signed-in user home when next hides another site behind a tab", async () => {
    stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "GET /api/health": health,
    });

    visit("/sign-in?next=%2F%09%2Fevil.example");

    expect(
      await screen.findByRole("heading", { name: "Import from URL" }),
    ).toBeDefined();
    expect(window.location.href).toBe(`${window.location.origin}/`);
  });

  it("explains a refused sign-in and stays on the page", async () => {
    stubApi({
      "GET /api/me": () => respondWith(401, unauthenticated),
      "POST /api/auth/login": () =>
        respondWith(401, {
          error: "invalid_credentials",
          message: "email or password is incorrect",
        }),
    });

    visit("/sign-in");
    await signInAs("sam@example.com", "wrong");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "That email and password don't match an account. Check them and try again.",
    );
    expect(window.location.pathname).toBe("/sign-in");
    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("registers, signs the new account in and returns to the page asked for", async () => {
    const fetchMock = stubApi({
      "GET /api/me": () => respondWith(401, unauthenticated),
      "POST /api/auth/register": () => respondWith(201, sam),
    });
    const user = userEvent.setup();

    visit("/profile");
    await user.click(await screen.findByRole("link", { name: "Register" }));
    expect(window.location.pathname + window.location.search).toBe(
      "/register?next=%2Fprofile",
    );

    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Display name (optional)"), " Sam ");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Register" }));

    expect(
      await screen.findByRole("heading", { name: "Profile" }),
    ).toBeDefined();
    expect(bodyOf(fetchMock, "POST /api/auth/register")).toEqual({
      email: "sam@example.com",
      password: "correct horse",
      displayName: "Sam",
    });
  });

  it("offers sign-in when the email is already registered", async () => {
    stubApi({
      "GET /api/me": () => respondWith(401, unauthenticated),
      "POST /api/auth/register": () =>
        respondWith(409, {
          error: "email_taken",
          message: "an account with this email already exists",
        }),
    });
    const user = userEvent.setup();

    visit("/register");
    await user.type(await screen.findByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Register" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "An account with that email already exists.",
    );
    await user.click(screen.getByRole("link", { name: "Sign in instead" }));
    expect(window.location.pathname).toBe("/sign-in");
  });

  it("signs out to the sign-in page, which then guards every page", async () => {
    const fetchMock = stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "GET /api/health": health,
      "POST /api/auth/logout": () => respondWith(204),
    });
    const user = userEvent.setup();

    visit("/");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeDefined();
    expect(window.location.pathname + window.location.search).toBe("/sign-in");
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.queryByText(/session has ended/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("saves the profile and shows what the api stored", async () => {
    const fetchMock = stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "PATCH /api/me": () =>
        respondWith(200, { ...sam, displayName: "Samira", locale: "en-US" }),
    });
    const user = userEvent.setup();

    visit("/profile");
    const name = await screen.findByLabelText<HTMLInputElement>("Display name");
    expect(name.value).toBe("Sam");
    expect(
      screen.getByLabelText<HTMLSelectElement>("Preferred locale").value,
    ).toBe("en-GB");
    expect(screen.getByText("sam@example.com")).toBeDefined();

    await user.clear(name);
    await user.type(name, "  Samira ");
    await user.selectOptions(
      screen.getByLabelText("Preferred locale"),
      "English (US)",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Profile saved.")).toBeDefined();
    expect(bodyOf(fetchMock, "PATCH /api/me")).toEqual({
      displayName: "Samira",
      locale: "en-US",
    });
    expect(name.value).toBe("Samira");
    expect(
      screen.getByLabelText<HTMLSelectElement>("Preferred locale").value,
    ).toBe("en-US");
    expect(screen.getByText("Signed in as Samira")).toBeDefined();
  });

  it("clears the display name when the field is emptied", async () => {
    const fetchMock = stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "PATCH /api/me": () => respondWith(200, { ...sam, displayName: null }),
    });
    const user = userEvent.setup();

    visit("/profile");
    await user.clear(await screen.findByLabelText("Display name"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Profile saved.")).toBeDefined();
    expect(bodyOf(fetchMock, "PATCH /api/me")).toEqual({
      displayName: null,
      locale: "en-GB",
    });
    expect(screen.getByText("Signed in as sam@example.com")).toBeDefined();
  });

  it("explains a refused profile change", async () => {
    stubApi({
      "GET /api/me": () => respondWith(200, sam),
      "PATCH /api/me": () =>
        respondWith(400, {
          error: "invalid_request",
          message: "displayName must be at most 100 characters",
        }),
    });
    const user = userEvent.setup();

    visit("/profile");
    await screen.findByLabelText("Display name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "DisplayName must be at most 100 characters.",
    );
  });

  it("keeps an unlisted locale selectable", async () => {
    stubApi({
      "GET /api/me": () => respondWith(200, { ...sam, locale: "fr-FR" }),
    });

    visit("/profile");

    const select =
      await screen.findByLabelText<HTMLSelectElement>("Preferred locale");
    expect(select.value).toBe("fr-FR");
  });

  it("explains when the session cannot be loaded and recovers on retry", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(() => respondWith(401, unauthenticated));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    visit("/profile");

    expect(screen.getByRole("status").textContent).toBe(
      "Checking whether you're signed in…",
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Can't reach the API: the request failed before a response arrived.",
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeDefined();
  });

  it("says when there is no page at an address", async () => {
    stubApi({ "GET /api/me": () => respondWith(200, sam) });

    visit("/nowhere");

    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeDefined();
    await waitFor(() => expect(document.title).toBe("Page not found · Foodie"));
  });
});

describe("OIDC sign-in", () => {
  const signedOut = () => respondWith(401, unauthenticated);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(leaveFor).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows nothing about OIDC on either page when it is off", async () => {
    let signedIn = false;
    const fetchMock = stubApi({
      "GET /api/me": () =>
        signedIn ? respondWith(200, sam) : respondWith(401, unauthenticated),
      "POST /api/auth/login": () => {
        signedIn = true;
        return respondWith(200, sam);
      },
    });

    visit("/sign-in?next=%2Fprofile&oidc_error=account_disabled");

    expect(await screen.findByLabelText("Email")).toBeDefined();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/oidc/config",
        expect.anything(),
      ),
    );
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    await signInAs("sam@example.com", "correct horse");
    await screen.findByRole("heading", { name: "Profile" });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input === "/api/auth/oidc/config",
        ),
      ).toHaveLength(2),
    );
    expect(
      screen.queryByRole("heading", { name: "Connected identities" }),
    ).toBeNull();
    // Only the session's own load, before signing in.
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/me"),
    ).toHaveLength(1);
  });

  it("offers single sign-on under the form, named by the api, and goes to the provider", async () => {
    stubApi({
      "GET /api/me": signedOut,
      "GET /api/auth/oidc/config": oidcOn,
    });
    const user = userEvent.setup();

    visit("/sign-in");
    const sso = await screen.findByRole("button", {
      name: "Sign in with Household SSO",
    });
    await user.click(sso);

    expect(leaveFor).toHaveBeenCalledWith("/api/auth/oidc/start");
    expect(screen.getByRole("status").textContent).toBe(
      "Taking you to Household SSO…",
    );
    expect(sso.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("calls it your identity provider when the api has no display name", async () => {
    stubApi({
      "GET /api/me": signedOut,
      "GET /api/auth/oidc/config": oidcAs(null),
    });
    const user = userEvent.setup();

    visit("/sign-in");
    await user.click(
      await screen.findByRole("button", {
        name: "Sign in with your identity provider",
      }),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Taking you to your identity provider…",
    );
  });

  it.each([
    [
      "email_unverified",
      "Household SSO",
      "An account with that email already exists. Sign in with your password, then connect Household SSO from your profile.",
    ],
    [
      "email_unverified",
      null,
      "An account with that email already exists. Sign in with your password, then connect your identity provider from your profile.",
    ],
    [
      "account_disabled",
      "Household SSO",
      "This account has been disabled. Ask an administrator to re-enable it.",
    ],
    [
      "already_connected",
      "Household SSO",
      "An account with that email is already connected to another identity at Household SSO. Sign in with your password to manage it from your profile.",
    ],
    [
      "already_connected",
      null,
      "An account with that email is already connected to another identity at your identity provider. Sign in with your password to manage it from your profile.",
    ],
    [
      "provider_error",
      "Household SSO",
      "Sign-in with Household SSO didn't complete. Try again.",
    ],
    [
      "provider_error",
      null,
      "Sign-in with your identity provider didn't complete. Try again.",
    ],
    [
      "email_mismatch",
      "Household SSO",
      "Signing in with Household SSO didn't work. Try again.",
    ],
    [
      "toString",
      "Household SSO",
      "Signing in with Household SSO didn't work. Try again.",
    ],
    [
      "something_new",
      "Household SSO",
      "Signing in with Household SSO didn't work. Try again.",
    ],
    [
      "something_new",
      null,
      "Signing in with your identity provider didn't work. Try again.",
    ],
  ])(
    "explains a refused sign-in (%s, named %s) first, and clears it on the next try",
    async (code, displayName, message) => {
      stubApi({
        "GET /api/me": signedOut,
        "GET /api/auth/oidc/config": oidcAs(displayName),
      });
      const user = userEvent.setup();

      visit(`/sign-in?oidc_error=${code}`);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(message);
      await waitFor(() => expect(document.activeElement).toBe(alert));

      await user.click(
        screen.getByRole("button", {
          name: `Sign in with ${displayName ?? "your identity provider"}`,
        }),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});

describe("Connected identities", () => {
  // GET /me as it answers with OIDC on: the profile and how it signs in.
  const me = (connected: boolean, hasPassword: boolean) => () =>
    respondWith(200, {
      ...sam,
      hasPassword,
      oidc: {
        connected,
        connectedAt: connected ? "2026-10-17T02:00:00.000Z" : null,
      },
    });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(leaveFor).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function section() {
    return screen.getByRole("region", { name: "Connected identities" });
  }

  // The provider as the api names it, and as the page then calls it.
  const providers = [
    ["Household SSO", "Household SSO"],
    [null, "your identity provider"],
  ] as const;

  it.each(providers)(
    "offers to connect when nothing is connected, as a form post to the api (named %s)",
    async (displayName, name) => {
      const fetchMock = stubApi({
        "GET /api/me": me(false, true),
        "GET /api/auth/oidc/config": oidcAs(displayName),
      });
      const user = userEvent.setup();
      let submitted: SubmitEvent | undefined;
      let preventedByApp: boolean | undefined;
      const onSubmit = (event: SubmitEvent) => {
        submitted = event;
        preventedByApp = event.defaultPrevented;
        // jsdom cannot load the next page.
        event.preventDefault();
      };
      document.addEventListener("submit", onSubmit);

      visit("/profile");
      const connect = await screen.findByRole("button", {
        name: `Connect ${name}`,
      });
      expect(section().textContent).toContain("No identity connected.");
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
      expect(connect.getAttribute("aria-describedby")).toBe("identities-hint");

      await user.click(connect);
      document.removeEventListener("submit", onSubmit);

      expect(preventedByApp).toBe(false);
      const form = submitted?.target as HTMLFormElement | undefined;
      expect(form?.method).toBe("post");
      expect(form?.getAttribute("action")).toBe("/api/auth/oidc/connect");
      expect(form?.contains(connect)).toBe(true);
      expect(new FormData(form).entries().next().done).toBe(true);
      expect(connect.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(`Taking you to ${name}…`)).toBeDefined();
      expect(
        fetchMock.mock.calls.some(([input]) => input.includes("/oidc/connect")),
      ).toBe(false);
    },
  );

  it.each([
    ["Household SSO", "Household SSO", "Household SSO"],
    [null, "Identity provider", "your identity provider"],
  ])(
    "shows the connected identity and disconnects it after a confirm (named %s)",
    async (displayName, label, name) => {
      const fetchMock = stubApi({
        "GET /api/me": me(true, true),
        "GET /api/auth/oidc/config": oidcAs(displayName),
        "DELETE /api/auth/oidc/connection": () => respondWith(204),
      });
      const user = userEvent.setup();

      visit("/profile");
      const disconnect = await screen.findByRole("button", {
        name: "Disconnect",
      });
      expect(section().querySelector("dt")?.textContent).toBe(label);
      expect(section().querySelector("dd")?.textContent).toBe(
        "sam@example.com",
      );

      await user.click(disconnect);
      const confirm = screen.getByRole("group", {
        name: `Disconnect ${name}? You'll sign in with your password only.`,
      });
      const confirmButton = screen.getByRole("button", { name: "Disconnect" });
      expect(confirm.contains(confirmButton)).toBe(true);
      expect(document.activeElement).toBe(confirmButton);

      await user.click(confirmButton);

      expect(
        (await screen.findByText(`Disconnected ${name}.`)).getAttribute("role"),
      ).toBe("status");
      const connect = screen.getByRole("button", { name: `Connect ${name}` });
      expect(document.activeElement).toBe(connect);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/oidc/connection",
        expect.objectContaining({ method: "DELETE" }),
      );
    },
  );

  it.each([
    [
      "Keep connected",
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole("button", { name: "Keep connected" })),
    ],
    [
      "Escape",
      (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}"),
    ],
  ])("backs out of the disconnect with %s", async (_, backOut) => {
    const fetchMock = stubApi({
      "GET /api/me": me(true, true),
      "GET /api/auth/oidc/config": oidcOn,
    });
    const user = userEvent.setup();

    visit("/profile");
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    await backOut(user);

    expect(screen.queryByRole("group")).toBeNull();
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(document.activeElement).toBe(disconnect));
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it.each(providers)(
    "offers no disconnect to an account with no password (named %s)",
    async (displayName, name) => {
      stubApi({
        "GET /api/me": me(true, false),
        "GET /api/auth/oidc/config": oidcAs(displayName),
      });

      visit("/profile");

      expect(
        await screen.findByText(
          `This account was created through ${name} and has no password, so it can't be disconnected.`,
        ),
      ).toBeDefined();
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    },
  );

  it.each(providers)(
    "explains when the api refuses a disconnect for want of a password (named %s)",
    async (displayName, name) => {
      stubApi({
        "GET /api/me": me(true, true),
        "GET /api/auth/oidc/config": oidcAs(displayName),
        "DELETE /api/auth/oidc/connection": () =>
          respondWith(409, {
            error: "no_local_password",
            message:
              "an account without a password cannot disconnect its sign-in provider",
          }),
      });
      const user = userEvent.setup();

      visit("/profile");
      await user.click(
        await screen.findByRole("button", { name: "Disconnect" }),
      );
      await user.click(screen.getByRole("button", { name: "Disconnect" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        `This account has no password, so ${name} can't be disconnected.`,
      );
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    },
  );

  it.each(providers)(
    "says when a connect has just succeeded (named %s)",
    async (displayName, name) => {
      stubApi({
        "GET /api/me": me(true, true),
        "GET /api/auth/oidc/config": oidcAs(displayName),
      });

      visit("/profile?oidc=connected");

      expect(
        (
          await screen.findByText(
            `Connected ${name}. You can now sign in with it.`,
          )
        ).getAttribute("role"),
      ).toBe("status");
    },
  );

  it.each([
    [
      "email_mismatch",
      "Household SSO",
      "The email Household SSO returned doesn't match this account's email. Nothing was connected.",
    ],
    [
      "email_mismatch",
      null,
      "The email your identity provider returned doesn't match this account's email. Nothing was connected.",
    ],
    [
      "already_connected",
      "Household SSO",
      "That identity at Household SSO is already connected to an account, so nothing was changed.",
    ],
    [
      "already_connected",
      null,
      "That identity at your identity provider is already connected to an account, so nothing was changed.",
    ],
    [
      "provider_error",
      "Household SSO",
      "Connecting Household SSO didn't complete. Try again.",
    ],
    [
      "provider_error",
      null,
      "Connecting your identity provider didn't complete. Try again.",
    ],
    [
      "email_unverified",
      "Household SSO",
      "Connecting Household SSO didn't work. Try again.",
    ],
    [
      "something_new",
      "Household SSO",
      "Connecting Household SSO didn't work. Try again.",
    ],
    [
      "something_new",
      null,
      "Connecting your identity provider didn't work. Try again.",
    ],
  ])(
    "explains a refused connect (%s, named %s) and moves focus to it",
    async (code, displayName, message) => {
      stubApi({
        "GET /api/me": me(false, true),
        "GET /api/auth/oidc/config": oidcAs(displayName),
      });

      visit(`/profile?oidc_error=${code}`);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(message);
      expect(section().contains(alert)).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(alert));
    },
  );

  it("explains when the connection cannot be loaded and recovers on retry", async () => {
    // The session's load succeeds; the section's first one fails.
    let calls = 0;
    stubApi({
      "GET /api/me": () =>
        ++calls === 2
          ? Promise.reject(new TypeError("Failed to fetch"))
          : me(false, true)(),
      "GET /api/auth/oidc/config": oidcOn,
    });
    const user = userEvent.setup();

    visit("/profile");
    expect(
      (await screen.findByText("Loading connected identities…")).getAttribute(
        "role",
      ),
    ).toBe("status");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't load connected identities: the request failed before a response arrived. Try again.",
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("button", { name: "Connect Household SSO" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("returnPath", () => {
  it.each([
    ["?next=%2Fprofile", "/profile"],
    ["?next=%2F%3Fa%3D1", "/?a=1"],
    ["", "/"],
    ["?next=https%3A%2F%2Fevil.example", "/"],
    ["?next=%2F%2Fevil.example", "/"],
    ["?next=%2F%5Cevil.example", "/"],
    ["?next=%2Fsign-in", "/"],
    ["?next=%2F%09%2Fevil.example", "/"],
    ["?next=%2F%0A%2Fevil.example", "/"],
    ["?next=%2F%0D%2Fevil.example", "/"],
    ["?next=javascript%3Aalert(1)", "/"],
    ["?next=%2Fprofile%23top", "/profile#top"],
  ])("%s -> %s", (search, expected) => {
    expect(returnPath(search)).toBe(expected);
  });
});
