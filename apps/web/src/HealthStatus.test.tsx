import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthStatus } from "./HealthStatus";

function respondWith(status: number, body: unknown) {
  return Promise.resolve(Response.json(body, { status }));
}

describe("HealthStatus", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks the api for its health and shows a healthy result", async () => {
    const fetchMock = vi.fn(() => respondWith(200, { status: "ok", db: "up" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<HealthStatus />);

    expect(screen.getByRole("status").textContent).toBe("Checking the API…");
    expect(await screen.findByText(/API is up and connected/)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.anything());
  });

  it("tells the user the database is down when the api reports degraded", async () => {
    vi.stubGlobal("fetch", () =>
      respondWith(503, { status: "degraded", db: "down" }),
    );

    render(<HealthStatus />);

    expect(
      await screen.findByText(/API is up but can't reach the database/),
    ).toBeDefined();
  });

  it("explains a failure and recovers when the user checks again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(() => respondWith(200, { status: "ok", db: "up" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HealthStatus />);

    expect(await screen.findByText(/Can't reach the API/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText(/API is up and connected/)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-health response as unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", () => respondWith(502, { message: "Bad Gateway" }));

    render(<HealthStatus />);

    expect(
      await screen.findByText(
        /Can't reach the API: the server answered with HTTP 502/,
      ),
    ).toBeDefined();
  });
});
