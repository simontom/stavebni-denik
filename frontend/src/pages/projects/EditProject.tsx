import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, json, setUnsavedWork } from "../../lib/api";
import { ProjectFields } from "../../components/ProjectFields";
import { emptyProjectFields, projectFieldsOf, projectFieldsProblem, projectPayload, type ProjectFieldValues } from "../../lib/projectFields";

interface Loaded {
  siteManagerId: string;
  updatedAt?: string | null;
  myRole?: string | null;
}

/**
 * Changes what is entered about a project. Only the manager of the project may (the server decides; the page only avoids
 * offering what would be refused). The save carries the version the page loaded, so a change made by somebody else in the
 * meantime is refused instead of overwritten.
 */
export const EditProject: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [fields, setFields] = useState<ProjectFieldValues>(emptyProjectFields());
  const [saved, setSaved] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    let ignore = false;
    api<Record<string, unknown> & Loaded>(`/api/projects/${id}`)
      .then((project) => {
        if (ignore) return;
        const values = projectFieldsOf(project);
        setFields(values);
        setSaved(JSON.stringify(values));
        setLoaded({ siteManagerId: project.siteManagerId, updatedAt: project.updatedAt, myRole: project.myRole });
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : "Projekt se nepodařilo načíst");
      });
    return () => {
      ignore = true;
    };
  }, [id]);

  // What was typed and not yet saved: the session dialog keeps the page (and so the text) when the session lapses.
  const dirty = saved !== null && JSON.stringify(fields) !== saved;
  useEffect(() => {
    setUnsavedWork(dirty);
    return () => setUnsavedWork(false);
  }, [dirty]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loaded || saving) return;
    setError("");
    setConflict(false);
    const problem = projectFieldsProblem(fields);
    if (problem) return setError(problem);
    setSaving(true);
    try {
      await api(`/api/projects/${id}`, {
        method: "PUT",
        body: json({ ...projectPayload(fields), siteManagerId: loaded.siteManagerId, updatedAt: loaded.updatedAt ?? null }),
      });
      setUnsavedWork(false);
      navigate(`/projects/${id}`);
    } catch (err: unknown) {
      setConflict(err instanceof ApiError && err.code === "STALE_VERSION");
      setError(err instanceof Error ? err.message : "Údaje se nepodařilo uložit");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded && !error) return <div className="p-8 text-center text-gray-500">Načítání...</div>;
  if (!loaded) return <div className="p-8 text-center text-red-600">{error}</div>;
  if (loaded.myRole !== "BOSS") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div role="alert" className="rounded bg-red-100 p-3 text-red-700">
          Údaje o stavbě může měnit jen vedoucí tohoto projektu.
        </div>
        <Link to={`/projects/${id}`} className="mt-4 inline-block text-sm text-indigo-600 hover:underline">
          Zpět na projekt
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Údaje o stavbě</h1>

      {error && (
        <div role="alert" className="mb-4 rounded bg-red-100 p-3 text-red-700">
          {error}
          {conflict && (
            <div className="mt-2">
              <button type="button" onClick={() => window.location.reload()} className="rounded bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800">
                Načíst aktuální verzi
              </button>
              <span className="ml-2 text-xs">Co jste právě napsali, si před načtením zkopírujte.</span>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <ProjectFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} />

        <p className="text-xs text-gray-500">Každá změna zůstává v záznamu o změnách (audit logu) i s původní hodnotou.</p>

        <div className="flex justify-end space-x-3 border-t border-gray-200 pt-4">
          <button
            type="button"
            onClick={() => navigate(`/projects/${id}`)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Zrušit
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500"
          >
            {saving ? "Ukládám..." : "Uložit změny"}
          </button>
        </div>
      </form>
    </div>
  );
};
