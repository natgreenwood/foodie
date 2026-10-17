import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, returnPath } from "./App";

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

type Handler = (init?: RequestInit) => Promise<Response>;

// Answers each "METHOD /path" from `routes`; anything else fails the test.
function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    const handler = routes[key];
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
