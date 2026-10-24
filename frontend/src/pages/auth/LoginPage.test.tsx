// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

/**
 * The sign-in form: both fields have a label that can be SEEN (a placeholder is gone as soon as one types, and is not a label),
 * the browser and the password manager are told what each field is (`autocomplete`), and a refusal is announced.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = () =>
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );

describe("the sign-in form", () => {
  it("has visible labels tied to the fields", () => {
    open();
    for (const [name, field] of [
      ["Přihlašovací jméno", "nickname"],
      ["Heslo", "password"],
    ]) {
      const input = screen.getByLabelText(name) as HTMLInputElement;
      expect(input.name).toBe(field);
      const label = document.querySelector(`label[for="${input.id}"]`);
      expect(label, `the label of ${name}`).not.toBeNull();
      expect(label!.className, `the label of ${name} is not for screen readers only`).not.toContain("sr-only");
    }
  });

  it("tells the browser which field is the login name and which the current password", () => {
    open();
    expect((screen.getByLabelText("Přihlašovací jméno") as HTMLInputElement).autocomplete).toBe("username");
    expect((screen.getByLabelText("Heslo") as HTMLInputElement).autocomplete).toBe("current-password");
  });

  it("announces a refusal in an alert, tied to the fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 401, headers: { "Content-Type": "application/json" } })),
    );
    open();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Přihlašovací jméno"), { target: { value: "jan" } });
    fireEvent.change(screen.getByLabelText("Heslo"), { target: { value: "špatné" } });
    fireEvent.click(screen.getByRole("button", { name: "Přihlásit se" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Neplatné přihlašovací jméno nebo heslo");
    expect(screen.getByLabelText("Heslo").getAttribute("aria-describedby")).toBe(alert.id);
  });
});
