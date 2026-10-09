import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, currentUser, json, type UserOption } from "../../lib/api";
import { ProjectFields } from "../../components/ProjectFields";
import { emptyProjectFields, projectFieldsProblem, projectPayload, type ProjectFieldValues } from "../../lib/projectFields";

export const NewProject: React.FC = () => {
  const navigate = useNavigate();

  const [fields, setFields] = useState<ProjectFieldValues>(emptyProjectFields());
  const me = currentUser();
  const [siteManagerId, setSiteManagerId] = useState(me?.id ?? "");
  const [siteManagerName, setSiteManagerName] = useState(me ? `${me.displayName} (${me.nickname})` : "");
  const [showDropdown, setShowDropdown] = useState(false);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);

  useEffect(() => {
    api<UserOption[]>("/api/users/options")
      .then(setUserOptions)
      .catch(() => setUserOptions([]));
  }, []);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (!siteManagerId) throw new Error("Vyberte hlavního stavbyvedoucího");
      const problem = projectFieldsProblem(fields);
      if (problem) throw new Error(problem);
      const created = await api<{ id: string }>("/api/projects", {
        method: "POST",
        body: json({ ...projectPayload(fields), siteManagerId }),
      });
      navigate(`/projects/${created.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Chyba vytvoření projektu");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Nový projekt / zakázka</h1>

      {error && <div className="mb-4 rounded bg-red-100 p-3 text-red-700">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <ProjectFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}>
          <div className="relative">
            <label className="mb-1 block text-sm font-medium text-gray-700">Hlavní stavbyvedoucí</label>
            <button
              id="siteManagerId"
              type="button"
              onClick={() => setShowDropdown(!showDropdown)}
              className="flex w-full items-center justify-between rounded-md border border-gray-300 bg-white p-2 text-left focus:border-indigo-500 focus:ring-indigo-500"
            >
              <span>{siteManagerName || "Vyberte stavbyvedoucího"}</span>
              <span className="text-gray-400">▼</span>
            </button>
            {showDropdown && (
              <div role="listbox" className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-300 bg-white shadow-lg">
                {userOptions.length === 0 && <div className="px-4 py-2 text-sm text-gray-500">Žádní uživatelé k výběru</div>}
                {userOptions.map((u) => (
                  <div
                    key={u.id}
                    role="option"
                    aria-selected={siteManagerId === u.id}
                    onClick={() => {
                      setSiteManagerId(u.id);
                      setSiteManagerName(`${u.displayName} (${u.nickname})`);
                      setShowDropdown(false);
                    }}
                    className="cursor-pointer px-4 py-2 text-sm text-gray-900 hover:bg-indigo-50"
                  >
                    {u.displayName} ({u.nickname})
                  </div>
                ))}
              </div>
            )}
          </div>
        </ProjectFields>

        <div className="flex justify-end space-x-3 border-t border-gray-200 pt-4">
          <button type="button" onClick={() => navigate("/projects")} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Zrušit
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500"
          >
            {loading ? "Ukládám..." : "Založit zakázku"}
          </button>
        </div>
      </form>
    </div>
  );
};
