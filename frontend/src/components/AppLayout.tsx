import { useState } from "react";
import { Link, Outlet, useBlocker, useLocation, useNavigate, Navigate } from "react-router-dom";
import { hasUnsavedWork, setUnsavedWork, unsavedWorkIsKeptAsDraft } from "../lib/api";
import { clearAllDrafts, browserStorage } from "../lib/draftStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionExpiredDialog } from "./SessionExpiredDialog";

/** The frame of every page after sign-in (a layout route: the page is its `<Outlet />`). */
export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  // A link inside the application (or the browser's Back button) away from a page with unsaved changes asks first. The
  // page says it has unsaved work (setUnsavedWork); a page that is only reloaded or closed is covered by the browser's own question.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsavedWork() && currentLocation.pathname !== nextLocation.pathname);
  const userStr = typeof window !== "undefined" ? localStorage.getItem("user") : null;
  if (!userStr) {
    return <Navigate to="/login" replace />;
  }
  const user = userStr ? JSON.parse(userStr) : null;
  // The server refuses everything else while the password is temporary; do not even offer it.
  const mustChangePwd = user?.mustChangePwd === true;
  if (mustChangePwd && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  const logout = async () => {
    // Confirmed, or nothing to lose: the leave guard must let the redirect to the login page through.
    setUnsavedWork(false);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    // Drafts hold personal data (the names of the people on site): none stays on a device after a logout.
    clearAllDrafts(browserStorage());
    localStorage.removeItem("user");
    navigate("/login");
  };
  const handleLogout = () => (hasUnsavedWork() ? setConfirmingLogout(true) : void logout());

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center space-x-8">
              <Link to="/projects" className="flex items-center gap-2 text-xl font-bold text-indigo-600">
                🏗️ Stavební deník
              </Link>
              <nav aria-label="Hlavní" className="flex space-x-4">
                {!mustChangePwd && (
                  <Link to="/projects" className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-indigo-600">
                    Projekty
                  </Link>
                )}
                {!mustChangePwd && user?.isAdmin && (
                  <>
                    <Link to="/admin/users" className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-indigo-600">
                      Uživatelé
                    </Link>
                    <Link to="/admin/audit" className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-indigo-600">
                      Audit log
                    </Link>
                  </>
                )}
              </nav>
            </div>
            <div className="flex items-center space-x-4">
              {user && <span className="text-sm text-gray-600">{user.displayName || user.nickname}</span>}
              {!mustChangePwd && (
                <Link to="/change-password" className="text-sm text-gray-500 hover:text-gray-700">
                  Změnit heslo
                </Link>
              )}
              <button type="button" onClick={handleLogout} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700">
                Odhlásit se
              </button>
            </div>
          </div>
        </div>
      </header>
      <SessionExpiredDialog />
      <main className="flex-1">
        <Outlet />
      </main>
      {blocker.state === "blocked" && (
        <ConfirmDialog title="Neuložené změny" cancelLabel="Zůstat" confirmLabel="Odejít bez uložení" onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()}>
          {unsavedWorkIsKeptAsDraft()
            ? "Tento záznam má neuložené změny. Když odejdete, rozepsaný text zůstane jako koncept v tomto zařízení a při dalším otevření dne vám ho nabídneme."
            : "Stránka má neuložené změny. Když odejdete, ztratí se."}
        </ConfirmDialog>
      )}
      {confirmingLogout && (
        <ConfirmDialog
          title="Odhlásit se?"
          cancelLabel="Zůstat"
          confirmLabel="Odhlásit a zahodit změny"
          onCancel={() => setConfirmingLogout(false)}
          onConfirm={() => {
            setConfirmingLogout(false);
            void logout();
          }}
        >
          Stránka má neuložené změny. Po odhlášení se ztratí{unsavedWorkIsKeptAsDraft() ? ", i s konceptem uloženým v tomto zařízení" : ""}.
        </ConfirmDialog>
      )}
    </div>
  );
}
