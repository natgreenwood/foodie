import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IngredientForm } from "./IngredientForm";

function respondWith(status: number, body: unknown) {
  return Promise.resolve(Response.json(body, { status }));
}

const created = {
  id: 77,
  category: null,
  source: "user",
  canEdit: true,
  names: [
    { id: 1, name: "light soy sauce", locale: "en-US", isCanonical: true },
  ],
};

function renderForm(props: Partial<Parameters<typeof IngredientForm>[0]> = {}) {
  const handlers = {
    onCreated: vi.fn(),
    onCancel: vi.fn(),
    onUseExisting: vi.fn(),
  };
  render(
    <IngredientForm
      heading="New ingredient"
      defaultLocale="en-US"
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

describe("IngredientForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates an ingredient with every name and its category", async () => {
    const fetchMock = vi.fn(() => respondWith(201, created));
    vi.stubGlobal("fetch", fetchMock);
    const { onCreated } = renderForm();
    const user = userEvent.setup();

    const first = screen.getByLabelText("Name 1");
    expect(document.activeElement).toBe(first);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Remove name 1" })
        .disabled,
    ).toBe(true);

    await user.type(first, " light soy sauce ");
    await user.click(screen.getByRole("button", { name: "Add another name" }));
    const second = screen.getByLabelText("Name 2");
    expect(document.activeElement).toBe(second);
    await user.type(second, "light soy");
    await user.selectOptions(
      screen.getAllByLabelText("Language")[1]!,
      "English (UK)",
    );
    await user.type(screen.getByLabelText("Category (optional)"), "Sauces");
    await user.click(screen.getByRole("button", { name: "Create ingredient" }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ingredients",
      expect.objectContaining({ method: "POST" }),
    );
    expect(bodyOf(fetchMock)).toEqual({
      names: [
        { name: "light soy sauce", locale: "en-US" },
        { name: "light soy", locale: "en-GB" },
      ],
      category: "Sauces",
    });
  });

  it("sends no category when it is left blank", async () => {
    const fetchMock = vi.fn(() => respondWith(201, created));
    vi.stubGlobal("fetch", fetchMock);
    renderForm({
      initialNames: [{ name: "light soy sauce", locale: "en-US" }],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Create ingredient" }));

    await vi.waitFor(() =>
      expect(bodyOf(fetchMock)).toEqual({
        names: [{ name: "light soy sauce", locale: "en-US" }],
        category: null,
      }),
    );
  });

  it("asks for a name in a blank row, or for the row to go", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Create ingredient" }));

    const name = screen.getByLabelText("Name 1");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(name.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Enter a name, or remove this row.");
    expect(document.activeElement).toBe(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes a row and keeps the others", async () => {
    renderForm({
      initialNames: [
        { name: "light soy sauce", locale: "en-US" },
        { name: "light soy", locale: "en-GB" },
      ],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Remove name 1" }));

    expect(screen.getByLabelText<HTMLInputElement>("Name 1").value).toBe(
      "light soy",
    );
    expect(screen.queryByLabelText("Name 2")).toBeNull();
  });

  it("offers the ingredient that already has a name", async () => {
    vi.stubGlobal("fetch", () =>
      respondWith(409, {
        error: "name_taken",
        message: 'en-US already has the name "light soy sauce"',
        ingredient: { id: 12, name: "light soy sauce" },
        name: { name: "light soy sauce", locale: "en-US" },
      }),
    );
    const { onUseExisting, onCreated } = renderForm({
      initialNames: [{ name: "Light soy sauce", locale: "en-US" }],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Create ingredient" }));

    expect(
      await screen.findByText(
        "“Light soy sauce” is already in the catalogue for English (US).",
      ),
    ).toBeDefined();
    expect(screen.getByLabelText("Name 1").getAttribute("aria-invalid")).toBe(
      "true",
    );
    await user.click(
      screen.getByRole("button", { name: "Use light soy sauce" }),
    );
    expect(onUseExisting).toHaveBeenCalledWith({
      id: 12,
      name: "light soy sauce",
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("says when the ingredient could not be created, keeping what was typed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    renderForm({ initialNames: [{ name: "gochujang", locale: "en-US" }] });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Create ingredient" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "We couldn't create the ingredient. Check your connection and try again.",
    );
    expect(document.activeElement).toBe(alert);
    expect(screen.getByLabelText<HTMLInputElement>("Name 1").value).toBe(
      "gochujang",
    );
  });

  it("disables everything while it creates", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    renderForm({ initialNames: [{ name: "gochujang", locale: "en-US" }] });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Create ingredient" }));

    const form = screen.getByRole("form", { name: "New ingredient" });
    expect(within(form).getByRole("status").textContent).toBe(
      "Creating the ingredient…",
    );
    expect(
      within(form).getByRole<HTMLButtonElement>("button", { name: "Creating…" })
        .disabled,
    ).toBe(true);
    expect(
      within(form)
        .getByLabelText<HTMLInputElement>("Name 1")
        .closest("fieldset")?.disabled,
    ).toBe(true);
  });

  it("cancels on Cancel and on Escape", async () => {
    const { onCancel } = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.type(screen.getByLabelText("Name 1"), "{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
