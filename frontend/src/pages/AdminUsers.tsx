import React, { useState } from "react";

interface User {
  id: string;
  nickname: string;
  displayName: string;
  role: string;
  isActive: boolean;
}

export const AdminUsers: React.FC = () => {
  const [users, setUsers] = useState<User[]>([
    { id: "1", nickname: "e2e-admin", displayName: "E2E Admin", role: "BOSS", isActive: true },
    { id: "2", nickname: "e2e-investor", displayName: "E2E Investor", role: "INVESTOR", isActive: true },
  ]);

  // Create User Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createStep, setCreateStep] = useState<"form" | "credentials">("form");
  const [newNickname, setNewNickname] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [generatedPassword, setGeneratedPassword] = useState("");

  // Edit User Modal State
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");

  const handleOpenCreate = () => {
    setNewNickname("");
    setNewDisplayName("");
    setGeneratedPassword("");
    setCreateStep("form");
    setShowCreateModal(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNickname || !newDisplayName) return;

    const pwd = "Password123!";
    setGeneratedPassword(pwd);

    const createdUser: User = {
      id: Date.now().toString(),
      nickname: newNickname,
      displayName: newDisplayName,
      role: "WORKER",
      isActive: true,
    };

    setUsers((prev) => [...prev, createdUser]);
    setCreateStep("credentials");
  };

  const handleFinishCreate = () => {
    if (window.confirm("Heslo se po zavření nezobrazí. Máte údaje bezpečně uloženy?")) {
      setShowCreateModal(false);
      setCreateStep("form");
    }
  };

  const handleOpenEdit = (user: User) => {
    setEditingUser(user);
    setEditDisplayName(user.displayName);
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    setUsers((prev) => prev.map((u) => (u.id === editingUser.id ? { ...u, displayName: editDisplayName } : u)));
    setEditingUser(null);
  };

  const handleToggleActive = (user: User) => {
    const actionName = user.isActive ? "deaktivovat" : "aktivovat";
    if (window.confirm(`Opravdu chcete uživatele ${actionName}?`)) {
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, isActive: !u.isActive } : u)));
    }
  };

  const handleDeleteUser = (user: User) => {
    if (window.confirm("Opravdu chcete uživatele smazat?")) {
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    }
  };

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
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-6 py-4 text-sm font-medium whitespace-nowrap text-gray-900">{user.nickname}</td>
                <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-700">{user.displayName}</td>
                <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-500">{user.role}</td>
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
                  <button type="button" onClick={() => handleToggleActive(user)} className="text-amber-600 hover:text-amber-900">
                    {user.isActive ? "Deaktivovat" : "Aktivovat"}
                  </button>
                  <button type="button" onClick={() => handleDeleteUser(user)} className="text-red-600 hover:text-red-900">
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
              <form onSubmit={handleCreateSubmit} className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Přihlašovací jméno (nickname)</label>
                  <input
                    name="nickname"
                    type="text"
                    required
                    value={newNickname}
                    onChange={(e) => setNewNickname(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Jméno a příjmení (displayName)</label>
                  <input
                    name="displayName"
                    type="text"
                    required
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2 text-sm"
                  />
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

      {/* Edit User Modal */}
      {editingUser && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Upravit uživatele</h3>
            <form onSubmit={handleSaveEdit} className="space-y-4">
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
