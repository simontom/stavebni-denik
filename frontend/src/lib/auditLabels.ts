/**
 * What the audit log says, in words a person reads. The server records a code for the action (`report.lock`) and one for the kind of
 * thing it was done to (`report`); the codes are what the chain of hashes covers and never change. The audit viewer shows these
 * words first and the code beside them, so an administrator can still quote the code. A code that is not in the list (a newer
 * server) is shown as it is.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "user.create": "Založení účtu",
  "user.update": "Změna účtu",
  "user.activate": "Aktivace účtu",
  "user.deactivate": "Deaktivace účtu",
  "user.delete": "Smazání účtu",
  "user.password_change": "Změna hesla",
  "user.password_reset": "Obnovení hesla správcem",
  "user.bootstrap_admin": "Založení prvního administrátora",
  "project.create": "Založení projektu",
  "project.update": "Změna údajů o stavbě",
  "project.member.add": "Přidání člena projektu",
  "project.member.remove": "Odebrání člena projektu",
  "project.site_manager.change": "Změna hlavního stavbyvedoucího",
  "report.create": "Založení záznamu",
  "report.update": "Změna záznamu",
  "report.lock": "Podpis záznamu",
  "report.acknowledge": "Seznámení se se záznamem",
  "report.addendum.add": "Dodatek k záznamu",
  "report.remark.add": "Záznam další osoby",
  "photo.upload": "Nahrání fotky",
  "photo.delete": "Smazání fotky",
  "authorizedPerson.create": "Pověření osoby",
  "authorizedPerson.revoke": "Zrušení pověření",
  "siteHandover.create": "Založení protokolu o předání",
  "siteHandover.update": "Změna protokolu o předání",
  "siteHandover.delete": "Smazání protokolu o předání",
  "siteHandover.sign": "Podpis protokolu o předání",
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  user: "Účet",
  project: "Projekt",
  report: "Záznam",
  photo: "Fotka",
  authorizedPerson: "Pověřená osoba",
  siteHandover: "Protokol o předání",
};

export const auditActionLabel = (action: string): string => AUDIT_ACTION_LABELS[action] ?? action;
export const auditEntityLabel = (entityType: string): string => AUDIT_ENTITY_LABELS[entityType] ?? entityType;
