import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, currentUser, json, type UserOption } from "../../lib/api";
import { ProjectFields } from "../../components/ProjectFields";
import { Button } from "../../components/ui";
import { emptyProjectFields, projectFieldsProblem, projectPayload, type ProjectFieldValues } from "../../lib/projectFields";

export const NewProject: React.FC = () => {
  const navigate = useNavigate();

  const [fields, setFields] = useState<ProjectFieldValues>(emptyProjectFields());
  const myId = currentUser()?.id;
  const [showDropdown, setShowDropdown] = useState(false);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);

  useEffect(() => {
    api<UserOption[]>("/api/users/options")
      .then(setUserOptions)
      .catch(() => setUserOptions([]));
  }, []);

  // Who the person picked; null until they pick. The creator is the usual site manager, so they are preselected: but only when
  // they hold a ČKAIT number, which the list tells. Otherwise nothing is selected (a selected person that the list itself
  // shows as unavailable would be a trap).
  const [pickedId, setPickedId] = useState<string | null>(null);
  const mine = userOptions.find((u) => u.id === myId);
  const siteManagerId = pickedId ?? (mine?.hasCkait ? mine.id : "");
  const siteManager = userOptions.find((u) => u.id === siteManagerId);
  const siteManagerName = siteManager ? `${siteManager.displayName} (${siteManager.nickname})` : "";

  // The creator becomes a manager of the project too, so they need a ČKAIT number as well (the server refuses otherwise).
  const myNumberMissing = mine !== undefined && !mine.hasCkait;

  const [error, setError] = useState("");
  // The form is long: an error is brought into view, also when it is the same text as the last one.
  const errorBox = useRef<HTMLDivElement | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const showError = (message: string) => {
    setError(message);
    setErrorTick((tick) => tick + 1);
  };
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [error, errorTick]);
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
      showError(err instanceof Error ? err.message : "Chyba vytvoření projektu");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Nový projekt / zakázka</h1>

      {error && (
        <div ref={errorBox} role="alert" className="mb-4 rounded bg-red-100 p-3 text-red-700">
          {error}
        </div>
      )}

      {myNumberMissing && (
        <div role="status" className="mb-4 rounded bg-amber-100 p-3 text-sm text-amber-900">
          Váš účet nemá číslo ČKAIT, takže projekt založit nemůžete: zakladatel se stává jeho vedoucím a vedoucí musí mít číslo. Číslo doplňuje administrátor (v seznamu uživatelů);
          požádejte ho o to.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
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
                {userOptions.map((u) =>
                  u.hasCkait ? (
                    <div
                      key={u.id}
                      role="option"
                      aria-selected={siteManagerId === u.id}
                      onClick={() => {
                        setPickedId(u.id);
                        setShowDropdown(false);
                      }}
                      className="cursor-pointer px-4 py-2 text-sm text-gray-900 hover:bg-indigo-50"
                    >
                      {u.displayName} ({u.nickname})
                    </div>
                  ) : (
                    // The site manager signs the diary and so needs a ČKAIT number: shown, but not to be picked, with the reason.
                    <div key={u.id} role="option" aria-selected={false} aria-disabled="true" className="cursor-not-allowed px-4 py-2 text-sm text-gray-500">
                      {u.displayName} ({u.nickname}) <span className="text-xs">– bez čísla ČKAIT, stavbyvedoucím být nemůže</span>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </ProjectFields>

        <div className="flex flex-col-reverse gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => navigate("/projects")}>
            Zrušit
          </Button>
          <Button type="submit" disabled={loading || myNumberMissing}>
            {loading ? "Ukládám..." : "Založit zakázku"}
          </Button>
        </div>
      </form>
    </div>
  );
};
