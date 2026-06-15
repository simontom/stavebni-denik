import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { requireBoss } from "@/server/rbac";
import { listUsers } from "@/server/services/users";

import { CreateUserDialog } from "./CreateUserDialog";
import { ToggleActiveButton } from "./ToggleActiveButton";

export const metadata: Metadata = { title: "Uživatelé" };
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<"BOSS" | "WORKER" | "GUEST", string> = {
  BOSS: "Stavbyvedoucí",
  WORKER: "Pracovník",
  GUEST: "Dozor / TDS",
};

export default async function AdminUsersPage() {
  await requireBoss();
  const users = await listUsers();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Uživatelé</CardTitle>
            <CardDescription>
              Přidávejte stavbyvedoucí, pracovníky a dozor. Heslo se vygeneruje
              automaticky a zobrazí pouze jednou — předejte ho uživateli
              bezpečným kanálem.
            </CardDescription>
          </div>
          <CreateUserDialog />
        </CardHeader>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Přihlašovací jméno</TableHead>
              <TableHead>Jméno</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>ČKAIT</TableHead>
              <TableHead>Stav</TableHead>
              <TableHead>Vytvořen</TableHead>
              <TableHead className="text-right">Akce</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground"
                >
                  Žádní uživatelé. Přidejte prvního pracovníka.
                </TableCell>
              </TableRow>
            )}
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-mono text-sm">{u.nickname}</TableCell>
                <TableCell>{u.displayName}</TableCell>
                <TableCell>
                  <Badge variant={u.role === "BOSS" ? "default" : "secondary"}>
                    {ROLE_LABEL[u.role]}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {u.ckaitNumber ?? "—"}
                </TableCell>
                <TableCell>
                  {u.isActive ? (
                    u.mustChangePwd ? (
                      <Badge variant="outline">Čeká na 1. přihlášení</Badge>
                    ) : (
                      <Badge variant="secondary">Aktivní</Badge>
                    )
                  ) : (
                    <Badge variant="destructive">Deaktivován</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(u.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <ToggleActiveButton
                    userId={u.id}
                    isActive={u.isActive}
                    displayName={u.displayName}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
