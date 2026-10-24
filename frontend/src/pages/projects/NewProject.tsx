import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, currentUser, json, type UserOption } from "../../lib/api";
import { ProjectFields } from "../../components/ProjectFields";
import { Button, Field, Select } from "../../components/ui";
import { usePageTitle } from "../../lib/pageTitle";
import { emptyProjectFields, projectFieldsProblem, projectPayload, type ProjectFieldValues } from "../../lib/projectFields";

export const NewProject: React.FC = () => {
  usePageTitle("Nový projekt");
  const navigate = useNavigate();

  const [fields, setFields] = useState<ProjectFieldValues>(emptyProjectFields());
  const myId = currentUser()?.id;
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
  const someoneWithoutNumber = userOptions.some((u) => !u.hasCkait);

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
          Váš účet nemá číslo ČKAIT, takže projekt založit nemůžete: zakladatel se stává jeho stavbyvedoucím a stavbyvedoucí musí mít číslo. Číslo doplňuje administrátor (v seznamu
          uživatelů); požádejte ho o to.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        <ProjectFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}>
          {/*
            A native select (the browser's own list: it works from the keyboard and with a screen reader, and a phone shows its picker).
            The site manager signs the diary and so needs a ČKAIT number: a person without one stays in the list, disabled, with the
            reason in the option's own text, and the hint under the field says why once.
          */}
          <Field
            id="siteManagerId"
            label="Hlavní stavbyvedoucí"
            hintBelow
            hint={
              someoneWithoutNumber
                ? "Osoby bez čísla ČKAIT jsou v seznamu, ale nelze je vybrat: hlavní stavbyvedoucí podepisuje denní záznamy a musí mít číslo. Číslo doplňuje administrátor."
                : undefined
            }
          >
            <Select value={siteManagerId} onChange={(e) => setPickedId(e.target.value)}>
              <option value="">{userOptions.length === 0 ? "Žádní uživatelé k výběru" : "Vyberte stavbyvedoucího"}</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id} disabled={!u.hasCkait}>
                  {u.displayName} ({u.nickname}){u.hasCkait ? "" : " – bez čísla ČKAIT"}
                </option>
              ))}
            </Select>
          </Field>
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
