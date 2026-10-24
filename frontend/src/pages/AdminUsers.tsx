import React, { useEffect, useRef, useState } from "react";
import { api, currentUser, json, ROLE_LABELS } from "../lib/api";
import { usePageTitle } from "../lib/pageTitle";
import { useStalled } from "../lib/useStalled";
import { useUnsavedWork } from "../lib/useUnsavedWork";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { OneTimePasswordDialog } from "../components/OneTimePasswordDialog";
import { Banner, Button, Field, FormActions, Modal, Select, StalledNotice, TextInput, type ModalHandle } from "../components/ui";

interface User {
  id: string;
  nickname: string;
  displayName: string;
  role: string;
  isAdmin: boolean;
  isActive: boolean;
  /** Professional authorization (ČKAIT); a person who manages a project or signs its diary needs one. */
  ckaitNumber?: string | null;
  /** In the answer to a save or a deactivation only: the ČKAIT number of somebody who manages a project was changed or removed, or a site manager was deactivated. */
  warning?: string | null;
}

interface CreateUserResponse {
  user: User;
  initialPassword: string;
}

/** A question about a user that is open: which one it is, and about whom. */
type Question = { kind: "deactivate" | "activate" | "reset" | "delete"; user: User };

/** A temporary password that is shown once (the page keeps it only until the dialog that shows it is closed). */
interface Issued {
  title: string;
  intro: string;
  nickname: string;
  password: string;
}

const RoleSelect = ({ id, value, onChange }: { id: string; value: string; onChange: (role: string) => void }) => (
  <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
    {Object.entries(ROLE_LABELS).map(([key, label]) => (
      <option key={key} value={key}>
        {label}
      </option>
    ))}
  </Select>
);

