"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2, UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";

import { addMemberAction, removeMemberAction } from "./actions";

type Role = "BOSS" | "WORKER" | "GUEST";

const ROLE_LABEL: Record<Role, string> = {
  BOSS: "Stavbyvedoucí",
  WORKER: "Pracovník",
  GUEST: "Dozor / TDS",
};

export interface MemberRow {
  userId: string;
  displayName: string;
  nickname: string;
  projectRole: Role;
  addedAt: Date;
}

export interface AddableUser {
  id: string;
  displayName: string;
  nickname: string;
  role: Role;
}

interface Props {
  projectId: string;
  members: MemberRow[];
  addableUsers: AddableUser[];
  canManage: boolean;
}

function RemoveMemberButton({
  projectId,
  userId,
  displayName,
}: {
  projectId: string;
  userId: string;
  displayName: string;
}) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    if (
      !window.confirm(
        `Odebrat ${displayName} ze zakázky? Ztratí k ní přístup (historické záznamy zůstávají).`,
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("userId", userId);
    startTransition(() => {
      void removeMemberAction(fd);
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={handleClick}
      disabled={pending}
      aria-label={`Odebrat ${displayName}`}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="size-4 text-destructive" aria-hidden />
      )}
    </Button>
  );
}

export function MembersPanel({
  projectId,
  members,
  addableUsers,
  canManage,
}: Props) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<Role>("WORKER");
  const [pending, startTransition] = useTransition();

  function handleAdd() {
    if (!userId) return;
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("userId", userId);
    fd.append("role", role);
    startTransition(() => {
      void addMemberAction(fd);
      setUserId("");
      setRole("WORKER");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium">Přidat člena</span>
            <Select value={userId} onValueChange={(v) => setUserId(v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Vyberte uživatele">
                  {(value) => {
                    const found = addableUsers.find((u) => u.id === value);
                    return found
                      ? `${found.displayName} (${found.nickname})`
                      : "Vyberte uživatele";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {addableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName} ({u.nickname})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Role v zakázce</span>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue>
                  {(value) => ROLE_LABEL[value as Role] ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WORKER">Pracovník</SelectItem>
                <SelectItem value="GUEST">Dozor / TDS</SelectItem>
                <SelectItem value="BOSS">Stavbyvedoucí</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            onClick={handleAdd}
            disabled={pending || !userId || addableUsers.length === 0}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <UserPlus className="size-4" aria-hidden />
            )}
            Přidat
          </Button>
        </div>
      )}
      {canManage && addableUsers.length === 0 && (
        <p className="-mt-3 text-xs text-muted-foreground">
          Všichni aktivní uživatelé už jsou členy této zakázky.
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Jméno</TableHead>
            <TableHead>Role v zakázce</TableHead>
            <TableHead className="hidden sm:table-cell">Přiřazen</TableHead>
            {canManage && <TableHead className="text-right">Akce</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={canManage ? 4 : 3}
                className="text-center text-muted-foreground"
              >
                Zatím žádní členové.
              </TableCell>
            </TableRow>
          )}
          {members.map((m) => (
            <TableRow key={m.userId}>
              <TableCell>
                <span className="font-medium">{m.displayName}</span>{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {m.nickname}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant={m.projectRole === "BOSS" ? "default" : "secondary"}>
                  {ROLE_LABEL[m.projectRole]}
                </Badge>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                {formatDate(m.addedAt)}
              </TableCell>
              {canManage && (
                <TableCell className="text-right">
                  <RemoveMemberButton
                    projectId={projectId}
                    userId={m.userId}
                    displayName={m.displayName}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
