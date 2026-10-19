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
          One row from `sm` up. On a phone it wraps into rows that all fit in 360 px: the name of the application with the logout
          button on the first row (`order`), the pages below it, the signed-in person last. The order in the markup is the
          order of the wide layout (and of the Tab key); only logout is lifted to the top on a phone, where it must be in reach.
        */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 px-4 py-1 sm:min-h-16 sm:gap-x-4 sm:px-6 lg:px-8">
          <Link to="/projects" className="order-1 flex min-h-11 items-center gap-2 text-xl font-bold text-primary-ink sm:order-none">
            🏗️ Stavební deník
          </Link>
          <nav aria-label="Hlavní" className="order-3 -mx-3 flex w-full flex-wrap sm:order-none sm:mx-0 sm:mr-auto sm:w-auto">
            {!mustChangePwd && <NavItem to="/projects">Projekty</NavItem>}
            {!mustChangePwd && user?.isAdmin && (
              <>
                <NavItem to="/admin/users">Uživatelé</NavItem>
                <NavItem to="/admin/audit">Audit log</NavItem>
              </>
            )}
          </nav>
          {/* Who is signed in, and the way to their own password: one row on a phone, the name on the right. */}
          <div className="order-4 -mx-3 flex w-full items-center justify-between gap-2 sm:order-none sm:mx-0 sm:w-auto sm:gap-4">
            {!mustChangePwd && <NavItem to="/change-password">Změnit heslo</NavItem>}
            {user && <span className="min-w-0 px-3 text-right text-sm text-ink-muted sm:px-0">{user.displayName || user.nickname}</span>}
          </div>
          <Button variant="secondary" size="sm" onClick={handleLogout} className="order-2 ml-auto sm:order-none sm:ml-0">
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
