import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/auth/LoginPage";
import { Dashboard } from "./pages/Dashboard";
import { ProjectList } from "./pages/projects/ProjectList";
import { NewProject } from "./pages/projects/NewProject";
import { ProjectDetail } from "./pages/ProjectDetail";
import { DailyReport } from "./pages/DailyReport";
import { AdminUsers } from "./pages/AdminUsers";
import { AuditLogViewer } from "./pages/AuditLogViewer";
import { AppLayout } from "./components/AppLayout";
import "./index.css";

function RootRoute() {
  const userStr = typeof window !== "undefined" ? localStorage.getItem("user") : null;
  if (!userStr) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to="/projects" replace />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RootRoute />} />
        <Route
          path="/dashboard"
          element={
            <AppLayout>
              <Dashboard />
            </AppLayout>
          }
        />
        <Route
          path="/projects"
          element={
            <AppLayout>
              <ProjectList />
            </AppLayout>
          }
        />
        <Route
          path="/projects/new"
          element={
            <AppLayout>
              <NewProject />
            </AppLayout>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <AppLayout>
              <ProjectDetail />
            </AppLayout>
          }
        />
        <Route
          path="/projects/:projectId/reports/:reportId"
          element={
            <AppLayout>
              <DailyReport />
            </AppLayout>
          }
        />
        <Route
          path="/projects/:projectId/reports/new"
          element={
            <AppLayout>
              <DailyReport />
            </AppLayout>
          }
        />
        <Route
          path="/admin/users"
          element={
            <AppLayout>
              <AdminUsers />
            </AppLayout>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <AppLayout>
              <AuditLogViewer />
            </AppLayout>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
