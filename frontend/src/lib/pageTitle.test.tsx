// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../pages/auth/LoginPage";
import { ChangePasswordPage } from "../pages/auth/ChangePasswordPage";
import { pageTitle, usePageTitle } from "./pageTitle";

/**
 * Every page has a `<title>` of its own (WCAG 2.4.2: it is what a screen reader reads first, what a tab shows and what a history
 * entry says). One rule: the most specific part first, the name of the application last, joined by an en dash.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.title = "";
});

describe("pageTitle", () => {
  it("puts the page first and the name of the application last", () => {
    expect(pageTitle("Přihlášení")).toBe("Přihlášení – Stavební deník");
    expect(pageTitle("Záznam č. 5 / 28. 9. 2026", "Hala Brno")).toBe("Záznam č. 5 / 28. 9. 2026 – Hala Brno – Stavební deník");
  });

  it("is the name of the application alone when no part is known (yet)", () => {
    expect(pageTitle()).toBe("Stavební deník");
    expect(pageTitle(null, undefined, "  ")).toBe("Stavební deník");
  });

  it("leaves out the parts that are not known and trims the others", () => {
    expect(pageTitle(undefined, "  Hala Brno ")).toBe("Hala Brno – Stavební deník");
  });
});

function Probe({ parts }: { parts: (string | null)[] }) {
  usePageTitle(...parts);
  return <p>probe</p>;
}

describe("usePageTitle", () => {
  it("sets the title when the page is drawn and changes it when the parts change", () => {
    const { rerender } = render(<Probe parts={["Projekty"]} />);
    expect(document.title).toBe("Projekty – Stavební deník");
    rerender(<Probe parts={["Hala Brno"]} />);
    expect(document.title).toBe("Hala Brno – Stavební deník");
  });
});

function open(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <LoginPage /> },
      { path: "/change-password", element: <ChangePasswordPage /> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe("the pages that are not behind a sign-in", () => {
  it("the login page", () => {
    open("/login");
    expect(screen.getByRole("heading", { name: "Stavební deník" })).toBeTruthy();
    expect(document.title).toBe("Přihlášení – Stavební deník");
  });

  it("the change-password page", () => {
    localStorage.setItem("user", JSON.stringify({ id: "u", nickname: "a", displayName: "A", role: "BOSS", isAdmin: false }));
    open("/change-password");
    expect(document.title).toBe("Změna hesla – Stavební deník");
  });
});
