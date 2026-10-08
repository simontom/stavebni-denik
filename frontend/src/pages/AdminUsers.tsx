import React, { useEffect, useState } from "react";
import { api, json, ROLE_LABELS } from "../lib/api";

interface User {
  id: string;
  nickname: string;
  displayName: string;
  role: string;
  isAdmin: boolean;
  isActive: boolean;
}

interface CreateUserResponse {
  user: User;
  initialPassword: string;
}

export const AdminUsers: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create User Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createStep, setCreateStep] = useState<"form" | "credentials">("form");
  const [newNickname, setNewNickname] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState("WORKER");
  const [generatedPassword, setGeneratedPassword] = useState("");
  const [createError, setCreateError] = useState("");

  // Password reset result (the password is shown once)
  const [resetResult, setResetResult] = useState<{ nickname: string; password: string } | null>(null);

  // Edit User Modal State
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editRole, setEditRole] = useState("WORKER");

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

  const handleOpenCreate = () => {
    setNewNickname("");
    setNewDisplayName("");
    setNewRole("WORKER");
    setGeneratedPassword("");
    setCreateError("");
    setCreateStep("form");
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNickname || !newDisplayName) return;
    try {
      const created = await api<CreateUserResponse>("/api/users", {
        method: "POST",
        body: json({ nickname: newNickname, displayName: newDisplayName, role: newRole }),
      });
      setGeneratedPassword(created.initialPassword);
      setUsers((prev) => [...prev, created.user].sort((a, b) => a.nickname.localeCompare(b.nickname)));
      setCreateStep("credentials");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Chyba při vytváření uživatele");
    }
  };

  const handleFinishCreate = () => {
    if (window.confirm("Heslo se po zavření nezobrazí. Máte údaje bezpečně uloženy?")) {
      setShowCreateModal(false);
      setCreateStep("form");
      setGeneratedPassword("");
    }
  };

  const handleOpenEdit = (user: User) => {
    setEditingUser(user);
    setEditDisplayName(user.displayName);
    setEditRole(user.role);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      const updated = await api<User>(`/api/users/${editingUser.id}`, {
        method: "PATCH",
        body: json({ displayName: editDisplayName, role: editRole }),
      });
      replaceUser(updated);
      setEditingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chyba při ukládání");
    }
  };

  const handleToggleActive = async (user: User) => {
    const actionName = user.isActive ? "deaktivovat" : "aktivovat";
    if (!window.confirm(`Opravdu chcete uživatele ${actionName}?`)) return;
    try {
      const updated = await api<User>(`/api/users/${user.id}/${user.isActive ? "deactivate" : "activate"}`, { method: "POST" });
      replaceUser(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Akce se nezdařila");
    }
  };

  const handleResetPassword = async (user: User) => {
    if (!window.confirm(`Vygenerovat uživateli ${user.nickname} nové dočasné heslo? Stávající heslo i všechna jeho přihlášení přestanou platit.`)) return;
    try {
      const result = await api<{ initialPassword: string }>(`/api/users/${user.id}/reset-password`, { method: "POST" });
      setResetResult({ nickname: user.nickname, password: result.initialPassword });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Heslo se nepodařilo obnovit");
    }
  };

  const handleDeleteUser = async (user: User) => {
    if (!window.confirm("Opravdu chcete uživatele smazat?")) return;
    try {
      await api<void>(`/api/users/${user.id}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smazání se nezdařilo");
    }
  };

  const roleSelect = (value: string, onChange: (v: string) => void, id: string) => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-gray-300 p-2 text-sm">
      {Object.entries(ROLE_LABELS).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Title & Actions */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="text-2xl font-bold text-gray-900">Uživatelé</div>
          <p className="mt-1 text-sm text-gray-500">Správa uživatelských účtů a oprávnění v systému.</p>
        </div>
        <button type="button" onClick={handleOpenCreate} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
          Nový uživatel
        </button>
      </div>

      {error && <div className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      {/* Users Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
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
                <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-700">{user.displayName}</td>
                <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-500">
                  {ROLE_LABELS[user.role] ?? user.role}
                  {user.isAdmin && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">admin</span>}
                </td>
                <td className="px-6 py-4 text-sm whitespace-nowrap">
                  {user.isActive ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">Aktivní (přihlášení povoleno)</span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">Deaktivován</span>
                  )}
                </td>
                <td className="space-x-2 px-6 py-4 text-right text-sm font-medium whitespace-nowrap">
                  <button type="button" onClick={() => handleOpenEdit(user)} className="text-indigo-600 hover:text-indigo-900">
                    Upravit
                  </button>
                  <button type="button" onClick={() => void handleResetPassword(user)} className="text-gray-600 hover:text-gray-900">
                    Obnovit heslo
                  </button>
                  <button type="button" onClick={() => void handleToggleActive(user)} className="text-amber-600 hover:text-amber-900">
                    {user.isActive ? "Deaktivovat" : "Aktivovat"}
                  </button>
                  <button type="button" onClick={() => void handleDeleteUser(user)} className="text-red-600 hover:text-red-900">
                    Smazat
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Vytvořit nového uživatele</h3>

            {createStep === "form" ? (
              <form onSubmit={(e) => void handleCreateSubmit(e)} className="space-y-4">
                {createError && <div className="rounded bg-red-100 p-2 text-sm text-red-700">{createError}</div>}
                <div>
                  <label htmlFor="new-nickname" className="mb-1 block text-sm font-medium text-gray-700">
                    Přihlašovací jméno (nickname)
                  </label>
                  <input
                    id="new-nickname"
                    name="nickname"
                    type="text"
                    required
                    value={newNickname}
                    onChange={(e) => setNewNickname(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="new-displayName" className="mb-1 block text-sm font-medium text-gray-700">
                    Jméno a příjmení (displayName)
                  </label>
                  <input
                    id="new-displayName"
                    name="displayName"
                    type="text"
                    required
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="new-role" className="mb-1 block text-sm font-medium text-gray-700">
                    Role
                  </label>
                  {roleSelect(newRole, setNewRole, "new-role")}
                </div>
                <div className="flex justify-end gap-2 border-t pt-2">
                  <button type="button" onClick={() => setShowCreateModal(false)} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                    Zrušit
                  </button>
                  <button type="submit" className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">
                    Vytvořit
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-900">
                  <p className="font-semibold">Uživatel byl úspěšně vytvořen!</p>
                  <p className="mt-1">Předejte tyto údaje uživateli pro jeho první přihlášení:</p>
                  <div className="mt-3 space-y-1 rounded border border-green-300 bg-white p-2 font-mono text-xs">
                    <div>
                      <strong>Uživatel:</strong> {newNickname}
                    </div>
                    <div>
                      <strong>Heslo:</strong> {generatedPassword}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end border-t pt-2">
                  <button type="button" onClick={handleFinishCreate} className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">
                    Hotovo
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Password reset result */}
      {resetResult && (
        <div role="dialog" aria-modal="true" aria-label="Nové heslo" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Heslo bylo obnoveno</h3>
            <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-900">
              <p>Předejte tyto údaje uživateli. Při přihlášení si zvolí vlastní heslo.</p>
              <div className="mt-3 space-y-1 rounded border border-green-300 bg-white p-2 font-mono text-xs">
                <div>
                  <strong>Uživatel:</strong> {resetResult.nickname}
                </div>
                <div>
                  <strong>Heslo:</strong> {resetResult.password}
                </div>
              </div>
            </div>
            <div className="flex justify-end border-t pt-2">
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Heslo se po zavření nezobrazí. Máte údaje bezpečně uloženy?")) setResetResult(null);
                }}
                className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                Hotovo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Upravit uživatele</h3>
            <form onSubmit={(e) => void handleSaveEdit(e)} className="space-y-4">
              <div>
                <label htmlFor="edit-displayName" className="mb-1 block text-sm font-medium text-gray-700">
                  Jméno a příjmení
                </label>
                <input
                  id="edit-displayName"
                  type="text"
                  required
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  className="w-full rounded-md border border-gray-300 p-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="edit-role" className="mb-1 block text-sm font-medium text-gray-700">
                  Role
                </label>
                {roleSelect(editRole, setEditRole, "edit-role")}
              </div>
              <div className="flex justify-end gap-2 border-t pt-2">
                <button type="button" onClick={() => setEditingUser(null)} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                  Zrušit
                </button>
                <button type="submit" className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">
                  Uložit změny
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
