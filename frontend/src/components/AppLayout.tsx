import React from "react";
import { Link, useLocation, useNavigate, Navigate } from "react-router-dom";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
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

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    localStorage.removeItem("user");
    navigate("/login");
  };

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
      <main className="flex-1">{children}</main>
    </div>
  );
}
