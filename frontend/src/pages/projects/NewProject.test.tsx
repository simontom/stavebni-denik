// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProject } from "./NewProject";

/**
 * The site manager of a new project is chosen in a native `<select>`: it has a label, it is the browser's own list (the keyboard, a
 * screen reader and a phone's picker work, which the custom dropdown it replaces did not), and a person who cannot be a site manager
 * (no ČKAIT number) is in the list but disabled, with the reason in the option and a hint under the field.
 */
const people = [
  { id: "me", nickname: "admin", displayName: "Admin", role: "BOSS", hasCkait: true },
  { id: "p2", nickname: "dvorak", displayName: "Karel Dvořák", role: "BOSS", hasCkait: true },
  { id: "p3", nickname: "worker", displayName: "Jan Dělník", role: "WORKER", hasCkait: false },
];

function serve(users: typeof people) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/users/options" ? users : {}), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
}

function open() {
  return render(
    <MemoryRouter>
      <NewProject />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.setItem("user", JSON.stringify({ id: "me", nickname: "admin", displayName: "Admin", role: "BOSS", isAdmin: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the site manager picker", () => {
  it("is a native select with a label, and the creator (who holds a number) is chosen at the start", async () => {
    serve(people);
    open();
    const select = (await screen.findByLabelText("Hlavní stavbyvedoucí")) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    await screen.findByRole("option", { name: "Karel Dvořák (dvorak)" });
    expect(select.value).toBe("me");
    expect(screen.queryByRole("listbox"), "no custom list").toBeNull();
  });

  it("lists a person without a ČKAIT number, disabled, with the reason in the option and a hint under the field", async () => {
    serve(people);
    open();
    const select = (await screen.findByLabelText("Hlavní stavbyvedoucí")) as HTMLSelectElement;
    const without = (await screen.findByRole("option", { name: /Jan Dělník/ })) as HTMLOptionElement;
    expect(without.disabled).toBe(true);
    expect(without.textContent).toContain("bez čísla ČKAIT");
    expect((screen.getByRole("option", { name: "Karel Dvořák (dvorak)" }) as HTMLOptionElement).disabled, "a person with a number can be chosen").toBe(false);

    const hint = document.getElementById(select.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toMatch(/Osoby bez čísla ČKAIT jsou v seznamu, ale nelze je vybrat/);
    // under the field, not above it
    expect(select.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("chooses somebody else when the person does, and has nothing chosen for a creator without a number", async () => {
    serve(people);
    const first = open();
    const select = (await screen.findByLabelText("Hlavní stavbyvedoucí")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Karel Dvořák (dvorak)" });
    fireEvent.change(select, { target: { value: "p2" } });
    expect(select.value).toBe("p2");
    first.unmount();

    // the creator holds no number: nobody is chosen (a chosen person that the list itself shows as unavailable would be a trap)
    serve(people.map((p) => (p.id === "me" ? { ...p, hasCkait: false } : p)));
    open();
    const other = (await screen.findByLabelText("Hlavní stavbyvedoucí")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Karel Dvořák (dvorak)" });
    expect(other.value).toBe("");
    expect(within(other).getByRole("option", { name: "Vyberte stavbyvedoucího" })).toBeTruthy();
  });
});
