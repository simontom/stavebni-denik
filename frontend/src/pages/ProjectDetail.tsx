import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, apiFetch, ApiError, currentUser, json, ROLE_LABELS, type UserOption } from "../lib/api";
import { pragueToday } from "../lib/dates";
import { Handovers } from "../components/Handovers";
import { Button, Card, Field, PageState, StatusBadge, TabLink, TabNav, TextInput } from "../components/ui";

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
  /** The scope of the person's authorisation and responsibility (příloha 12 A d)); only a manager and the supervision have one. */
  scope?: string | null;
}

/** The roles whose members are named in part A of the diary with a scope (BOSS and INSPECTOR), as the server has it. */
const ROLES_WITH_SCOPE = ["BOSS", "INSPECTOR"];
/** The longest scope the server accepts (ProjectMemberService.MAX_SCOPE_CHARS). */
const MAX_SCOPE_CHARS = 500;

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
  /** The version of the project; sent back when it is changed. */
  updatedAt?: string | null;
  permitNumber?: string | null;
  permitDate?: string | null;
  designerName?: string | null;
  authorSupervisionName?: string | null;
  authorSupervisionAuthorization?: string | null;
  tdsName?: string | null;
  bozpName?: string | null;
  subcontractors?: string | null;
  supportingDocuments?: string | null;
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
  // The scope of the authorisation and responsibility of the person being added or changed (for a manager and the supervision).
  const [memberScope, setMemberScope] = useState("");
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showRoleDropdown, setShowRoleDropdown] = useState(false);

  // Replacing the site manager (stavbyvedoucí): the manager of the project names another manager of it.
  const [showSiteManager, setShowSiteManager] = useState(false);
  const [newSiteManagerId, setNewSiteManagerId] = useState("");
  const [siteManagerReason, setSiteManagerReason] = useState("");
  const [changingSiteManager, setChangingSiteManager] = useState(false);
  // What went wrong with the change, shown next to the form (the page banner may be out of sight), and whether the cause is a
  // version that is out of date, which a reload of the project and its members mends.
  const [siteManagerError, setSiteManagerError] = useState("");
  const [siteManagerStale, setSiteManagerStale] = useState(false);

  const fail = (err: unknown, fallback: string) => setError(err instanceof Error ? err.message : fallback);

  useEffect(() => {
    if (!id) return;
    let ignore = false;
    Promise.all([
      api<ProjectData>(`/api/projects/${id}`),
      api<ReportItem[]>(`/api/projects/${id}/reports?limit=${REPORT_PAGE_SIZE}`),
      api<AuthorizedPerson[]>(`/api/projects/${id}/authorized-persons`),
      api<ProjectMember[]>(`/api/projects/${id}/members`),
    ])
      .then(([p, r, ap, m]) => {
        if (ignore) return;
        setProject(p);
        setReports(r);
        setHasMoreReports(r.length >= REPORT_PAGE_SIZE);
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
    const hasScope = ROLES_WITH_SCOPE.includes(selectedRole);
    if (hasScope && memberScope.length > MAX_SCOPE_CHARS) {
      setError(`Rozsah oprávnění a odpovědnosti může mít nejvýše ${MAX_SCOPE_CHARS} znaků (teď ${memberScope.length})`);
      return;
    }
    try {
      // The scope is always sent for a role that has one, so that emptying the field clears it; for another role it is left out.
      const updated = await api<ProjectMember[]>(`/api/projects/${id}/members`, {
        method: "POST",
        body: json(hasScope ? { userId: selectedUserId, role: selectedRole, scope: memberScope.trim() } : { userId: selectedUserId, role: selectedRole }),
      });
      setMembers(updated);
      setMemberScope(updated.find((m) => m.userId === selectedUserId)?.scope ?? "");
      setError("");
    } catch (err) {
      fail(err, "Člena se nepodařilo přidat");
    }
  };

  const selectedUser = userOptions.find((u) => u.id === selectedUserId);
  // A manager of a project (BOSS) signs its diary and so holds a ČKAIT number (the server refuses otherwise): say so up front.
  const managerNeedsCkait = selectedRole === "BOSS" && selectedUser !== undefined && !selectedUser.hasCkait;

  const siteManagerName = members.find((m) => m.userId === project?.siteManagerId)?.displayName;
  // Whoever can sign: a manager (role BOSS) of this project other than the present site manager. The server checks the rest
  // (an active user holding a ČKAIT number).
  const siteManagerCandidates = members.filter((m) => m.role === "BOSS" && m.userId !== project?.siteManagerId);

  /** The project and its members again, after the change found them out of date. */
  const reloadForSiteManager = async () => {
    if (!id) return;
    try {
      const [p, m] = await Promise.all([api<ProjectData>(`/api/projects/${id}`), api<ProjectMember[]>(`/api/projects/${id}/members`)]);
      setProject(p);
      setMembers(m);
      setNewSiteManagerId("");
      setSiteManagerError("");
      setSiteManagerStale(false);
    } catch (err) {
      setSiteManagerError(err instanceof Error ? err.message : "Údaje se nepodařilo načíst znovu");
    }
  };

  const changeSiteManager = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !project || !newSiteManagerId || changingSiteManager) return;
    setChangingSiteManager(true);
    setSiteManagerError("");
    try {
      const updated = await api<ProjectData>(`/api/projects/${id}/site-manager`, {
        method: "PUT",
        body: json({ siteManagerId: newSiteManagerId, reason: siteManagerReason.trim() || null, updatedAt: project.updatedAt ?? null }),
      });
      setProject(updated);
      setShowSiteManager(false);
      setNewSiteManagerId("");
      setSiteManagerReason("");
      setSiteManagerError("");
      setSiteManagerStale(false);
      setError("");
    } catch (err) {
      setSiteManagerError(err instanceof Error ? err.message : "Stavbyvedoucího se nepodařilo změnit");
      setSiteManagerStale(err instanceof ApiError && err.code === "STALE_VERSION");
    } finally {
      setChangingSiteManager(false);
    }
  };

  if (loading) return <PageState kind="loading">Načítání detailu projektu...</PageState>;
  if (!project) return <PageState kind="error">{error || "Projekt nenalezen"}</PageState>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      {/* Project Header */}
      <Card className="mb-6">
        <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h1 className="text-2xl font-bold text-ink sm:text-3xl">{project.name}</h1>
            <p className="mt-1 text-ink-muted">{project.address}</p>
            {project.myRole === "BOSS" && (
              <Link to={`/projects/${id}/edit`} className="mt-1 -ml-2 inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary-ink hover:underline">
                Upravit údaje o stavbě
              </Link>
            )}
          </div>
          {(project.contractNumber || project.designDocVersion) && (
            <div className="flex flex-wrap gap-4 rounded-md border border-line bg-page p-3 text-sm">
              {project.contractNumber && (
                <div>
                  <span className="block text-xs text-ink-muted">Číslo smlouvy:</span>
                  <span className="font-semibold text-ink">{project.contractNumber}</span>
                </div>
              )}
              {project.designDocVersion && (
                <div>
                  <span className="block text-xs text-ink-muted">Dokumentace:</span>
                  <span className="font-semibold text-ink">{project.designDocVersion}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="mt-6">
          <TabNav label="Části projektu">
            <TabLink to={`/projects/${id}`} active={tab === "overview"}>
              Přehled
            </TabLink>
            <TabLink to={`/projects/${id}?tab=reports`} active={tab === "reports"}>
              Záznamy
            </TabLink>
            <TabLink to={`/projects/${id}?tab=handovers`} active={tab === "handovers"}>
              Předání staveniště
            </TabLink>
            <TabLink to={`/projects/${id}?tab=members`} active={tab === "members"}>
              Členové
            </TabLink>
          </TabNav>
        </div>
      </Card>

      {error && <div className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      {/* Tab 1: Overview */}
      {tab === "overview" && (
        <Card>
          <h2 className="mb-4 text-xl font-semibold">Informace o stavbě</h2>
          <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
            <div className="md:col-span-2">
              <span className="text-gray-500">Hlavní stavbyvedoucí:</span>
              <p className="font-medium text-gray-900">{siteManagerName || "-"}</p>
              {project.myRole === "BOSS" && siteManagerCandidates.length > 0 && !showSiteManager && (
                <button type="button" onClick={() => setShowSiteManager(true)} className="mt-1 text-sm text-indigo-600 hover:underline">
                  Změnit stavbyvedoucího
                </button>
              )}
              {project.myRole === "BOSS" && siteManagerCandidates.length === 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  Stavbyvedoucího lze změnit na jiného vedoucího (BOSS) tohoto projektu s číslem ČKAIT. Nejdřív ho přidejte v záložce Členové.
                </p>
              )}
              {showSiteManager && (
                <form onSubmit={changeSiteManager} className="mt-2 space-y-2 rounded border border-gray-200 bg-gray-50 p-3">
                  <label htmlFor="newSiteManager" className="block text-xs text-gray-600">
                    Nový stavbyvedoucí (vedoucí tohoto projektu s číslem ČKAIT)
                  </label>
                  <select
                    id="newSiteManager"
                    name="newSiteManager"
                    value={newSiteManagerId}
                    onChange={(e) => setNewSiteManagerId(e.target.value)}
                    required
                    className="w-full rounded-md border border-gray-300 p-2"
                  >
                    <option value="">Vyberte…</option>
                    {siteManagerCandidates.map((m) => {
                      // The list of users says who holds a ČKAIT number: a manager without one is shown, but cannot be chosen.
                      const withoutNumber = userOptions.some((u) => u.id === m.userId && !u.hasCkait);
                      return (
                        <option key={m.userId} value={m.userId} disabled={withoutNumber}>
                          {m.displayName} ({m.nickname}){withoutNumber ? " – bez čísla ČKAIT" : ""}
                        </option>
                      );
                    })}
                  </select>
                  <label htmlFor="siteManagerReason" className="block text-xs text-gray-600">
                    Důvod změny (nepovinné, zůstane v záznamu o změnách)
                  </label>
                  <textarea
                    id="siteManagerReason"
                    name="siteManagerReason"
                    value={siteManagerReason}
                    onChange={(e) => setSiteManagerReason(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-gray-300 p-2"
                  />
                  {siteManagerReason.length > 1000 && <p className="text-xs font-semibold text-red-700">{siteManagerReason.length} / 1000 znaků</p>}
                  {siteManagerError && (
                    <div role="alert" className="rounded bg-red-100 p-2 text-sm text-red-700">
                      <p>{siteManagerError}</p>
                      {siteManagerStale && (
                        <button type="button" onClick={reloadForSiteManager} className="mt-1 font-semibold underline">
                          Načíst znovu
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={changingSiteManager || !newSiteManagerId || siteManagerReason.length > 1000}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {changingSiteManager ? "Ukládám..." : "Změnit stavbyvedoucího"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSiteManager(false);
                        setSiteManagerError("");
                        setSiteManagerStale(false);
                      }}
                      className="text-sm text-gray-600 hover:underline"
                    >
                      Zrušit
                    </button>
                  </div>
                </form>
              )}
            </div>
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
            {project.permitNumber && (
              <div>
                <span className="text-gray-500">Povolení:</span>
                <p className="font-medium text-gray-900">
                  {project.permitNumber}
                  {project.permitDate ? ` ze dne ${formatDate(project.permitDate)}` : ""}
                </p>
              </div>
            )}
            {!project.permitNumber && project.permitDate && (
              <div>
                <span className="text-gray-500">Datum povolení:</span>
                <p className="font-medium text-gray-900">{formatDate(project.permitDate)}</p>
              </div>
            )}
            {project.designerName && (
              <div>
                <span className="text-gray-500">Projektant:</span>
                <p className="font-medium text-gray-900">{project.designerName}</p>
              </div>
            )}
            {(project.authorSupervisionName || project.authorSupervisionAuthorization) && (
              <div>
                <span className="text-gray-500">Autorský dozor:</span>
                <p className="font-medium text-gray-900">
                  {[project.authorSupervisionName, project.authorSupervisionAuthorization && `autorizace ${project.authorSupervisionAuthorization}`].filter(Boolean).join(", ")}
                </p>
              </div>
            )}
            {project.tdsName && (
              <div>
                <span className="text-gray-500">Technický dozor stavebníka:</span>
                <p className="font-medium text-gray-900">{project.tdsName}</p>
              </div>
            )}
            {project.bozpName && (
              <div>
                <span className="text-gray-500">Koordinátor BOZP:</span>
                <p className="font-medium text-gray-900">{project.bozpName}</p>
              </div>
            )}
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
            {project.subcontractors && (
              <div className="md:col-span-2">
                <span className="text-gray-500">Poddodavatelé:</span>
                <p className="font-medium whitespace-pre-line text-gray-900">{project.subcontractors}</p>
              </div>
            )}
            {project.supportingDocuments && (
              <div className="md:col-span-2">
                <span className="text-gray-500">Podklady stavby:</span>
                <p className="font-medium whitespace-pre-line text-gray-900">{project.supportingDocuments}</p>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Tab 2: Reports (Záznamy) */}
      {tab === "reports" && (
        <Card>
          <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-semibold text-ink">Denní záznamy</h2>
              <p className="text-sm text-ink-muted">Přehled a správa denních záznamů stavby.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate(`/projects/${id}/reports/${today()}`)}>Nový pro dnešek</Button>
              <Button variant="secondary" onClick={() => void handleDownloadPdf()}>
                Stáhnout PDF
              </Button>
            </div>
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-line bg-page p-4">
            <label htmlFor="new-report-date" className="text-sm font-medium text-ink">
              Otevřít konkrétní datum:
            </label>
            <TextInput id="new-report-date" type="date" max={today()} value={newReportDate} onChange={(e) => setNewReportDate(e.target.value)} className="w-auto" />
            <Button variant="secondary" onClick={() => navigate(`/projects/${id}/reports/${newReportDate}`)}>
              Otevřít den
            </Button>
          </div>

          {reports.length === 0 ? (
            <p className="text-sm text-ink-muted">Zatím nebyl vytvořen žádný denní záznam.</p>
          ) : (
            <div className="divide-y divide-line">
              {reports.map((r) => (
                // On a phone the row is a short list: the day and what was done, and below them the two things to do with it.
                <div key={r.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:py-4">
                  <div>
                    <span className="mr-3 font-semibold text-primary-ink tabular-nums">{r.date}</span>
                    <span className="text-sm text-ink">{r.workDescription || "Denní záznam stavebních prací"}</span>
                  </div>
                  <div className="flex items-center gap-2 sm:shrink-0 sm:gap-4 sm:whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => void handleDownloadPdf(r)}
                      aria-label={`Stáhnout PDF záznamu z ${r.date}`}
                      className="inline-flex min-h-11 items-center px-2 text-sm text-ink-muted underline hover:text-ink sm:px-0 sm:pointer-fine:min-h-0"
                    >
                      PDF
                    </button>
                    <Link
                      to={`/projects/${id}/reports/${r.date}`}
                      className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary-ink hover:underline sm:px-0 sm:pointer-fine:min-h-0"
                    >
                      Zobrazit záznam →
                    </Link>
                  </div>
                </div>
              ))}
              {hasMoreReports && (
                <div className="pt-4 text-center">
                  <Button variant="secondary" onClick={() => void handleLoadOlderReports()}>
                    Načíst starší záznamy
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Tab 3: Site Handovers (Předání staveniště): a component of its own, with its own data */}
      {tab === "handovers" && id && <Handovers key={id} projectId={id} myRole={project.myRole} />}

      {/* Tab 4: Members & Authorized Persons (Členové) */}
      {tab === "members" && (
        <div className="space-y-6 sm:space-y-8">
          {/* Authorized Persons Section */}
          <Card>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-ink">Seznam pověřených osob</h2>
              {canManage && <Button onClick={openPersonModal}>Přidat osobu</Button>}
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
              <div className="divide-y divide-line">
                {authorizedPersons.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div>
                      <span className="font-semibold text-ink">{p.name}</span>
                      {p.company && <span className="ml-2 text-sm text-ink-muted">({p.company})</span>}
                      {p.authorization && <p className="mt-0.5 text-xs text-ink-muted">{p.authorization}</p>}
                    </div>
                    <div>
                      {p.revokedAt ? (
                        <span className="text-sm font-semibold text-danger-ink">Zrušeno</span>
                      ) : (
                        <Button variant="danger-quiet" size="sm" onClick={() => void handleRevokePerson(p.id)}>
                          Zrušit {p.name}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Project Members Section */}
          <Card>
            <h2 className="mb-4 text-xl font-semibold text-ink">Členové projektu</h2>

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
                          // A person who is a member already is shown as they are (to change their role or scope); otherwise their
                          // own role is the default, and the role in this project can be set to another.
                          const member = members.find((m) => m.userId === u.id);
                          if (member) {
                            setSelectedRole(member.role);
                            setMemberScope(member.scope ?? "");
                          } else {
                            if (ROLE_LABELS[u.role]) setSelectedRole(u.role);
                            setMemberScope("");
                          }
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

              {ROLES_WITH_SCOPE.includes(selectedRole) && (
                <Field label="Rozsah oprávnění a odpovědnosti" className="basis-full">
                  <TextInput
                    name="scope"
                    value={memberScope}
                    onChange={(e) => setMemberScope(e.target.value)}
                    placeholder="Co osoba na stavbě zajišťuje a za co odpovídá (např. vedení stavby, objekty SO 02 a SO 03)"
                  />
                  {memberScope.length > MAX_SCOPE_CHARS * 0.9 && (
                    <p className={`mt-1 text-xs ${memberScope.length > MAX_SCOPE_CHARS ? "font-semibold text-danger-ink" : "text-ink-muted"}`}>
                      {memberScope.length} / {MAX_SCOPE_CHARS} znaků
                    </p>
                  )}
                </Field>
              )}

              <Button disabled={managerNeedsCkait} onClick={() => void handleAddMember()}>
                Přidat
              </Button>
              {managerNeedsCkait && (
                <p role="status" className="basis-full text-sm text-amber-800">
                  {selectedUser?.displayName} nemá číslo ČKAIT, a proto nemůže být vedoucím projektu (podepisuje záznamy). Číslo doplní administrátor v seznamu uživatelů.
                </p>
              )}
            </div>

            {/* A list on a phone (table-cards, index.css): the nickname, the name and the role one under the other. */}
            <table className="min-w-full divide-y divide-line max-sm:table-cards">
              <thead>
                <tr>
                  <th className="py-2 text-left text-xs font-medium text-ink-muted uppercase">Uživatel</th>
                  <th className="py-2 text-left text-xs font-medium text-ink-muted uppercase">Jméno</th>
                  <th className="py-2 text-left text-xs font-medium text-ink-muted uppercase">Role</th>
                  <th className="py-2 text-left text-xs font-medium text-ink-muted uppercase">Rozsah oprávnění a odpovědnosti</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td className="py-2 text-sm font-medium text-ink">{m.nickname}</td>
                    <td data-label="Jméno" className="py-2 text-sm text-ink">
                      {m.displayName}
                    </td>
                    <td data-label="Role" className="py-2 text-sm text-ink-muted">
                      {ROLE_LABELS[m.role] ?? m.role}
                      {m.userId === project.siteManagerId && (
                        <StatusBadge tone="primary" className="ml-2">
                          Hlavní stavbyvedoucí
                        </StatusBadge>
                      )}
                    </td>
                    <td data-label="Rozsah" className="py-2 text-sm text-ink">
                      {m.scope || (ROLES_WITH_SCOPE.includes(m.role) ? <span className="text-ink-muted">neuveden</span> : null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
};