export const AdminUsers: React.FC = () => {
  usePageTitle("Uživatelé");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // What the server wants the administrator to know after a save (a changed ČKAIT number of a manager of a project) or a
  // deactivation (projects left without an active site manager).
  const [notice, setNotice] = useState("");

  // The overlays. Each one is the state of this page's own, and is taken off the screen the moment it is answered.
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  // The temporary password, shown once. It is in no other state: closing the dialog that shows it clears it.
  const [issued, setIssued] = useState<Issued | null>(null);
  const newUserButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let ignore = false;
    api<User[]>("/api/users")
      .then((data) => {
        if (!ignore) setUsers(data);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : "Chyba při načítání uživatelů");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const replaceUser = (updated: User) => setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));

  /** The question a button asks, with the action it stands for. A refusal of the server is said inside the dialog. */
  const askAbout = (q: Question) => {
    const { user } = q;
    const done = () => setQuestion(null);
    switch (q.kind) {
      case "deactivate":
        return (
          <ConfirmDialog
            title="Deaktivovat uživatele?"
            confirmLabel="Deaktivovat"
            cancelLabel="Zrušit"
            action={() => api<User>(`/api/users/${user.id}/deactivate`, { method: "POST" })}
            onDone={(updated) => {
              replaceUser({ ...updated, warning: undefined });
              // Deactivating a site manager is allowed, and the answer says which projects are left without an active one.
              setNotice(updated.warning ?? "");
              done();
            }}
            onCancel={done}
          >
            Uživatel {user.nickname} se nebude moci přihlásit a jeho přihlášení skončí. Účet půjde znovu aktivovat.
          </ConfirmDialog>
        );
      case "activate":
        return (
          <ConfirmDialog
            title="Aktivovat uživatele?"
            confirmLabel="Aktivovat"
            cancelLabel="Zrušit"
            destructive={false}
            action={() => api<User>(`/api/users/${user.id}/activate`, { method: "POST" })}
            onDone={(updated) => {
              replaceUser({ ...updated, warning: undefined });
              setNotice(updated.warning ?? "");
              done();
            }}
            onCancel={done}
          >
            Uživatel {user.nickname} se bude moci znovu přihlásit.
          </ConfirmDialog>
        );
      case "reset":
        return (
          <ConfirmDialog
            title="Obnovit heslo?"
            confirmLabel="Obnovit heslo"
            cancelLabel="Zrušit"
            leaveMessage="Heslo se právě mění; když odejdete, nové heslo se nezobrazí a bude potřeba ho obnovit znovu."
            stalledNote="Nevíme, jestli se heslo změnilo (nové heslo by se už nezobrazilo). Ověřte to po zavření dialogu; v případě pochybností heslo obnovte znovu."
            action={() => api<{ initialPassword: string }>(`/api/users/${user.id}/reset-password`, { method: "POST" })}
            onDone={(result) => {
              done();
              setIssued({
                title: "Heslo bylo obnoveno",
                intro: "Předejte tyto údaje uživateli. Při přihlášení si zvolí vlastní heslo. Dočasné heslo platí 7 dní.",
                nickname: user.nickname,
                password: result.initialPassword,
              });
            }}
            onCancel={done}
          >
            Uživateli {user.nickname} se vygeneruje nové dočasné heslo. Stávající heslo i všechna jeho přihlášení přestanou platit.
          </ConfirmDialog>
        );
      case "delete":
        return (
          <ConfirmDialog
            title="Smazat uživatele?"
            confirmLabel="Smazat"
            cancelLabel="Zrušit"
            action={() => api<void>(`/api/users/${user.id}`, { method: "DELETE" })}
            onDone={() => {
              setUsers((prev) => prev.filter((u) => u.id !== user.id));
              // The button that asked is gone with the row: the focus goes to the first thing of the page, not to the top of the document.
              newUserButton.current?.focus();
              done();
            }}
            onCancel={done}
          >
            Uživatel {user.nickname} se už nebude moci přihlásit a zmizí ze seznamu. Podepsané záznamy zůstanou beze změny.
          </ConfirmDialog>
        );
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      {/* Title & Actions */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Uživatelé</h1>
          <p className="mt-1 text-sm text-ink-muted">Správa uživatelských účtů a oprávnění v systému.</p>
        </div>
        <Button ref={newUserButton} onClick={() => setCreating(true)}>
          Nový uživatel
        </Button>
      </div>

      {error && (
        <Banner tone="danger" className="mb-4">
          {error}
        </Banner>
      )}
      {notice && (
        <div role="status" className="mb-4 flex items-start justify-between gap-4 rounded bg-amber-100 p-3 text-sm text-amber-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="shrink-0 font-semibold underline">
            Zavřít
          </button>
        </div>
      )}

      {/* Users Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        {/* A list of users on a phone (max-xl:table-cards, index.css: a table of 1250 px does not fit under 1280); the actions of a user are a row of buttons of 44 px. */}
        <table className="min-w-full divide-y divide-gray-200 max-xl:table-cards">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">
                Přihlašovací jméno
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">
                Jméno a příjmení
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">
                Role
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">
                Stav
              </th>
              <th scope="col" className="px-6 py-3 text-right text-xs font-medium tracking-wider text-gray-500 uppercase">
                Akce
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {loading && (
              <tr>
                <td colSpan={5} className="px-6 py-4 text-sm text-gray-500">
                  Načítání…
                </td>
              </tr>
            )}
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-6 py-4 text-sm font-medium whitespace-nowrap text-gray-900">{user.nickname}</td>
                <td data-label="Jméno" className="px-6 py-4 text-sm whitespace-nowrap text-gray-700">
                  {user.displayName}
                </td>
                <td data-label="Role" className="px-6 py-4 text-sm whitespace-nowrap text-gray-500">
                  {ROLE_LABELS[user.role] ?? user.role}
                  {user.isAdmin && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">administrátor</span>}
                  {user.ckaitNumber && <span className="ml-2 text-xs text-gray-500">ČKAIT {user.ckaitNumber}</span>}
                </td>
                <td data-label="Stav" className="px-6 py-4 text-sm whitespace-nowrap">
                  {user.isActive ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">Aktivní (přihlášení povoleno)</span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">Deaktivován</span>
                  )}
                </td>
                <td className="space-x-2 px-6 py-4 text-right text-sm font-medium whitespace-nowrap">
                  <button type="button" onClick={() => setEditing(user)} className="text-indigo-600 hover:text-indigo-900">
                    Upravit
                  </button>
                  <button type="button" onClick={() => setQuestion({ kind: "reset", user })} className="text-gray-600 hover:text-gray-900">
                    Obnovit heslo
                  </button>
                  <button type="button" onClick={() => setQuestion({ kind: user.isActive ? "deactivate" : "activate", user })} className="text-amber-700 hover:text-amber-900">
                    {user.isActive ? "Deaktivovat" : "Aktivovat"}
                  </button>
                  <button type="button" onClick={() => setQuestion({ kind: "delete", user })} className="text-red-600 hover:text-red-900">
                    Smazat
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateUserDialog
          onCancel={() => setCreating(false)}
          onCreated={({ user, initialPassword }) => {
            setCreating(false);
            setUsers((prev) => [...prev, user].sort((a, b) => a.nickname.localeCompare(b.nickname)));
            setIssued({
              title: "Uživatel byl vytvořen",
              intro: "Předejte tyto údaje uživateli pro jeho první přihlášení. Heslo platí 7 dní; pak je nutné vygenerovat nové.",
              nickname: user.nickname,
              password: initialPassword,
            });
          }}
        />
      )}

      {editing && (
        <EditUserDialog
          user={editing}
          onCancel={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            replaceUser({ ...updated, warning: undefined });
            setNotice(updated.warning ?? "");
          }}
        />
      )}

      {question && askAbout(question)}

      {issued && <OneTimePasswordDialog title={issued.title} intro={issued.intro} nickname={issued.nickname} password={issued.password} onClosed={() => setIssued(null)} />}
    </div>
  );
};

