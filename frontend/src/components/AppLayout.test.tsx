// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discardUnsavedWork, registerUnsavedWork, setUnsavedWork } from "../lib/api";
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
  discardUnsavedWork();
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

  it("asks when only the search part of the address changes (the Back button from ?tab=members to the page without it), and not for a hash", async () => {
    const router = renderApp();
    await act(async () => {
      await router.navigate("/a?tab=members");
    });
    expect(questions(), "another tab of the same page is another place").toHaveLength(1);
    expect(router.state.location.search).toBe("");

    await act(async () => {
      fireEvent.click(stay());
    });
    expect(questions()).toHaveLength(0);

    await act(async () => {
      await router.navigate("/a#top");
    });
    expect(questions(), "a hash is the same page").toHaveLength(0);
    expect(router.state.location.hash).toBe("#top");
  });

  it("says in the question what the dialog that is open would lose, when it said so", async () => {
    discardUnsavedWork();
    registerUnsavedWork({ message: "Dočasné heslo se už nikdy nezobrazí." });
    const router = renderApp();
    await act(async () => {
      await router.navigate("/b");
    });
    expect(questions()).toHaveLength(1);
    expect(questions()[0].textContent).toContain("Dočasné heslo se už nikdy nezobrazí.");
    expect(questions()[0].textContent, "instead of the general words").not.toContain("Stránka má neuložené změny");
  });
});

describe("closing or reloading the tab (beforeunload)", () => {
  /** What the browser does: the event goes to the window, and the page may cancel it to make the browser ask. */
  function closeTab(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("is cancelled, so the browser asks, while the page holds unsaved work, and not when it holds none", () => {
    renderApp();
    expect(closeTab(), "the page's own slot").toBe(true);
    setUnsavedWork(false);
    expect(closeTab(), "nothing unsaved").toBe(false);

    const dialog = registerUnsavedWork();
    expect(closeTab(), "a dialog that holds text, or a password that was not handed over").toBe(true);
    dialog();
    expect(closeTab()).toBe(false);
  });

  it("is not asked about any more once the page is gone (the layout takes its handler away)", () => {
    const { unmount } = render(
      <RouterProvider router={createMemoryRouter([{ element: <AppLayout />, children: [{ path: "/a", element: <p>A</p> }] }], { initialEntries: ["/a"] })} />,
    );
    expect(closeTab()).toBe(true);
    unmount();
    expect(closeTab()).toBe(false);
  });
});
