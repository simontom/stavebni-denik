import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, currentUser } from "../../lib/api";
import { usePageTitle } from "../../lib/pageTitle";
import { badgeClassName, buttonClasses, Card, cn, PageState, StatusBadge, type BadgeTone } from "../../components/ui";

/** Today's entry of a project, as the list of projects sends it (the day is the server's "today" in Prague). */
interface TodayEntry {
  date: string;
  state: "NONE" | "DRAFT" | "SIGNED";
  reportId?: string | null;
}

interface Project {
  id: string;
  name: string;
  address: string;
  /** The person's role in this project; null for an administrator who is not a member. */
  myRole?: string | null;
  todayEntry?: TodayEntry | null;
}

const TODAY_WORDS: Record<TodayEntry["state"], { text: string; tone: BadgeTone }> = {
  NONE: { text: "nezapsáno", tone: "neutral" },
  DRAFT: { text: "rozpracováno", tone: "warning" },
  SIGNED: { text: "podepsáno", tone: "success" },
};

/**
 * What state today's entry is in, as words ("Dnes: nezapsáno", "Dnes: rozpracováno", "Dnes: podepsáno"), and the way to it: a link
 * to that day, above the link that covers the whole card. A day nobody has written, seen by somebody who may not write it, has
 * nothing to open: the words stand alone.
 */
function TodayEntryLine({ project }: { project: Project }) {
  const today = project.todayEntry;
  if (!today) return null;
  const { text, tone } = TODAY_WORDS[today.state];
  const mayWrite = project.myRole === "BOSS" || project.myRole === "WORKER";
  const label = `Dnes: ${text}`;
  if (today.state === "NONE" && !mayWrite) {
    return (
      <StatusBadge tone={tone} outlined className="self-start sm:self-auto">
        {label}
      </StatusBadge>
    );
  }
  return (
    <Link
      to={`/projects/${project.id}/reports/${today.date}`}
      className={cn(badgeClassName({ tone, outlined: true }), "relative z-10 min-h-11 self-start px-3 hover:underline sm:flex-none sm:self-auto sm:pointer-fine:min-h-9")}
    >
      {label}
    </Link>
  );
}

export function ProjectList() {
  usePageTitle("Projekty");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Creating a project makes the creator its manager: it is for project managers (the global role), as the server decides.
  const mayCreate = currentUser()?.role === "BOSS";
  // An administrator sees every project (not only those they are a member of), so for them an empty list means there are none.
  const isAdmin = currentUser()?.isAdmin === true;

  useEffect(() => {
    apiFetch("/api/projects")
      .then((res) => {
        if (!res.ok) throw new Error("Chyba při načítání projektů");
        return res.json();
      })
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <PageState kind="loading">Načítání...</PageState>;
  if (error) return <PageState kind="error">{error}</PageState>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-xl font-semibold text-ink sm:text-base sm:leading-6">Projekty</h1>
          <p className="mt-2 text-sm text-ink-muted">Seznam všech vašich stavebních projektů a deníků.</p>
        </div>
        {mayCreate && projects.length > 0 && (
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <Link to="/projects/new" className={buttonClasses({ block: true })}>
              Přidat projekt
            </Link>
          </div>
        )}
      </div>
      {projects.length === 0 ? (
        <Card className="mt-6 sm:mt-8">
          <PageState
            kind="empty"
            action={
              mayCreate ? (
                <Link to="/projects/new" className={buttonClasses()}>
                  Přidat projekt
                </Link>
              ) : undefined
            }
          >
            {isAdmin
              ? `Zatím nejsou založeny žádné stavby.${mayCreate ? " Založte první a zapisujte do jejího deníku." : ""}`
              : mayCreate
                ? "Zatím nemáte žádný projekt. Založte první a zapisujte do jeho deníku."
                : "Zatím nejste členem žádného projektu. Projekt zakládá stavbyvedoucí; požádejte ho, aby vás do něj přidal."}
          </PageState>
        </Card>
      ) : (
        /*
        A list of cards, on a phone and on a desktop alike: the name, the address, and the whole card is the link (the name is the link's
        text, stretched over the card, so a thumb needs no aim and a screen reader hears the project's name, not a sentence). The state of
        today's entry is a second link on the card, above the stretched one: it opens that day.
      */
        <ul className="mt-6 space-y-3 sm:mt-8">
          {projects.map((project) => (
            <Card as="li" compact key={project.id} className="relative flex flex-col gap-1 focus-within:border-input hover:border-input sm:flex-row sm:items-center sm:gap-6">
              <Link
                to={`/projects/${project.id}`}
                className="flex min-h-11 items-center font-medium text-ink after:absolute after:inset-0 after:content-[''] hover:underline sm:w-1/3 sm:flex-none"
              >
                {project.name}
              </Link>
              <span className="text-sm text-ink-muted sm:flex-auto">{project.address}</span>
              <TodayEntryLine project={project} />
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}
