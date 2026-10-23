// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUnsavedWork } from "../lib/api";
import { AppLayout } from "./AppLayout";

/**
 * The question that is asked before a page with unsaved changes is left (a link, the browser's Back button), and what happens when
 * it is asked twice in a row. The real browser behaviour (the focus, the native `<dialog>`, the history) is covered by the
 * Playwright suite: e2e/report-navigation.spec.ts.
 *
 * jsdom has `<dialog>` but not `showModal()` or `close()`: the few lines below give it the part of their behaviour that matters here.
 */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  };
});

beforeEach(() => {
  localStorage.setItem("user", JSON.stringify({ id: "u1", nickname: "ada", displayName: "Ada", isAdmin: false, mustChangePwd: false }));
  setUnsavedWork(true);
});

afterEach(() => {
  cleanup();
  setUnsavedWork(false);
  localStorage.clear();
  document.documentElement.className = "";
});

function renderApp() {
  const router = createMemoryRouter(
    [
      {
        element: <AppLayout />,
        children: [
          { path: "/a", element: <p>Stránka A</p> },
          { path: "/b", element: <p>Stránka B</p> },
        ],
      },
      { path: "/login", element: <p>Přihlášení</p> },
    ],
    { initialEntries: ["/a"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const questions = () => Array.from(document.querySelectorAll("dialog")) as HTMLDialogElement[];
const stay = () => screen.getByRole("button", { name: "Zůstat" });

describe("leaving a page with unsaved changes", () => {
  it("asks, and staying closes the question and leaves the page where it is", async () => {
    const router = renderApp();
    await act(async () => {
      await router.navigate("/b");
    });
    expect(questions()).toHaveLength(1);
    expect(questions()[0].open).toBe(true);

    await act(async () => {
      fireEvent.click(stay());
    });
    expect(questions()).toHaveLength(0);
    expect(router.state.location.pathname).toBe("/a");
  });

  it("asks again when the person leaves again before the answer 'stay' has been drawn", async () => {
    const router = renderApp();
    await act(async () => {
      await router.navigate("/b");
    });
    expect(questions()[0].open).toBe(true);

    // The answer and the next attempt to leave arrive together (a second Back press, a double click on a link): the page has not
    // drawn the first answer yet when the router blocks the second step. The question that is on the screen must be a new,
    // open one, not the closed dialog of the first answer, which nothing would ever open again.
    await act(async () => {
      fireEvent.click(stay());
      void router.navigate("/b");
    });
    const shown = questions();
    expect(shown, "one question, not the old one and a new one").toHaveLength(1);
    expect(shown[0].open, "the question is open").toBe(true);
    expect(router.state.location.pathname).toBe("/a");

    // And it works: leaving goes on.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Odejít bez uložení" }));
    });
    expect(router.state.location.pathname).toBe("/b");
    expect(questions()).toHaveLength(0);
  });
});
