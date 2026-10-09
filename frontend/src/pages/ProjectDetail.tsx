import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, apiFetch, currentUser, json, ROLE_LABELS, type UserOption } from "../lib/api";
import { pragueToday } from "../lib/dates";

interface Meter {
  medium: string;
  serialNumber: string;
  state: string;
}

interface Handover {
  id: string;
  type: string;
  date: string;
  participants: string;
  meterStates?: Meter[] | null;
  notes?: string | null;
  signedAt?: string | null;
}

interface AuthorizedPerson {
  id: string;
  name: string;
  company?: string | null;
  authorization?: string | null;
  revokedAt?: string | null;
}

/** How many entries one request asks for (the server's default page; its maximum is 1000). */
const REPORT_PAGE_SIZE = 400;

interface ProjectMember {
  userId: string;
  nickname: string;
  displayName: string;
  role: string;
}

interface ProjectData {
  id: string;
  name: string;
  address: string;
  cadastralArea: string;
  parcelNumbers: string;
  builder: string;
  contractor: string;
  siteManagerId: string;
  /** The role the signed-in user holds in this project; null for an administrator who is not a member. */
  myRole?: string | null;
  permitNumber?: string | null;
  contractNumber?: string | null;
  contractDate?: string | null;
  designDocVersion?: string | null;
  designDocDate?: string | null;
}

interface ReportItem {
  id: string;
  date: string;
  workDescription?: string;
  isSigned?: boolean;
}

const today = pragueToday;
const formatDate = (iso?: string | null) => (iso ? iso.split("T")[0] : "");

