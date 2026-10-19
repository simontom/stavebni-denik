import { useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useBlocker, useLocation, useNavigate, Navigate } from "react-router-dom";
import { hasUnsavedWork, setUnsavedWork, unsavedWorkIsKeptAsDraft } from "../lib/api";
import { clearAllDrafts, browserStorage } from "../lib/draftStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionExpiredDialog } from "./SessionExpiredDialog";
import { Button } from "./ui/Button";

/** A link of the main navigation; the page that is open says `aria-current="page"` (NavLink) and is set apart by more than colour. */
function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-neutral-soft hover:text-primary-ink ${isActive ? "font-semibold text-primary-ink underline decoration-2 underline-offset-8" : "font-medium text-ink"}`
      }
    >
      {children}
    </NavLink>
  );
}

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
    <div className="flex min-h-screen flex-col bg-page">
      <header className="border-b border-line bg-surface">
        {/*
          A grid, so that every part has its place at every width and logout never wraps away from the top right corner:
            - under 640 px: the name of the application and logout on the first row, the pages on the second, the way to one's
              own password and the signed-in person on the third;
            - 640 to 1023 px: the first row as above, the pages on the left of the second row, the person on the right of it;
            - from 1024 px: all of it in one row.
          The order in the markup is the order of the one row (and of the Tab key); only the grid lifts logout to the top.
        */}
        <div className="mx-auto grid max-w-7xl grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-1 sm:px-6 lg:min-h-16 lg:grid-cols-[auto_1fr_auto_auto] lg:px-8">
          <Link to="/projects" className="col-start-1 row-start-1 flex min-h-11 items-center gap-2 text-xl font-bold text-primary-ink">
            🏗️ Stavební deník
          </Link>
          <nav aria-label="Hlavní" className="col-span-2 row-start-2 -mx-3 flex flex-wrap sm:col-span-1 sm:col-start-1 lg:col-start-2 lg:row-start-1 lg:mx-0">
            {!mustChangePwd && <NavItem to="/projects">Projekty</NavItem>}
            {!mustChangePwd && user?.isAdmin && (
              <>
                <NavItem to="/admin/users">Uživatelé</NavItem>
                <NavItem to="/admin/audit">Audit log</NavItem>
              </>
            )}
          </nav>
          {/* Who is signed in, and the way to their own password. */}
          <div className="col-span-2 row-start-3 -mx-3 flex items-center justify-between gap-2 sm:col-span-1 sm:col-start-2 sm:row-start-2 sm:justify-end lg:col-start-3 lg:row-start-1 lg:mx-0 lg:gap-4">
            {!mustChangePwd && <NavItem to="/change-password">Změnit heslo</NavItem>}
            {user && <span className="max-w-[14rem] min-w-0 truncate px-3 text-right text-sm text-ink-muted lg:px-0">{user.displayName || user.nickname}</span>}
          </div>
          <Button variant="secondary" size="sm" onClick={handleLogout} className="col-start-2 row-start-1 lg:col-start-4">
            Odhlásit se
          </Button>
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
