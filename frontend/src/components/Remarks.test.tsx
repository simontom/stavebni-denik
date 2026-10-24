// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Addenda } from "./Addenda";
import { Remarks } from "./Remarks";

/**
 * Two different messages: a list that could not be loaded is a notice about the page (a banner), and says nothing about the text field;
 * a refusal of the text that was sent is the field's error (the field is invalid and described by it), and goes away when the person types.
 */
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.setItem("user", JSON.stringify({ id: "me", nickname: "admin", displayName: "Admin", role: "BOSS", isAdmin: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const cases = [
  { name: "the remarks of other persons", label: /Nový záznam/, loadFailed: "Záznamy se nepodařilo načíst", draw: () => render(<Remarks entryId="e1" role="BOSS" />), fill: true },
  { name: "the addenda", label: /Nový dodatek/, loadFailed: "Dodatky se nepodařilo načíst", draw: () => render(<Addenda entryId="e1" canWrite />), fill: false },
];

describe.each(cases)("$name", ({ label, draw, fill }) => {
  it("a list that could not be loaded is a banner, and the text field is not marked invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(500, { error: "Seznam se nepodařilo načíst" })),
    );
    draw();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Seznam se nepodařilo načíst");
    const text = screen.getByLabelText(label);
    expect(text.getAttribute("aria-invalid")).toBeNull();
    expect(text.getAttribute("aria-describedby")).toBeNull();
  });

  it("a refusal of the text is the field's error, tied to it, and typing answers it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => (init?.method === "POST" ? reply(400, { error: "Text je příliš dlouhý" }) : reply(200, []))),
    );
    draw();
    if (fill) fireEvent.change(screen.getByLabelText(/Za koho záznam pořizujete/), { target: { value: "Stavební úřad" } });
    const text = screen.getByLabelText(label);
    fireEvent.change(text, { target: { value: "Něco" } });
    fireEvent.click(screen.getByRole("button", { name: /^Přidat (záznam|dodatek)$/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Text je příliš dlouhý");
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(text.getAttribute("aria-describedby")).toBe(alert.id);

    fireEvent.change(text, { target: { value: "Něco jiného" } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(text.getAttribute("aria-invalid")).toBeNull();
  });
});