export const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const tab = searchParams.get("tab") || "overview";

  const [project, setProject] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Reports
  const [reports, setReports] = useState<ReportItem[]>([]);
  // The server sends the entries a page at a time (newest day first); a full page means there may be older ones.
  const [hasMoreReports, setHasMoreReports] = useState(false);
  const [newReportDate, setNewReportDate] = useState(today());

  // Handovers
  const [handovers, setHandovers] = useState<Handover[]>([]);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [handoverType, setHandoverType] = useState("Předání staveniště zhotoviteli");
  const [handoverDate, setHandoverDate] = useState(today());
  const [handoverParticipants, setHandoverParticipants] = useState("");
  const [meters, setMeters] = useState<Meter[]>([]);
  const [handoverNotes, setHandoverNotes] = useState("");

  // Authorized persons
  const [authorizedPersons, setAuthorizedPersons] = useState<AuthorizedPerson[]>([]);
  const [showPersonModal, setShowPersonModal] = useState(false);
  const [personName, setPersonName] = useState("");
  const [personCompany, setPersonCompany] = useState("");
  const [personAuth, setPersonAuth] = useState("");

  // Members
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  // Members and authorized persons are managed by the project's manager (the role held in THIS project) or an administrator.
  const canManage = project?.myRole === "BOSS" || Boolean(currentUser()?.isAdmin);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState("INVESTOR");
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showRoleDropdown, setShowRoleDropdown] = useState(false);

  const fail = (err: unknown, fallback: string) => setError(err instanceof Error ? err.message : fallback);

  useEffect(() => {
    if (!id) return;
    let ignore = false;
    Promise.all([
      api<ProjectData>(`/api/projects/${id}`),
      api<ReportItem[]>(`/api/projects/${id}/reports?limit=${REPORT_PAGE_SIZE}`),
      api<Handover[]>(`/api/projects/${id}/handovers`),
      api<AuthorizedPerson[]>(`/api/projects/${id}/authorized-persons`),
      api<ProjectMember[]>(`/api/projects/${id}/members`),
    ])
      .then(([p, r, h, ap, m]) => {
        if (ignore) return;
        setProject(p);
        setReports(r);
        setHasMoreReports(r.length >= REPORT_PAGE_SIZE);
        setHandovers(h);
        setAuthorizedPersons(ap);
        setMembers(m);
        setError("");
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : "Projekt se nepodařilo načíst");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [id]);

  useEffect(() => {
    // Only project managers may list users; others simply get an empty picker.
    api<UserOption[]>("/api/users/options")
      .then(setUserOptions)
      .catch(() => setUserOptions([]));
  }, []);

  const handleLoadOlderReports = async () => {
    try {
      const older = await api<ReportItem[]>(`/api/projects/${id}/reports?limit=${REPORT_PAGE_SIZE}&offset=${reports.length}`);
      setReports((current) => [...current, ...older]);
      setHasMoreReports(older.length >= REPORT_PAGE_SIZE);
    } catch (err) {
      fail(err, "Starší záznamy se nepodařilo načíst");
    }
  };

  /** The PDF of one entry; without an argument, of the newest one. */
  const handleDownloadPdf = async (entry?: ReportItem) => {
    const target = entry ?? reports[0];
    if (!target) {
      setError("Projekt zatím nemá žádný denní záznam");
      return;
    }
    try {
      const res = await apiFetch(`/api/reports/${target.id}/pdf`);
      if (!res.ok) {
        // Show the server's own explanation (for example "Export do PDF není na serveru dostupný").
        let message = "Chyba při stahování PDF";
        try {
          const body = await res.json();
          if (body && typeof body.error === "string") message = body.error;
        } catch {
          // the body was not JSON
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stavebni-denik-${target.date}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      fail(err, "Chyba při stahování PDF");
    }
  };

  const openHandoverModal = () => {
    setHandoverType("Předání staveniště zhotoviteli");
    setHandoverDate(today());
    setHandoverParticipants("");
    setMeters([]);
    setHandoverNotes("");
    setShowHandoverModal(true);
  };

  const updateMeter = (idx: number, patch: Partial<Meter>) => setMeters((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));

  const handleSaveHandover = async () => {
    try {
      const created = await api<Handover>(`/api/projects/${id}/handovers`, {
        method: "POST",
        body: json({
          projectId: id,
          type: handoverType,
          date: handoverDate,
          participants: handoverParticipants,
          meterStates: meters.filter((m) => m.medium || m.serialNumber || m.state),
          notes: handoverNotes || null,
        }),
      });
      setHandovers((prev) => [created, ...prev]);
      setShowHandoverModal(false);
    } catch (err) {
      fail(err, "Předání se nepodařilo uložit");
    }
  };

  const handleSignHandover = async (hId: string) => {
    if (!window.confirm("Opravdu podepsat předání?")) return;
    try {
      const signed = await api<Handover>(`/api/handovers/${hId}/sign`, { method: "POST" });
      setHandovers((prev) => prev.map((h) => (h.id === hId ? signed : h)));
    } catch (err) {
      fail(err, "Podpis se nezdařil");
    }
  };

  const openPersonModal = () => {
    setPersonName("");
    setPersonCompany("");
    setPersonAuth("");
    setShowPersonModal(true);
  };

  const handleSavePerson = async () => {
    try {
      const created = await api<AuthorizedPerson>(`/api/projects/${id}/authorized-persons`, {
        method: "POST",
        body: json({ name: personName, company: personCompany || null, authorization: personAuth || null }),
      });
      setAuthorizedPersons((prev) => [...prev, created]);
      setShowPersonModal(false);
    } catch (err) {
      fail(err, "Pověřenou osobu se nepodařilo uložit");
    }
  };

  const handleRevokePerson = async (pId: string) => {
    if (!window.confirm("Opravdu chcete pověřenou osobu zrušit?")) return;
    try {
      const revoked = await api<AuthorizedPerson>(`/api/authorized-persons/${pId}/revoke`, { method: "POST" });
      setAuthorizedPersons((prev) => prev.map((p) => (p.id === pId ? revoked : p)));
    } catch (err) {
      fail(err, "Zrušení se nezdařilo");
    }
  };

  const handleAddMember = async () => {
    if (!selectedUserId) {
      setError("Vyberte uživatele");
      return;
    }
    try {
      setMembers(
        await api<ProjectMember[]>(`/api/projects/${id}/members`, {
          method: "POST",
          body: json({ userId: selectedUserId, role: selectedRole }),
        }),
      );
      setError("");
    } catch (err) {
      fail(err, "Člena se nepodařilo přidat");
    }
  };

  const selectedUser = userOptions.find((u) => u.id === selectedUserId);

  if (loading) return <div className="p-8 text-center text-gray-500">Načítání detailu projektu...</div>;
  if (!project) return <div className="p-8 text-center text-red-600">{error || "Projekt nenalezen"}</div>;

  const tabClass = (name: string) =>
    `border-b-2 px-1 pb-4 text-sm font-medium ${tab === name ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"}`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Project Header */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col items-start justify-between md:flex-row md:items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{project.name}</h1>
            <p className="mt-1 text-gray-600">{project.address}</p>
          </div>
          <div className="mt-4 flex gap-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm md:mt-0">
            {project.contractNumber && (
              <div>
                <span className="block text-xs text-gray-500">Číslo smlouvy:</span>
                <span className="font-semibold text-gray-900">{project.contractNumber}</span>
              </div>
            )}
            {project.designDocVersion && (
              <div>
                <span className="block text-xs text-gray-500">Dokumentace:</span>
                <span className="font-semibold text-gray-900">{project.designDocVersion}</span>
              </div>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mt-6 flex space-x-8 border-b border-gray-200">
          <Link to={`/projects/${id}`} className={tabClass("overview")}>
            Přehled
          </Link>
          <Link to={`/projects/${id}?tab=reports`} className={tabClass("reports")}>
            Záznamy
          </Link>
          <Link to={`/projects/${id}?tab=handovers`} className={tabClass("handovers")}>
            Předání staveniště
          </Link>
          <Link to={`/projects/${id}?tab=members`} className={tabClass("members")}>
            Členové
          </Link>
        </div>
      </div>

      {error && <div className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      {/* Tab 1: Overview */}
      {tab === "overview" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold">Informace o stavbě</h2>
          <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
            <div>
              <span className="text-gray-500">Stavebník:</span>
              <p className="font-medium text-gray-900">{project.builder || "Nespecifikován"}</p>
            </div>
            <div>
              <span className="text-gray-500">Zhotovitel:</span>
              <p className="font-medium text-gray-900">{project.contractor || "Nespecifikován"}</p>
            </div>
            <div>
              <span className="text-gray-500">Katastrální území:</span>
              <p className="font-medium text-gray-900">{project.cadastralArea || "-"}</p>
            </div>
            <div>
              <span className="text-gray-500">Parcelní čísla:</span>
              <p className="font-medium text-gray-900">{project.parcelNumbers || "-"}</p>
            </div>
            {project.contractDate && (
              <div>
                <span className="text-gray-500">Datum smlouvy:</span>
                <p className="font-medium text-gray-900">{formatDate(project.contractDate)}</p>
              </div>
            )}
            {project.designDocDate && (
              <div>
                <span className="text-gray-500">Datum projektové dokumentace:</span>
                <p className="font-medium text-gray-900">{formatDate(project.designDocDate)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Reports (Záznamy) */}
      {tab === "reports" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Denní záznamy</h2>
              <p className="text-sm text-gray-500">Přehled a správa denních záznamů stavby.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => navigate(`/projects/${id}/reports/${today()}`)}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
              >
                Nový pro dnešek
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadPdf()}
                className="rounded-md border border-gray-300 bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-800 shadow-sm hover:bg-gray-200"
              >
                Stáhnout PDF
              </button>
            </div>
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-gray-50 p-4">
            <label htmlFor="new-report-date" className="text-sm font-medium text-gray-700">
              Otevřít konkrétní datum:
            </label>
            <input
              id="new-report-date"
              type="date"
              max={today()}
              value={newReportDate}
              onChange={(e) => setNewReportDate(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => navigate(`/projects/${id}/reports/${newReportDate}`)}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900"
            >
              Otevřít den
            </button>
          </div>

          {reports.length === 0 ? (
            <p className="text-sm text-gray-500">Zatím nebyl vytvořen žádný denní záznam.</p>
          ) : (
            <div className="divide-y divide-gray-200">
              {reports.map((r) => (
                <div key={r.id} className="flex items-center justify-between py-4">
                  <div>
                    <span className="mr-3 font-semibold text-indigo-600">{r.date}</span>
                    <span className="text-sm text-gray-700">{r.workDescription || "Denní záznam stavebních prací"}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => void handleDownloadPdf(r)}
                      aria-label={`Stáhnout PDF záznamu z ${r.date}`}
                      className="text-sm text-gray-600 underline hover:text-gray-900"
                    >
                      PDF
                    </button>
                    <Link to={`/projects/${id}/reports/${r.date}`} className="text-sm font-medium text-indigo-600 hover:text-indigo-900">
                      Zobrazit záznam →
                    </Link>
                  </div>
                </div>
              ))}
              {hasMoreReports && (
                <div className="pt-4 text-center">
                  <button
                    type="button"
                    onClick={() => void handleLoadOlderReports()}
                    className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Načíst starší záznamy
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Site Handovers (Předání staveniště) */}
      {tab === "handovers" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Předání a převzetí staveniště</h2>
            <button type="button" onClick={openHandoverModal} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
              Přidat předání
            </button>
          </div>

          {showHandoverModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-lg space-y-4 rounded-lg bg-white p-6 shadow-xl">
                <h3 className="text-lg font-bold">Protokol o předání staveniště</h3>
                <div>
                  <label htmlFor="handover-type" className="mb-1 block text-xs font-medium text-gray-700">
                    Typ předání
                  </label>
                  <input id="handover-type" type="text" value={handoverType} onChange={(e) => setHandoverType(e.target.value)} className="w-full rounded border p-2 text-sm" />
                </div>
                <div>
                  <label htmlFor="handover-date" className="mb-1 block text-xs font-medium text-gray-700">
                    Datum předání
                  </label>
                  <input id="handover-date" type="date" value={handoverDate} onChange={(e) => setHandoverDate(e.target.value)} className="w-full rounded border p-2 text-sm" />
                </div>
                <div>
                  <label htmlFor="handover-participants" className="mb-1 block text-xs font-medium text-gray-700">
                    Účastníci předání
                  </label>
                  <input
                    id="handover-participants"
                    type="text"
                    value={handoverParticipants}
                    onChange={(e) => setHandoverParticipants(e.target.value)}
                    className="w-full rounded border p-2 text-sm"
                  />
                </div>

                <div className="border-t pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-700">Měřidla a odběrná místa</span>
                    <button
                      type="button"
                      onClick={() => setMeters((prev) => [...prev, { medium: "", serialNumber: "", state: "" }])}
                      className="rounded border bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200"
                    >
                      Přidat měřidlo
                    </button>
                  </div>
                  {meters.map((m, idx) => (
                    <div key={idx} className="mb-2 grid grid-cols-3 gap-2">
                      <input
                        placeholder="Médium (např. Voda, Elektřina VT)"
                        value={m.medium}
                        onChange={(e) => updateMeter(idx, { medium: e.target.value })}
                        className="rounded border p-1 text-xs"
                      />
                      <input
                        placeholder="Výrobní číslo"
                        value={m.serialNumber}
                        onChange={(e) => updateMeter(idx, { serialNumber: e.target.value })}
                        className="rounded border p-1 text-xs"
                      />
                      <input
                        placeholder="Stav (např. 12450 kWh)"
                        value={m.state}
                        onChange={(e) => updateMeter(idx, { state: e.target.value })}
                        className="rounded border p-1 text-xs"
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <label htmlFor="handover-notes" className="mb-1 block text-xs font-medium text-gray-700">
                    Poznámky / Závěry
                  </label>
                  <textarea id="handover-notes" value={handoverNotes} onChange={(e) => setHandoverNotes(e.target.value)} className="w-full rounded border p-2 text-sm" rows={2} />
                </div>

                <div className="flex justify-end gap-2 border-t pt-2">
                  <button type="button" onClick={() => setShowHandoverModal(false)} className="rounded border px-3 py-1.5 text-sm">
                    Zrušit
                  </button>
                  <button type="button" onClick={() => void handleSaveHandover()} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">
                    Uložit předání
                  </button>
                </div>
              </div>
            </div>
          )}

          {handovers.length === 0 ? (
            <p className="text-sm text-gray-500">Zatím nebylo zaznamenáno žádné předání staveniště.</p>
          ) : (
            <div className="space-y-4">
              {handovers.map((h) => (
                <div key={h.id} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-bold text-gray-900">{h.type}</h4>
                      <p className="text-sm text-gray-600">{h.participants}</p>
                      <p className="text-xs text-gray-500">{formatDate(h.date)}</p>
                    </div>
                    <div>
                      {h.signedAt ? (
                        <span className="rounded bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-800">Podepsáno dne {formatDate(h.signedAt)}</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-800">Čeká na podpis</span>
                          <button
                            type="button"
                            onClick={() => void handleSignHandover(h.id)}
                            className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                          >
                            Podepsat předání
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {h.meterStates && h.meterStates.length > 0 && (
                    <div className="mt-3 border-t border-gray-200 pt-3">
                      <span className="text-xs font-semibold text-gray-500">Stavy měřidel:</span>
                      <div className="mt-1 flex flex-wrap gap-4 text-xs">
                        {h.meterStates.map((m, idx) => (
                          <div key={idx} className="rounded border bg-white px-2 py-1">
                            <span className="font-semibold">{m.medium}</span> ({m.serialNumber}): {m.state}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {h.notes && <p className="mt-2 text-xs text-gray-600">{h.notes}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Members & Authorized Persons (Členové) */}
      {tab === "members" && (
        <div className="space-y-8">
          {/* Authorized Persons Section */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900">Seznam pověřených osob</h2>
              {canManage && (
                <button type="button" onClick={openPersonModal} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
                  Přidat osobu
                </button>
              )}
            </div>

            {showPersonModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
                  <h3 className="text-lg font-bold">Přidat pověřenou osobu</h3>
                  <div>
                    <label htmlFor="person-name" className="mb-1 block text-xs font-medium text-gray-700">
                      Jméno a příjmení / Titul
                    </label>
                    <input id="person-name" type="text" value={personName} onChange={(e) => setPersonName(e.target.value)} className="w-full rounded border p-2 text-sm" />
                  </div>
                  <div>
                    <label htmlFor="person-company" className="mb-1 block text-xs font-medium text-gray-700">
                      Organizace / Společnost
                    </label>
                    <input id="person-company" type="text" value={personCompany} onChange={(e) => setPersonCompany(e.target.value)} className="w-full rounded border p-2 text-sm" />
                  </div>
                  <div>
                    <label htmlFor="person-auth" className="mb-1 block text-xs font-medium text-gray-700">
                      Rozsah pověření / Funkce
                    </label>
                    <input id="person-auth" type="text" value={personAuth} onChange={(e) => setPersonAuth(e.target.value)} className="w-full rounded border p-2 text-sm" />
                  </div>
                  <div className="flex justify-end gap-2 border-t pt-2">
                    <button type="button" onClick={() => setShowPersonModal(false)} className="rounded border px-3 py-1.5 text-sm">
                      Zrušit
                    </button>
                    <button type="button" onClick={() => void handleSavePerson()} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">
                      Uložit
                    </button>
                  </div>
                </div>
              </div>
            )}

            {authorizedPersons.length === 0 ? (
              <p className="text-sm text-gray-500">Zatím nejsou evidovány žádné pověřené osoby.</p>
            ) : (
              <div className="divide-y divide-gray-200">
                {authorizedPersons.map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-3">
                    <div>
                      <span className="font-semibold text-gray-900">{p.name}</span>
                      {p.company && <span className="ml-2 text-sm text-gray-500">({p.company})</span>}
                      {p.authorization && <p className="mt-0.5 text-xs text-gray-600">{p.authorization}</p>}
                    </div>
                    <div>
                      {p.revokedAt ? (
                        <span className="text-sm font-semibold text-red-600">Zrušeno</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleRevokePerson(p.id)}
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:text-red-800"
                        >
                          Zrušit {p.name}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Project Members Section */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold text-gray-900">Členové projektu</h2>

            {!canManage && <p className="mb-4 text-sm text-gray-500">Členy projektu spravuje stavbyvedoucí projektu.</p>}
            <div className={canManage ? "mb-6 flex flex-wrap items-center gap-4" : "hidden"}>
              {/* User select trigger */}
              <div className="relative">
                <button
                  type="button"
                  data-slot="select-trigger"
                  aria-haspopup="listbox"
                  onClick={() => setShowUserDropdown(!showUserDropdown)}
                  className="flex min-w-[200px] items-center justify-between rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm"
                >
                  <span>{selectedUser ? `${selectedUser.displayName} (${selectedUser.nickname})` : "Vyberte uživatele"}</span>
                  <span className="text-xs text-gray-400">▼</span>
                </button>
                {showUserDropdown && (
                  <div role="listbox" className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border border-gray-300 bg-white shadow-md">
                    {userOptions.length === 0 && <div className="px-3 py-1.5 text-sm text-gray-500">Žádní uživatelé</div>}
                    {userOptions.map((u) => (
                      <div
                        key={u.id}
                        role="option"
                        aria-selected={selectedUserId === u.id}
                        onClick={() => {
                          setSelectedUserId(u.id);
                          // The person's own role is the default; the role in this project can be set to another.
                          if (ROLE_LABELS[u.role]) setSelectedRole(u.role);
                          setShowUserDropdown(false);
                        }}
                        className="cursor-pointer px-3 py-1.5 text-sm hover:bg-gray-100"
                      >
                        {u.displayName} ({u.nickname})
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Role select trigger */}
              <div className="relative">
                <button
                  type="button"
                  data-slot="select-trigger"
                  aria-haspopup="listbox"
                  onClick={() => setShowRoleDropdown(!showRoleDropdown)}
                  className="flex min-w-[160px] items-center justify-between rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm"
                >
                  <span>{ROLE_LABELS[selectedRole]}</span>
                  <span className="text-xs text-gray-400">▼</span>
                </button>
                {showRoleDropdown && (
                  <div role="listbox" className="absolute z-10 mt-1 w-full rounded border border-gray-300 bg-white shadow-md">
                    {Object.entries(ROLE_LABELS).map(([role, label]) => (
                      <div
                        key={role}
                        role="option"
                        aria-selected={selectedRole === role}
                        onClick={() => {
                          setSelectedRole(role);
                          setShowRoleDropdown(false);
                        }}
                        className="cursor-pointer px-3 py-1.5 text-sm hover:bg-gray-100"
                      >
                        {label}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button type="button" onClick={() => void handleAddMember()} className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                Přidat
              </button>
            </div>

            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="py-2 text-left text-xs font-medium text-gray-500 uppercase">Uživatel</th>
                  <th className="py-2 text-left text-xs font-medium text-gray-500 uppercase">Jméno</th>
                  <th className="py-2 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td className="py-2 text-sm font-medium text-gray-900">{m.nickname}</td>
                    <td className="py-2 text-sm text-gray-700">{m.displayName}</td>
                    <td className="py-2 text-sm text-gray-600">{ROLE_LABELS[m.role] ?? m.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
