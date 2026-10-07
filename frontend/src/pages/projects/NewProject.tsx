import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, currentUser, json, type UserOption } from "../../lib/api";

export const NewProject: React.FC = () => {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [cadastralArea, setCadastralArea] = useState("");
  const [parcelNumbers, setParcelNumbers] = useState("");
  const [builder, setBuilder] = useState("");
  const [contractor, setContractor] = useState("");
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

  // Legislative fields
  const [contractNumber, setContractNumber] = useState("");
  const [contractDate, setContractDate] = useState("");
  const [designDocVersion, setDesignDocVersion] = useState("");
  const [designDocDate, setDesignDocDate] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (!siteManagerId) throw new Error("Vyberte hlavního stavbyvedoucího");
      const created = await api<{ id: string }>("/api/projects", {
        method: "POST",
        body: json({
          name,
          address,
          cadastralArea,
          parcelNumbers,
          builder,
          contractor,
          siteManagerId,
          contractNumber: contractNumber || null,
          contractDate: contractDate || null,
          designDocVersion: designDocVersion || null,
          designDocDate: designDocDate || null,
        }),
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Název stavby</label>
            <input
              name="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Místo stavby / Adresa</label>
            <input
              name="address"
              type="text"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Katastrální území</label>
            <input
              name="cadastralArea"
              type="text"
              required
              value={cadastralArea}
              onChange={(e) => setCadastralArea(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Parcelní čísla</label>
            <input
              name="parcelNumbers"
              type="text"
              required
              value={parcelNumbers}
              onChange={(e) => setParcelNumbers(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Stavebník (Objednatel)</label>
            <input
              name="builder"
              type="text"
              required
              value={builder}
              onChange={(e) => setBuilder(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Zhotovitel</label>
            <input
              name="contractor"
              type="text"
              required
              value={contractor}
              onChange={(e) => setContractor(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

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
        </div>

        <div className="mt-4 border-t border-gray-200 pt-4">
          <h2 className="text-md mb-3 font-semibold text-gray-800">Legislativní náležitosti (Smlouva a dokumentace)</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Číslo smlouvy</label>
              <input
                name="contractNumber"
                type="text"
                placeholder="např. SML-123"
                value={contractNumber}
                onChange={(e) => setContractNumber(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Datum smlouvy</label>
              <input
                name="contractDate"
                type="date"
                value={contractDate}
                onChange={(e) => setContractDate(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Verze projektové dokumentace</label>
              <input
                name="designDocVersion"
                type="text"
                placeholder="např. v1.2"
                value={designDocVersion}
                onChange={(e) => setDesignDocVersion(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Datum projektové dokumentace</label>
              <input
                name="designDocDate"
                type="date"
                value={designDocDate}
                onChange={(e) => setDesignDocDate(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
          </div>
        </div>

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
