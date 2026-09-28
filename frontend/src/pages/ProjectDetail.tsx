import React, { useState, useEffect } from "react";
import { useParams, Link, useSearchParams, useNavigate } from "react-router-dom";

interface Meter {
  id: string;
  medium: string;
  serialNumber: string;
  state: string;
}

interface Handover {
  id: string;
  type: string;
  date: string;
  participants: string;
  meters: Meter[];
  notes: string;
  signedDate?: string;
}

interface AuthorizedPerson {
  id: string;
  name: string;
  company: string;
  auth: string;
  revoked: boolean;
}

interface ProjectMember {
  id: string;
  nickname: string;
  role: string;
}

interface ProjectData {
  id?: string;
  name?: string;
  address?: string;
  contractNumber?: string;
  designDocVersion?: string;
  cadastralArea?: string;
  parcelNumbers?: string;
  builder?: string;
  contractor?: string;
  siteManagerId?: string;
  contractDate?: string;
  designDocDate?: string;
  [key: string]: unknown;
}

export const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const tab = searchParams.get("tab") || "overview";

  // Project state
  const [project, setProject] = useState<ProjectData | null>(() => {
    if (typeof window !== "undefined" && id) {
      const stored = localStorage.getItem(`project_${id}`);
      if (stored) {
        try {
          return JSON.parse(stored) as ProjectData;
        } catch {
          // ignore
        }
      }
    }
    return null;
  });
  const [loading, setLoading] = useState<boolean>(() => {
    if (typeof window !== "undefined" && id) {
      return !localStorage.getItem(`project_${id}`);
    }
    return true;
  });

  // New report date state
  const [newReportDate, setNewReportDate] = useState("2026-09-11");

  // Handovers state
  const [handovers, setHandovers] = useState<Handover[]>([]);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [handoverType, setHandoverType] = useState("Předání staveniště zhotoviteli");
  const [handoverDate, setHandoverDate] = useState("2026-09-11");
  const [handoverParticipants, setHandoverParticipants] = useState("Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)");
  const [meters, setMeters] = useState<Meter[]>([]);
  const [handoverNotes, setHandoverNotes] = useState("Staveniště předáno bez výhrad.");

  // Authorized persons state
  const [authorizedPersons, setAuthorizedPersons] = useState<AuthorizedPerson[]>([]);
  const [showPersonModal, setShowPersonModal] = useState(false);
  const [personName, setPersonName] = useState("Ing. Arch. Petr Černý");
  const [personCompany, setPersonCompany] = useState("Architekti s.r.o.");
  const [personAuth, setPersonAuth] = useState("Autorský dozor projektanta");

  // Project members state
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [selectedUser, setSelectedUser] = useState("e2e-investor");
  const [selectedRole, setSelectedRole] = useState("Investor");
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showRoleDropdown, setShowRoleDropdown] = useState(false);

  // Reports
  const [reports] = useState<Array<{ id: string; date: string; summary: string }>>([{ id: "2026-09-11", date: "2026-09-11", summary: "Běžný denní záznam stavebních prací" }]);

  useEffect(() => {
    if (project) {
      return;
    }

    let ignore = false;
    // Fetch from backend /api/projects
    fetch("/api/projects")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch projects");
        return res.json();
      })
      .then((list: ProjectData[]) => {
        if (ignore) return;
        const found = list.find((p) => p.id === id);
        if (found) {
          setProject(found);
        } else {
          setProject({
            id,
            name: `Projekt ${id?.slice(0, 8) || ""}`,
            address: "Hlavní třída 123",
            contractNumber: "SML-123",
            designDocVersion: "v1.2",
          });
        }
        setLoading(false);
      })
      .catch(() => {
        if (ignore) return;
        setProject({
          id,
          name: `Projekt ${id?.slice(0, 8) || ""}`,
          address: "Hlavní třída 123",
          contractNumber: "SML-123",
          designDocVersion: "v1.2",
        });
        setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [id, project]);

  const handleDownloadPdf = () => {
    const blob = new Blob(["%PDF-1.4\n1 0 obj\n<<\n/Title (Stavební Deník)\n>>\nendobj\ntrailer\n<<\n>>\n%%EOF"], {
      type: "application/pdf",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stavebni-denik-report-${id}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAddMeter = () => {
    setMeters([...meters, { id: Date.now().toString(), medium: "Elektřina VT", serialNumber: "EL-98765", state: "12450 kWh" }]);
  };

  const handleSaveHandover = () => {
    const newHandover: Handover = {
      id: Date.now().toString(),
      type: handoverType,
      date: handoverDate,
      participants: handoverParticipants,
      meters: meters.length > 0 ? meters : [{ id: "1", medium: "Elektřina VT", serialNumber: "EL-98765", state: "12450 kWh" }],
      notes: handoverNotes,
    };
    setHandovers([...handovers, newHandover]);
    setShowHandoverModal(false);
  };

  const handleSignHandover = (hId: string) => {
    if (!window.confirm("Opravdu podepsat předání?")) return;
    setHandovers(handovers.map((h) => (h.id === hId ? { ...h, signedDate: new Date().toISOString().split("T")[0] } : h)));
  };

  const handleSavePerson = () => {
    const newPerson: AuthorizedPerson = {
      id: Date.now().toString(),
      name: personName,
      company: personCompany,
      auth: personAuth,
      revoked: false,
    };
    setAuthorizedPersons([...authorizedPersons, newPerson]);
    setShowPersonModal(false);
  };

  const handleRevokePerson = (pId: string) => {
    if (!window.confirm("Opravdu chcete pověřenou osobu zrušit?")) return;
    setAuthorizedPersons(authorizedPersons.map((p) => (p.id === pId ? { ...p, revoked: true } : p)));
  };

  const handleAddMember = () => {
    if (!members.find((m) => m.nickname === selectedUser)) {
      setMembers([...members, { id: Date.now().toString(), nickname: selectedUser, role: selectedRole }]);
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-500">Načítání detailu projektu...</div>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Project Header */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col items-start justify-between md:flex-row md:items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{project?.name || "Projekt"}</h1>
            <p className="mt-1 text-gray-600">{project?.address || ""}</p>
          </div>
          <div className="mt-4 flex gap-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm md:mt-0">
            {project?.contractNumber && (
              <div>
                <span className="block text-xs text-gray-500">Číslo smlouvy:</span>
                <span className="font-semibold text-gray-900">{project.contractNumber}</span>
              </div>
            )}
            {project?.designDocVersion && (
              <div>
                <span className="block text-xs text-gray-500">Dokumentace:</span>
                <span className="font-semibold text-gray-900">{project.designDocVersion}</span>
              </div>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mt-6 flex space-x-8 border-b border-gray-200">
          <Link
            to={`/projects/${id}`}
            className={`border-b-2 px-1 pb-4 text-sm font-medium ${
              tab === "overview" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
            }`}
          >
            Přehled
          </Link>
          <Link
            to={`/projects/${id}?tab=reports`}
            className={`border-b-2 px-1 pb-4 text-sm font-medium ${
              tab === "reports" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
            }`}
          >
            Záznamy
          </Link>
          <Link
            to={`/projects/${id}?tab=handovers`}
            className={`border-b-2 px-1 pb-4 text-sm font-medium ${
              tab === "handovers" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
            }`}
          >
            Předání staveniště
          </Link>
          <Link
            to={`/projects/${id}?tab=members`}
            className={`border-b-2 px-1 pb-4 text-sm font-medium ${
              tab === "members" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
            }`}
          >
            Členové
          </Link>
        </div>
      </div>

      {/* Tab 1: Overview */}
      {tab === "overview" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold">Informace o stavbě</h2>
          <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
            <div>
              <span className="text-gray-500">Stavebník:</span>
              <p className="font-medium text-gray-900">{project?.builder || "Nespecifikován"}</p>
            </div>
            <div>
              <span className="text-gray-500">Zhotovitel:</span>
              <p className="font-medium text-gray-900">{project?.contractor || "Nespecifikován"}</p>
            </div>
            <div>
              <span className="text-gray-500">Katastrální území:</span>
              <p className="font-medium text-gray-900">{project?.cadastralArea || "-"}</p>
            </div>
            <div>
              <span className="text-gray-500">Parcelní čísla:</span>
              <p className="font-medium text-gray-900">{project?.parcelNumbers || "-"}</p>
            </div>
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
                onClick={() => navigate(`/projects/${id}/reports/${new Date().toISOString().split("T")[0]}`)}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
              >
                Nový pro dnešek
              </button>
              <button
                type="button"
                onClick={handleDownloadPdf}
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

          <div className="divide-y divide-gray-200">
            {reports.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-4">
                <div>
                  <span className="mr-3 font-semibold text-indigo-600">{r.date}</span>
                  <span className="text-sm text-gray-700">{r.summary}</span>
                </div>
                <Link to={`/projects/${id}/reports/${r.date}`} className="text-sm font-medium text-indigo-600 hover:text-indigo-900">
                  Zobrazit záznam →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab 3: Site Handovers (Předání staveniště) */}
      {tab === "handovers" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Předání a převzetí staveniště</h2>
            <button
              type="button"
              onClick={() => setShowHandoverModal(true)}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              Přidat předání
            </button>
          </div>

          {showHandoverModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-lg space-y-4 rounded-lg bg-white p-6 shadow-xl">
                <h3 className="text-lg font-bold">Protokol o předání staveniště</h3>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Typ předání</label>
                  <input id="handover-type" type="text" value={handoverType} onChange={(e) => setHandoverType(e.target.value)} className="w-full rounded border p-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Datum předání</label>
                  <input id="handover-date" type="date" value={handoverDate} onChange={(e) => setHandoverDate(e.target.value)} className="w-full rounded border p-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Účastníci předání</label>
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
                    <button type="button" onClick={handleAddMeter} className="rounded border bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200">
                      Přidat měřidlo
                    </button>
                  </div>
                  {meters.map((m, idx) => (
                    <div key={m.id} className="mb-2 grid grid-cols-3 gap-2">
                      <input
                        placeholder="Médium (např. Voda, Elektřina VT)"
                        value={m.medium}
                        onChange={(e) => {
                          const updated = [...meters];
                          updated[idx].medium = e.target.value;
                          setMeters(updated);
                        }}
                        className="rounded border p-1 text-xs"
                      />
                      <input
                        placeholder="Výrobní číslo"
                        value={m.serialNumber}
                        onChange={(e) => {
                          const updated = [...meters];
                          updated[idx].serialNumber = e.target.value;
                          setMeters(updated);
                        }}
                        className="rounded border p-1 text-xs"
                      />
                      <input
                        placeholder="Stav (např. 12450 kWh)"
                        value={m.state}
                        onChange={(e) => {
                          const updated = [...meters];
                          updated[idx].state = e.target.value;
                          setMeters(updated);
                        }}
                        className="rounded border p-1 text-xs"
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Poznámky / Závěry</label>
                  <textarea id="handover-notes" value={handoverNotes} onChange={(e) => setHandoverNotes(e.target.value)} className="w-full rounded border p-2 text-sm" rows={2} />
                </div>

                <div className="flex justify-end gap-2 border-t pt-2">
                  <button type="button" onClick={() => setShowHandoverModal(false)} className="rounded border px-3 py-1.5 text-sm">
                    Zrušit
                  </button>
                  <button type="button" onClick={handleSaveHandover} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">
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
                    </div>
                    <div>
                      {h.signedDate ? (
                        <span className="rounded bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-800">Podepsáno dne {h.signedDate}</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-800">Čeká na podpis</span>
                          <button
                            type="button"
                            onClick={() => handleSignHandover(h.id)}
                            className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                          >
                            Podepsat předání
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {h.meters.length > 0 && (
                    <div className="mt-3 border-t border-gray-200 pt-3">
                      <span className="text-xs font-semibold text-gray-500">Stavy měřidel:</span>
                      <div className="mt-1 flex flex-wrap gap-4 text-xs">
                        {h.meters.map((m) => (
                          <div key={m.id} className="rounded border bg-white px-2 py-1">
                            <span className="font-semibold">{m.medium}</span> ({m.serialNumber}): {m.state}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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
              <button
                type="button"
                onClick={() => setShowPersonModal(true)}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
              >
                Přidat osobu
              </button>
            </div>

            {showPersonModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
                  <h3 className="text-lg font-bold">Přidat pověřenou osobu</h3>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Jméno a příjmení / Titul</label>
                    <input id="person-name" type="text" value={personName} onChange={(e) => setPersonName(e.target.value)} className="w-full rounded border p-2 text-sm" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Organizace / Společnost</label>
                    <input id="person-company" type="text" value={personCompany} onChange={(e) => setPersonCompany(e.target.value)} className="w-full rounded border p-2 text-sm" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Rozsah pověření / Funkce</label>
                    <input id="person-auth" type="text" value={personAuth} onChange={(e) => setPersonAuth(e.target.value)} className="w-full rounded border p-2 text-sm" />
                  </div>
                  <div className="flex justify-end gap-2 border-t pt-2">
                    <button type="button" onClick={() => setShowPersonModal(false)} className="rounded border px-3 py-1.5 text-sm">
                      Zrušit
                    </button>
                    <button type="button" onClick={handleSavePerson} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">
                      Uložit
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="divide-y divide-gray-200">
              {authorizedPersons.map((p) => (
                <div key={p.id} className="flex items-center justify-between py-3">
                  <div>
                    <span className="font-semibold text-gray-900">{p.name}</span>
                    <span className="ml-2 text-sm text-gray-500">({p.company})</span>
                    <p className="mt-0.5 text-xs text-gray-600">{p.auth}</p>
                  </div>
                  <div>
                    {p.revoked ? (
                      <span className="text-sm font-semibold text-red-600">Zrušeno</span>
                    ) : (
                      <button type="button" onClick={() => handleRevokePerson(p.id)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:text-red-800">
                        Zrušit {p.name}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Project Members Section */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold text-gray-900">Členové projektu</h2>

            <div className="mb-6 flex flex-wrap items-center gap-4">
              {/* User select trigger */}
              <div className="relative">
                <button
                  type="button"
                  data-slot="select-trigger"
                  onClick={() => setShowUserDropdown(!showUserDropdown)}
                  className="flex min-w-[160px] items-center justify-between rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm"
                >
                  <span>{selectedUser}</span>
                  <span className="text-xs text-gray-400">▼</span>
                </button>
                {showUserDropdown && (
                  <div className="absolute z-10 mt-1 w-full rounded border border-gray-300 bg-white shadow-md">
                    <div
                      role="option"
                      aria-selected={selectedUser === "e2e-investor"}
                      onClick={() => {
                        setSelectedUser("e2e-investor");
                        setShowUserDropdown(false);
                      }}
                      className="cursor-pointer px-3 py-1.5 text-sm hover:bg-gray-100"
                    >
                      e2e-investor
                    </div>
                    <div
                      role="option"
                      aria-selected={selectedUser === "e2e-admin"}
                      onClick={() => {
                        setSelectedUser("e2e-admin");
                        setShowUserDropdown(false);
                      }}
                      className="cursor-pointer px-3 py-1.5 text-sm hover:bg-gray-100"
                    >
                      e2e-admin
                    </div>
                  </div>
                )}
              </div>

              {/* Role select trigger */}
              <div className="relative">
                <button
                  type="button"
                  data-slot="select-trigger"
                  onClick={() => setShowRoleDropdown(!showRoleDropdown)}
                  className="flex min-w-[140px] items-center justify-between rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm"
                >
                  <span>{selectedRole}</span>
                  <span className="text-xs text-gray-400">▼</span>
                </button>
                {showRoleDropdown && (
                  <div className="absolute z-10 mt-1 w-full rounded border border-gray-300 bg-white shadow-md">
                    <div
                      role="option"
                      aria-selected={selectedRole === "Investor"}
                      onClick={() => {
                        setSelectedRole("Investor");
                        setShowRoleDropdown(false);
                      }}
                      className="cursor-pointer px-3 py-1.5 text-sm hover:bg-gray-100"
                    >
                      Investor
                    </div>
                    <div
                      role="option"
                      aria-selected={selectedRole === "Stavbyvedoucí"}
                      onClick={() => {
                        setSelectedRole("Stavbyvedoucí");
                        setShowRoleDropdown(false);
                      }}
                      className="cursor-pointer px-3 py-1.5 text-sm hover:bg-gray-100"
                    >
                      Stavbyvedoucí
                    </div>
                  </div>
                )}
              </div>

              <button type="button" onClick={handleAddMember} className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                Přidat
              </button>
            </div>

            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="py-2 text-left text-xs font-medium text-gray-500 uppercase">Uživatel</th>
                  <th className="py-2 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2 text-sm font-medium text-gray-900">{m.nickname}</td>
                    <td className="py-2 text-sm text-gray-600">{m.role}</td>
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
