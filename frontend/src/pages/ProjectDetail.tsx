import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, apiFetch, ApiError, currentUser, json, ROLE_LABELS, type UserOption } from "../lib/api";
import { formatDay, formatDayWithWeekday, pragueToday } from "../lib/dates";
import { entryNumberLabel } from "../lib/entryDocument";
import { usePageTitle } from "../lib/pageTitle";
import { LABELS } from "../lib/projectFields";
import { useStalled } from "../lib/useStalled";
import { useUnsavedWork } from "../lib/useUnsavedWork";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ControlDayBadge, EntryStateBadge, LateEntryBadge } from "../components/EntryBadges";
import { Handovers } from "../components/Handovers";
import {
  Banner,
  Button,
  Card,
  Field,
  FormActions,
  Modal,
  PageState,
  Select,
  StalledNotice,
  StatusBadge,
  TabLink,
  TabNav,
  TextArea,
  TextInput,
  type ModalHandle,
} from "../components/ui";

/** What the tabs are called in the title of the page (the overview has no part of its own: the project's name says it). */
const TAB_TITLES: Record<string, string> = { reports: "Záznamy", handovers: "Předání staveniště", members: "Členové" };

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
  /** Given when the entry is signed; null for a draft. */
  sequenceNumber?: number | null;
  isLateEntry?: boolean;
  isControlDay?: boolean;
  /** Who wrote the entry (the account's display name). */
  authorName?: string | null;
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
  // The project's name, and the tab when it is not the overview ("Členové – Hala Brno – Stavební deník").
  usePageTitle(TAB_TITLES[tab], project?.name ?? "Projekt");

  // Reports
  const [reports, setReports] = useState<ReportItem[]>([]);
  // The server sends the entries a page at a time (newest day first); a full page means there may be older ones.
  const [hasMoreReports, setHasMoreReports] = useState(false);
  const [newReportDate, setNewReportDate] = useState(today());

  // Authorized persons
  const [authorizedPersons, setAuthorizedPersons] = useState<AuthorizedPerson[]>([]);
  // The dialog that adds a person, and the question before one is revoked (each is state of this page's own, taken off the screen when answered).
  const [addingPerson, setAddingPerson] = useState(false);
  const [revoking, setRevoking] = useState<AuthorizedPerson | null>(null);
  // After a person is revoked the button that asked is gone: the focus goes to the heading of the list.
  const personsHeading = useRef<HTMLHeadingElement>(null);

  // Members
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  // Members and authorized persons are managed by the project's manager (the role held in THIS project) or an administrator.
  const canManage = project?.myRole === "BOSS" || Boolean(currentUser()?.isAdmin);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState("INVESTOR");
  // The scope of the authorisation and responsibility of the person being added or changed (for a manager and the supervision).
  const [memberScope, setMemberScope] = useState("");

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

  /** A person is chosen in the list: a member already is shown as they are (to change their role or scope); anybody else gets their own role as the one offered. */
  const pickUser = (userId: string) => {
    setSelectedUserId(userId);
    const member = members.find((m) => m.userId === userId);
    if (member) {
      setSelectedRole(member.role);
      setMemberScope(member.scope ?? "");
      return;
    }
    const user = userOptions.find((u) => u.id === userId);
    if (user && ROLE_LABELS[user.role]) setSelectedRole(user.role);
    setMemberScope("");
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

  // What the header says about the contract and the documentation: only what is filled in, so there is never a box with nothing in it.
  const headerFacts = [
    { label: "Číslo smlouvy", value: project.contractNumber?.trim() },
    { label: "Dokumentace", value: project.designDocVersion?.trim() },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

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
          {headerFacts.length > 0 && (
            <dl className="flex flex-wrap gap-4 rounded-md border border-line bg-page p-3 text-sm">
              {headerFacts.map((fact) => (
                <div key={fact.label}>
                  <dt className="text-xs text-ink-muted">{fact.label}:</dt>
                  <dd className="font-semibold text-ink">{fact.value}</dd>
                </div>
              ))}
            </dl>
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

      {error && (
        <Banner tone="danger" className="mb-4">
          {error}
        </Banner>
      )}

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
                  Hlavního stavbyvedoucího lze změnit na jiného stavbyvedoucího tohoto projektu s číslem ČKAIT. Nejdřív ho přidejte v záložce Členové.
                </p>
              )}
              {showSiteManager && (
                <form onSubmit={changeSiteManager} className="mt-2 space-y-3 rounded border border-line bg-page p-3">
                  {/* A refusal of the server is the select's error: announced at once and tied to the field. */}
                  <Field
                    id="newSiteManager"
                    label="Nový stavbyvedoucí (člen projektu s číslem ČKAIT)"
                    error={
                      siteManagerError ? (
                        <>
                          {siteManagerError}
                          {siteManagerStale && (
                            <>
                              {" "}
                              <button type="button" onClick={reloadForSiteManager} className="font-semibold underline">
                                Načíst znovu
                              </button>
                            </>
                          )}
                        </>
                      ) : undefined
                    }
                  >
                    <Select name="newSiteManager" value={newSiteManagerId} onChange={(e) => setNewSiteManagerId(e.target.value)} required>
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
                    </Select>
                  </Field>
                  <Field
                    id="siteManagerReason"
                    label="Důvod změny (nepovinné, zůstane v záznamu o změnách)"
                    error={siteManagerReason.length > 1000 ? `${siteManagerReason.length} / 1000 znaků: text je příliš dlouhý` : undefined}
                    errorRole="status"
                  >
                    <TextArea name="siteManagerReason" value={siteManagerReason} onChange={(e) => setSiteManagerReason(e.target.value)} rows={2} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" size="sm" disabled={changingSiteManager || !newSiteManagerId || siteManagerReason.length > 1000}>
                      {changingSiteManager ? "Ukládám..." : "Změnit stavbyvedoucího"}
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      onClick={() => {
                        setShowSiteManager(false);
                        setSiteManagerError("");
                        setSiteManagerStale(false);
                      }}
                    >
                      Zrušit
                    </Button>
                  </div>
                </form>
              )}
            </div>
            <div>
              <span className="text-gray-500">{LABELS.builder}:</span>
              <p className="font-medium text-gray-900">{project.builder || "Nespecifikován"}</p>
            </div>
            <div>
              <span className="text-gray-500">{LABELS.contractor}:</span>
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
                <span className="text-gray-500">{LABELS.permitNumber}:</span>
                <p className="font-medium text-gray-900">
                  {project.permitNumber}
                  {project.permitDate ? ` ze dne ${formatDate(project.permitDate)}` : ""}
                </p>
              </div>
            )}
            {!project.permitNumber && project.permitDate && (
              <div>
                <span className="text-gray-500">{LABELS.permitDate}:</span>
                <p className="font-medium text-gray-900">{formatDate(project.permitDate)}</p>
              </div>
            )}
            {project.designerName && (
              <div>
                <span className="text-gray-500">{LABELS.designerName}:</span>
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
                <span className="text-gray-500">{LABELS.subcontractors}:</span>
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
            <>
              {/*
                One row per entry, and the whole row is the link (the day and the number are the link's text, stretched over the row, so a
                screen reader hears one name and a thumb needs no aim). The state, the author and the marks are on the row; the PDF is a
                button above the link.
              */}
              <ul className="divide-y divide-line">
                {reports.map((r) => (
                  <li
                    key={r.id}
                    className="relative flex flex-col gap-1 py-3 focus-within:bg-neutral-soft hover:bg-neutral-soft sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:py-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <Link
                        to={`/projects/${id}/reports/${r.date}`}
                        className="inline-flex min-h-11 items-center font-semibold text-primary-ink tabular-nums after:absolute after:inset-0 after:content-[''] hover:underline sm:pointer-fine:min-h-0"
                      >
                        <time dateTime={r.date}>{formatDayWithWeekday(r.date)}</time>
                        <span className="ml-2 font-normal text-ink-muted">· {entryNumberLabel(r.sequenceNumber)}</span>
                      </Link>
                      <div className="flex flex-wrap items-center gap-2">
                        <EntryStateBadge state={r.isSigned ? "signed" : "draft"} />
                        {r.isLateEntry && <LateEntryBadge />}
                        {r.isControlDay && <ControlDayBadge />}
                      </div>
                      {r.authorName && <p className="text-sm text-ink-muted">Autor: {r.authorName}</p>}
                      <p className="line-clamp-2 text-sm text-ink">{r.workDescription || "Denní záznam stavebních prací"}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDownloadPdf(r)}
                      aria-label={`Stáhnout PDF záznamu z ${formatDay(r.date)}`}
                      className="relative z-10 inline-flex min-h-11 items-center self-start px-2 text-sm text-ink-muted underline hover:text-ink sm:px-0 sm:pointer-fine:min-h-0"
                    >
                      PDF
                    </button>
                  </li>
                ))}
              </ul>
              {hasMoreReports && (
                <div className="pt-4 text-center">
                  <Button variant="secondary" onClick={() => void handleLoadOlderReports()}>
                    Načíst starší záznamy
                  </Button>
                </div>
              )}
            </>
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
              <h2 ref={personsHeading} tabIndex={-1} className="text-xl font-semibold text-ink focus:outline-none">
                Seznam pověřených osob
              </h2>
              {canManage && <Button onClick={() => setAddingPerson(true)}>Přidat osobu</Button>}
            </div>

            {addingPerson && (
              <AddPersonDialog
                projectId={id ?? ""}
                onCancel={() => setAddingPerson(false)}
                onAdded={(created) => {
                  setAddingPerson(false);
                  setAuthorizedPersons((prev) => [...prev, created]);
                }}
              />
            )}

            {revoking && (
              <ConfirmDialog
                title="Zrušit pověření?"
                confirmLabel="Zrušit pověření"
                cancelLabel="Ponechat"
                action={() => api<AuthorizedPerson>(`/api/authorized-persons/${revoking.id}/revoke`, { method: "POST" })}
                onDone={(revoked) => {
                  setRevoking(null);
                  setAuthorizedPersons((prev) => prev.map((p) => (p.id === revoked.id ? revoked : p)));
                  personsHeading.current?.focus();
                }}
                onCancel={() => setRevoking(null)}
              >
                Pověřená osoba {revoking.name} už nebude platná. Zrušení pověření nejde vzít zpět; záznamy, které už byly podepsány, ji uvádějí dál.
              </ConfirmDialog>
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
                        <Button variant="danger-quiet" size="sm" onClick={() => setRevoking(p)}>
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
            <div className={canManage ? "mb-6 flex flex-wrap items-end gap-4" : "hidden"}>
              {/* Native selects (the browser's own list: the keyboard, a screen reader and the picker of a phone all work). A person who is a member
                  already is shown as they are, to change their role or scope; anybody else gets their own role as the one offered. */}
              {/* max-w-full: a native select is as wide as its longest option, and a login name of 60 letters must not widen the page */}
              <Field id="member-user" label="Uživatel" className="max-w-full min-w-[14rem] flex-1 sm:max-w-sm">
                <Select value={selectedUserId} onChange={(e) => pickUser(e.target.value)}>
                  <option value="">{userOptions.length === 0 ? "Žádní uživatelé k výběru" : "Vyberte uživatele"}</option>
                  {userOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} ({u.nickname})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field id="member-role" label="Role v projektu" className="max-w-full min-w-[12rem] flex-1 sm:max-w-60">
                <Select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)}>
                  {Object.entries(ROLE_LABELS).map(([role, label]) => (
                    <option key={role} value={role}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>

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
                  {selectedUser?.displayName} nemá číslo ČKAIT, a proto nemůže být stavbyvedoucím (podepisuje záznamy). Číslo doplní administrátor v seznamu uživatelů.
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

/**
 * The dialog that adds an authorised person (the persons whom the diary names, with the scope of their authorisation or function).
 * It holds typed text, so Escape and "Zrušit" ask before they throw it away; while it saves it cannot be dismissed; and what the
 * server refuses is said inside it.
 */
function AddPersonDialog({ projectId, onAdded, onCancel }: { projectId: string; onAdded: (created: AuthorizedPerson) => void; onCancel: () => void }) {
  const modal = useRef<ModalHandle>(null);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const dirty = name !== "" || company !== "" || authorization !== "";
  useUnsavedWork(dirty);
  const stalled = useStalled(saving);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setProblem("");
    try {
      const created = await api<AuthorizedPerson>(`/api/projects/${projectId}/authorized-persons`, {
        method: "POST",
        body: json({ name, company: company || null, authorization: authorization || null }),
      });
      modal.current?.close(() => onAdded(created), { restoreFocus: true });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Pověřenou osobu se nepodařilo uložit");
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Přidat pověřenou osobu"
      handleRef={modal}
      unsaved={dirty}
      dismissible={!saving || stalled}
      onCancel={onCancel}
      footer={<FormActions formId="add-person-form" submitLabel="Uložit" busy={saving} stalled={stalled} />}
    >
      <form id="add-person-form" onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field id="person-name" label="Jméno a příjmení / Titul">
          <TextInput type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="person-company" label="Organizace / Společnost">
          <TextInput type="text" value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field id="person-auth" label="Rozsah pověření / Funkce">
          <TextInput type="text" value={authorization} onChange={(e) => setAuthorization(e.target.value)} />
        </Field>
        {problem && <Banner tone="danger">{problem}</Banner>}
        {stalled && <StalledNotice>Nevíme, jestli se osoba uložila. Zkontrolujte seznam pověřených osob po zavření dialogu a případně ji přidejte znovu.</StalledNotice>}
      </form>
    </Modal>
  );
}