/** A new account: a login name, a name, a role and (for a manager of a project) a ČKAIT number. The server makes the temporary password. */
function CreateUserDialog({ onCreated, onCancel }: { onCreated: (result: CreateUserResponse) => void; onCancel: () => void }) {
  const modal = useRef<ModalHandle>(null);
  const [nickname, setNickname] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("WORKER");
  const [ckait, setCkait] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  // Typed text: Escape and "Zrušit" ask before they throw it away, and a page that is left asks too.
  const dirty = nickname !== "" || displayName !== "" || role !== "WORKER" || ckait !== "";
  useUnsavedWork(dirty);
  const stalled = useStalled(saving);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !nickname || !displayName) return;
    setSaving(true);
    setProblem("");
    try {
      const created = await api<CreateUserResponse>("/api/users", { method: "POST", body: json({ nickname, displayName, role, ckaitNumber: ckait }) });
      modal.current?.close(() => onCreated(created), { restoreFocus: true });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Chyba při vytváření uživatele");
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Vytvořit nového uživatele"
      handleRef={modal}
      unsaved={dirty}
      dismissible={!saving || stalled}
      onCancel={onCancel}
      footer={<FormActions formId="create-user-form" submitLabel="Vytvořit" busy={saving} stalled={stalled} />}
    >
      <form id="create-user-form" onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field id="new-nickname" label="Přihlašovací jméno">
          <TextInput name="nickname" type="text" required value={nickname} onChange={(e) => setNickname(e.target.value)} />
        </Field>
        <Field id="new-displayName" label="Jméno a příjmení">
          <TextInput name="displayName" type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field id="new-role" label="Role">
          <RoleSelect id="new-role" value={role} onChange={setRole} />
        </Field>
        <Field id="new-ckait" label="Číslo ČKAIT (stavbyvedoucí a podepisující)">
          <TextInput name="ckaitNumber" type="text" value={ckait} onChange={(e) => setCkait(e.target.value)} />
        </Field>
        {problem && <Banner tone="danger">{problem}</Banner>}
        {stalled && (
          <StalledNotice>Nevíme, jestli se účet vytvořil. Zkontrolujte seznam uživatelů; pokud vznikl, jeho heslo už nejde zobrazit a je potřeba ho obnovit.</StalledNotice>
        )}
      </form>
    </Modal>
  );
}

/** A change of an account's name, role and ČKAIT number. An administrator cannot change their own number (the server refuses). */
function EditUserDialog({ user, onSaved, onCancel }: { user: User; onSaved: (updated: User) => void; onCancel: () => void }) {
  const modal = useRef<ModalHandle>(null);
  const own = user.id === currentUser()?.id;
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [ckait, setCkait] = useState(user.ckaitNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const dirty = displayName !== user.displayName || role !== user.role || (!own && ckait !== (user.ckaitNumber ?? ""));
  useUnsavedWork(dirty);
  const stalled = useStalled(saving);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setProblem("");
    try {
      // An administrator cannot change their own number (the server refuses): it is not sent for their own account.
      const body = own ? { displayName, role } : { displayName, role, ckaitNumber: ckait };
      const updated = await api<User>(`/api/users/${user.id}`, { method: "PATCH", body: json(body) });
      modal.current?.close(() => onSaved(updated), { restoreFocus: true });
    } catch (err) {
      // Said here, in the dialog that asked: a banner on the page behind it would be out of sight.
      setProblem(err instanceof Error ? err.message : "Chyba při ukládání");
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Upravit uživatele"
      handleRef={modal}
      unsaved={dirty}
      dismissible={!saving || stalled}
      onCancel={onCancel}
      footer={<FormActions formId="edit-user-form" submitLabel="Uložit změny" busy={saving} stalled={stalled} />}
    >
      <form id="edit-user-form" onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field id="edit-displayName" label="Jméno a příjmení">
          <TextInput type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field id="edit-role" label="Role">
          <RoleSelect id="edit-role" value={role} onChange={setRole} />
        </Field>
        <Field
          id="edit-ckait"
          label="Číslo ČKAIT (stavbyvedoucí a podepisující)"
          hint={own ? "Své číslo ČKAIT si administrátor měnit nemůže. Požádejte jiného administrátora." : undefined}
        >
          <TextInput type="text" value={ckait} disabled={own} onChange={(e) => setCkait(e.target.value)} />
        </Field>
        {problem && <Banner tone="danger">{problem}</Banner>}
        {stalled && <StalledNotice>Nevíme, jestli se změna uložila. Zkontrolujte účet v seznamu po zavření dialogu a případně ji zopakujte.</StalledNotice>}
      </form>
    </Modal>
  );
}
