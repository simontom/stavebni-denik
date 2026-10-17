import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { LoginPage } from "./pages/auth/LoginPage";
import { ChangePasswordPage } from "./pages/auth/ChangePasswordPage";
import { ProjectList } from "./pages/projects/ProjectList";
import { NewProject } from "./pages/projects/NewProject";
import { EditProject } from "./pages/projects/EditProject";
import { ProjectDetail } from "./pages/ProjectDetail";
import { DailyReportPage } from "./pages/DailyReport";
import { AdminUsers } from "./pages/AdminUsers";
import { AuditLogViewer } from "./pages/AuditLogViewer";
import { AppLayout } from "./components/AppLayout";
import { currentUser } from "./lib/api";
import { browserStorage, pruneDrafts } from "./lib/draftStore";
import "./index.css";

export function RootRoute() {
  const userStr = typeof window !== "undefined" ? localStorage.getItem("user") : null;
  if (!userStr) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to="/projects" replace />;
}

// When the application starts: drafts of daily entries that are older than 30 days, unreadable, or not the signed-in
// person's are removed (they hold the names of people on site). Never allowed to stop the application from starting.
try {
  pruneDrafts(browserStorage(), { signedInUserId: currentUser()?.id ?? null });
} catch {
  // the application works without drafts
}

// A data router (not <BrowserRouter>): only it can block a navigation (useBlocker), which the pages with unsaved
// work need (AppLayout asks before they are left).
const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/", element: <RootRoute /> },
  {
    element: <AppLayout />,
    children: [
      { path: "/change-password", element: <ChangePasswordPage /> },
      { path: "/projects", element: <ProjectList /> },
      { path: "/projects/new", element: <NewProject /> },
      { path: "/projects/:id/edit", element: <EditProject /> },
      { path: "/projects/:id", element: <ProjectDetail /> },
      // The same page for every day: it is mounted per day (DailyReportPage), so one day's text never ends up in another.
      { path: "/projects/:projectId/reports/:reportId", element: <DailyReportPage /> },
      { path: "/projects/:projectId/reports/new", element: <DailyReportPage /> },
      { path: "/admin/users", element: <AdminUsers /> },
      { path: "/admin/audit", element: <AuditLogViewer /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
