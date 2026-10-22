import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../../lib/api";
import { buttonClasses, Card, PageState } from "../../components/ui";

interface Project {
  id: string;
  name: string;
  address: string;
}

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
          <h1 className="text-ink text-xl font-semibold sm:text-base sm:leading-6">Projekty</h1>
          <p className="text-ink-muted mt-2 text-sm">Seznam všech vašich stavebních projektů a deníků.</p>
        </div>
        <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <Link to="/projects/new" className={buttonClasses({ block: true })}>
            Přidat projekt
          </Link>
        </div>
      </div>
      {/*
        A list of cards, on a phone and on a desktop alike: the name, the address, and the whole card is the link (the name is the link's
        text, stretched over the card, so a thumb needs no aim and a screen reader hears the project's name, not a sentence).
        The state of today's entry and an empty-list message are backlog B4.
      */}
      <ul className="mt-6 space-y-3 sm:mt-8">
        {projects.map((project) => (
          <Card as="li" compact key={project.id} className="hover:border-input focus-within:border-input relative flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-6">
            <Link to={`/projects/${project.id}`} className="text-ink flex min-h-11 items-center font-medium after:absolute after:inset-0 after:content-[''] hover:underline sm:w-1/3 sm:flex-none">
              {project.name}
            </Link>
            <span className="text-ink-muted text-sm sm:flex-auto">{project.address}</span>
          </Card>
        ))}
      </ul>
    </div>
  );
}
