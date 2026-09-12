<!--
  Delivery plan for the Stavební deník project — committed copy of the
  working plan maintained by Junie at ~/.junie/plans/stavebni-denik-nextjs.md.
  Kept in-repo so the plan is version-controlled and survives independently
  of any local tooling state. See docs/PROGRESS.md for the live status snapshot.
-->

# Requirements

### Overview & Goals
Jednoduchá webová aplikace pro vedení **stavebního deníku** dle § 157 stavebního zákona (zákon č. 283/2021 Sb.) a přílohy č. 16 vyhlášky č. 499/2006 Sb. v platném znění. Cíl: nahradit papírový deník elektronickou verzí, která splní zákonné náležitosti, je použitelná z mobilního prohlížeče na stavbě a zabezpečí prokazatelnou neporušitelnost záznamů.

Aplikace běží jako **single-tenant** instance jedné firmy na Fly.io, fotografie se ukládají na perzistentní volume vedle aplikace, audit log používá hash chain pro tamper-evidence.

### Scope

#### In Scope
- Ruční správa uživatelů administrátorem (přidání podle nickname, systém generuje silné heslo).
- Role **BOSS** (stavbyvedoucí / admin), **WORKER** (pracovník), **INSPECTOR** (TDS, koordinátor BOZP), **INVESTOR** (čtení a archivace) a rozšiřitelný číselník rolí.
- RBAC s wildcard-resistentními kontrolami v service layeru.
- Správa zakázek (staveb) s identifikačními údaji dle vyhlášky, vč. volitelných údajů o SoD a PD.
- Předání a převzetí staveniště jako vyhrazený formulář (více per zakázku, s fotkami a stavy měřidel).
- Seznam pověřených osob (auto-sync z členů + ruční přidání externích osob bez účtu).
- Denní záznamy (hlášení / „kontrolní den“) se všemi povinnými položkami a sekvenčním číslováním.
- Volitelné zařazení denního záznamu ke stavebnímu objektu (SO) přes textový combo-box s našeptávačem.
- Kontrolní dny jako rozšířený typ denního záznamu (příznak + zápis z jednání + účastníci).
- Evidence přerušení a obnovení stavby (příznak na denním záznamu + důvod).
- Upload fotek s automatickým resize (sharp) a generováním náhledu.
- Snapshot aktuálního počasí z Open-Meteo při vytvoření denního záznamu.
- Checklist „materiál na další dny“.
- Připomínky TDS / dozoru (INSPECTOR_REMARK) a poznámky investora (INVESTOR_NOTE) jako typované záznamy ke dni.
- Workflow podpisů: denní podpis stavbyvedoucího, podpisy TDS při návštěvě; po podpisu se den uzamkne.
- Potvrzení (acknowledge) denních záznamů investorem — nevratné, s důkazní hodnotou.
- Tamper-evident audit log (hash chain) všech mutací, žádné tvrdé mazání.
- PDF export deníku ke kontrole / archivaci.
- Asynchronní ZIP export celé stavby (PDF + originály fotek) pro desetiletou offline archivaci.

#### Out of Scope
- Multi-tenant (více firem v jedné instanci).
- Offline / PWA režim.
- Mobilní nativní appka.
- Elektronické kvalifikované podpisy (lze přidat později).
- SSO / OAuth providery — jen lokální účty.
- Fakturace, docházka, sklad materiálu, BIM.

### User Stories
- Jako **BOSS** chci přidat nového pracovníka zadáním nicknamu a získat vygenerované heslo, abych mu ho mohl předat.
- Jako **BOSS** chci založit zakázku se všemi identifikačními údaji stavby, abych na ní mohl vést deník dle zákona.
- Jako **WORKER** chci vytvořit denní hlášení, nahrát fotky a popsat provedené práce, abych splnil povinnost denního záznamu.
- Jako **WORKER** chci, aby se mi při vytvoření hlášení automaticky vyplnilo aktuální počasí (povinný údaj), abych nemusel ručně dohledávat.
- Jako **WORKER** chci do hlášení doplnit checklist „materiál na další dny“, abych předal informace dál.
- Jako **INSPECTOR** (TDS/BOZP) chci si přečíst denní záznamy a přidat svou připomínku, ale nesmím nic mazat ani měnit cizí záznamy.
- Jako **INVESTOR** chci mít read-only přístup k záznamům své stavby a možnost stáhnout archiv, abych měl nad stavbou kontrolu.
- Jako **BOSS** chci denně podepsat záznam a tím ho uzamknout, aby splňoval požadavek § 157.
- Jako **BOSS** chci si stáhnout PDF deníku za libovolné období pro stavební úřad.
- Jako **BOSS** chci po dokončení stavby exportovat kompletní ZIP archiv (PDF + originály fotek) pro povinnou desetiletou archivaci.
- Jako **BOSS** chci v audit logu vidět kdo a kdy co změnil, abych nemohl být obviněn z falšování.

### Functional Requirements

#### Povinné položky denního záznamu (per vyhláška 499/2006 Sb., příloha 16)
- Datum záznamu.
- Jméno a příjmení stavbyvedoucího nebo osoby zajišťující stavební dozor.
- **Počasí** v průběhu dne (slovní popis + teplota °C, vítr, srážky).
- Počet pracovníků v jednotlivých profesích / firmách.
- Popis a množství prováděných prací.
- Dodávky materiálu, výrobků, strojů.
- Nasazení mechanizace.
- Provedené zkoušky a měření.
- Kontroly a rozhodnutí orgánů státního dozoru, koordinátora BOZP, TDS.
- Bezpečnostní opatření / mimořádné události.
- Závady, poruchy, jejich příčiny a řešení.
- Připomínky TDS, koordinátora BOZP, projektanta.
- Další skutečnosti významné pro průběh stavby.
- Podpisy (denně stavbyvedoucí, při návštěvě TDS).
- **Volitelně**: Zařazení prací k určitému stavebnímu objektu (SO) pomocí textového štítku (našeptávač dříve použitých hodnot).

#### Úvodní listy a speciální záznamy
- **Předání a převzetí staveniště**: vyhrazený formulář pro zapsání stavu měřidel a podmínek převzetí staveniště, tvořící úvodní list deníku.
- **Seznam pověřených osob**: seznam osob s dispozičním právem provádět zápisy (na úrovni detailu zakázky).

#### Identifikační údaje stavby (vyplňují se 1× při založení)
Název a místo stavby, parcelní čísla a katastr, stavebník, zhotovitel, stavbyvedoucí (jméno + autorizace ČKAIT), TDS, koordinátor BOZP, projektant, číslo stavebního povolení / společného povolení.

#### Acceptance criteria
- Po podpisu denního záznamu nejde upravit obsah; lze přidat **dodatek** (errata), který se k záznamu připojí a je rovněž auditován.
- Žádné UI tlačítko „smazat trvale“; vše je `soft delete` přes `deleted_at` a stále viditelné pro BOSS v archivu.
- Audit log obsahuje pro každou mutaci: actor, action, entity_type, entity_id, before (JSONB), after (JSONB), ip, user_agent, `prev_hash`, `row_hash`.
- Verifikační job projde celou audit_log a zkontroluje hash chain; výsledek zobrazí v admin UI.
- Generované heslo má min. 12 znaků, mix tříd, ukáže se přesně jednou při vytvoření uživatele.
- Foto je po uploadu zmenšeno na max 1920 px delší strany (JPEG q=82) + thumbnail 400 px; originál se nedrží.

### Non-Functional Requirements
- **Bezpečnost**: HTTPS only, HTTP-only secure cookies, argon2id hash hesel, CSRF tokens, rate limiting na login, security headers (CSP, HSTS).
- **Lokalizace**: česky (UI texty), Europe/Prague timezone, formát data dd.MM.yyyy.
- **Přístupnost**: responsive layout od 360 px, mobile-first; čitelné na slunci (kontrast, velká tlačítka).
- **Výkon**: TTFB < 500 ms u typických stránek; upload fotky do 10 MB.
- **Provoz**: denní automatický dump Postgresu + snapshot volume; runbook pro obnovu.
- **Compliance**: GDPR — minimum osobních údajů, retence dle zákona (deník 10 let po kolaudaci). Právní základ zpracování: § 157 stavebního zákona (zákonná povinnost archivace). Anonymizace osobních údajů po uplynutí archivační lhůty je plánovaná future-work funkce.

# Technical Design

### Current Implementation
Projekt začíná na zelené louce. Repo `nessenceai/mn4-hlaseni` není dostupné (404 / private), takže nestavíme na žádném existujícím kódu.

**Lokální cesta projektu**: `/Users/saymoon/Work-GIT/slack/stavebni-denik` (sourozenec existujících projektů `das`, `prodaas`, `snippets`, `work-reporter`, `workhours` v `/Users/saymoon/Work-GIT/slack/`). Tato složka zatím neexistuje a vytvoří se v rámci Stage 1. Vzdálené repo bude pojmenováno `stavebni-denik` (případně dle preference později přejmenovat na `mn4-hlaseni`).

### Key Decisions
- **Framework**: Next.js 15 (App Router) v TypeScriptu. Jeden deploy unit, React Server Components pro většinu stránek, server actions pro mutace, API route handlers pro upload a webhooky.
- **ORM + DB**: Prisma 5 + Postgres 16. Migrace přes `prisma migrate`.
- **Auth**: vlastní implementace s `Auth.js v5` (next-auth) Credentials providerem, `argon2id` hashování přes balíček `@node-rs/argon2`, sessions v Postgres tabulce, HTTP-only secure cookies. Žádní externí provideři.
- **RBAC**: tabulka `role` + enum-like seed (`BOSS`, `WORKER`, `INSPECTOR`, `INVESTOR`), permissions kontrolovány v service layeru (`assertCan(user, 'report.sign', report)`), middleware na route úrovni je jen druhá obrana. INVESTOR nemá přístup k audit logu ani admin sekci.
- **Audit log s hash chain**: každá mutace prochází `withAudit(...)` wrapperem v service layeru. Tabulka `audit_log` je append-only — Postgres role aplikace má `INSERT, SELECT` práva, ale `REVOKE UPDATE, DELETE`. Každý řádek nese `prev_hash` (= hash předchozího řádku) a `row_hash` (= sha256 ze serializovaného obsahu + `prev_hash`). Cron job (denně) ověří celou řetěz a zaloguje výsledek.
- **Storage fotek**: lokální Fly volume v `/data/photos/{projectId}/{reportId}/{uuid}.{jpg|webp}`, metadata v Postgres tabulce `photo`. Soubory čte jen aplikace, ven se servírují přes auth-gated route.
- **Image processing**: `sharp` — resize na 1920 px delší stranu (JPEG q=82) + 400 px thumbnail; EXIF se strippuje kromě `DateTimeOriginal` a `GPSLatitude/Longitude` (uložené do `photo.captured_at`, `photo.gps`).
- **Weather snapshot**: Open-Meteo (free, bez API klíče). Když se vytvoří `daily_report`, server zavolá Open-Meteo s GPS stavby a uloží snapshot (teplota min/max, popis, vítr, srážky) do JSONB sloupce. Nikdy se nepřepisuje.
- **PDF export**: Playwright v headless režimu renderuje `/print/project/{id}?from=...&to=...`, výstup je PDF s diakritikou + hash chain footerem každé stránky.
- **UI**: Tailwind CSS 4 + shadcn/ui (Radix) komponenty, formuláře přes `react-hook-form` + `zod` validace, toast notifikace `sonner`.
- **Soft delete only**: každá entita má `deleted_at`. UI nemá tvrdé delete tlačítko; pro BOSS je archiv-view.

### Architecture Diagram
```mermaid
graph TD
  subgraph Client
    B[Browser - mobile/desktop]
  end
  subgraph FlyApp[Fly.io container]
    NX[Next.js 15 App Router]
    AUTH[Auth.js Credentials]
    SVC[Service layer + withAudit]
    IMG[sharp image pipeline]
    PDF[Playwright PDF renderer]
    CRON[Audit verify cron]
  end
  subgraph Storage
    PG[(Postgres 16)]
    VOL[(/data volume)]
  end
  EXT[Open-Meteo API]

  B -->|HTTPS| NX
  NX --> AUTH
  AUTH --> PG
  NX --> SVC
  SVC --> PG
  SVC --> IMG
  IMG --> VOL
  SVC --> EXT
  SVC --> PDF
  CRON --> PG
  B -->|GET /photos/...| NX
  NX -->|stream| VOL
```

### Data Models / Contracts
Prisma schema (zkráceně):
```prisma
model User {
  id            String   @id @default(cuid())
  nickname      String   @unique
  displayName   String
  passwordHash  String
  role          Role     @default(WORKER)
  ckaitNumber   String?  // pro stavbyvedoucího
  isActive      Boolean  @default(true)
  mustChangePwd Boolean  @default(true)
  createdAt     DateTime @default(now())
  createdById   String?
  deletedAt     DateTime?
  sessions      Session[]
}

enum Role { BOSS WORKER INSPECTOR INVESTOR }

model Session {
  id        String   @id @default(cuid())
  userId    String
  expiresAt DateTime
  user      User     @relation(fields: [userId], references: [id])
}

model Project { // zakázka / stavba
  id            String   @id @default(cuid())
  name          String
  address       String
  cadastralArea String
  parcelNumbers String
  permitNumber  String?
  builder       String   // stavebník
  contractor    String   // zhotovitel
  siteManagerId String   // stavbyvedoucí (User)
  tdsName       String?
  bozpName      String?
  designerName  String?
  contractNumber String? // číslo SoD (volitelné)
  contractDate  DateTime? // datum SoD
  designDocVersion String? // verze PD
  designDocDate DateTime?  // datum PD
  gpsLat        Float?
  gpsLon        Float?
  startedAt     DateTime?
  endedAt       DateTime?
  deletedAt     DateTime?
  reports       DailyReport[]
  members       ProjectMember[]
  handovers     SiteHandover[]
  authorizedPersons AuthorizedPerson[]
}

model SiteHandover { // Předání a převzetí staveniště
  id            String   @id @default(cuid())
  projectId     String
  type          String   // combo-box: "Předání staveniště", "Zpětné předání", "Dílčí předání", nebo volný text
  date          DateTime
  participants  String   // Kdo předává a přebírá
  meterStates   Json?    // Dynamická tabulka [{name, number, value}]
  notes         String?
  signedAt      DateTime?
  deletedAt     DateTime?
  photos        Photo[]  // Fotky stavu měřidel / staveniště
  project       Project  @relation(fields: [projectId], references: [id])
}

model AuthorizedPerson { // Osoba oprávněná k zápisům
  id            String   @id @default(cuid())
  projectId     String
  linkedUserId  String?  // null = externí osoba bez účtu
  name          String
  company       String?
  authorization String?  // textový popis oprávnění
  revokedAt     DateTime? // kdy ztratil oprávnění (null = aktivní)
  createdAt     DateTime @default(now())
  project       Project  @relation(fields: [projectId], references: [id])
}

model ProjectMember {
  projectId String
  userId    String
  role      Role
  @@id([projectId, userId])
}

model DailyReport {
  id              String   @id @default(cuid())
  projectId       String
  sequenceNumber  Int      // auto-přidělené v transakci (SELECT MAX+1 FOR UPDATE)
  date            DateTime // den
  authorId        String
  constructionObj String?  // Stavební objekt (SO) - combo-box s našeptávačem
  // Kontrolní den
  isControlDay    Boolean  @default(false)
  meetingNotes    String?  // Zápis z jednání (jen pro kontrolní dny)
  meetingAttendees Json?   // [{name, role}]
  // Přerušení stavby
  workSuspended   Boolean  @default(false)
  suspensionReason String? // Důvod přerušení
  // Standardní povinné položky
  workersByTrade  Json     // [{trade, count}]
  workDescription String
  materialsIn     String?
  machinery       String?
  testsAndChecks  String?
  safetyNotes     String?
  defects         String?
  otherNotes      String?
  weather         Json     // snapshot z Open-Meteo
  // Podpis a lock
  signedAt        DateTime?
  signedById      String?
  lockedAt        DateTime?
  // Acknowledge investorem (nevratné)
  acknowledgedAt  DateTime?
  acknowledgedById String?
  deletedAt       DateTime?
  photos          Photo[]
  remarks         Remark[]
  materialNeeds   MaterialNeed[]
  addenda         Addendum[]
  @@unique([projectId, date])
  @@unique([projectId, sequenceNumber])
}

model Photo {
  id          String   @id @default(cuid())
  reportId    String
  pathOriginal String  // /data/photos/.../{uuid}.jpg
  pathThumb   String
  width       Int
  height      Int
  bytes       Int
  capturedAt  DateTime?
  gps         Json?
  uploadedById String
  createdAt   DateTime @default(now())
  deletedAt   DateTime?
}

model Remark { // připomínka TDS / dozoru / poznámka investora
  id        String     @id @default(cuid())
  reportId  String
  authorId  String
  type      RemarkType @default(INSPECTOR_REMARK)
  text      String
  createdAt DateTime @default(now())
  deletedAt DateTime?
}

enum RemarkType { INSPECTOR_REMARK INVESTOR_NOTE }

model MaterialNeed { // checklist materiálu na další dny
  id        String   @id @default(cuid())
  reportId  String
  text      String
  neededBy  DateTime?
  resolved  Boolean  @default(false)
  resolvedAt DateTime?
  deletedAt DateTime?
}

model Addendum { // dodatek po podpisu
  id        String   @id @default(cuid())
  reportId  String
  authorId  String
  text      String
  createdAt DateTime @default(now())
}

model AuditLog {
  id         BigInt   @id @default(autoincrement())
  ts         DateTime @default(now())
  actorId    String?
  action     String   // 'report.create', 'photo.upload', ...
  entityType String
  entityId   String
  before     Json?
  after      Json?
  ip         String?
  userAgent  String?
  prevHash   String   // hex sha256
  rowHash    String   // hex sha256
}
```

Servisní kontrakt:
```ts
// src/server/audit.ts
export async function withAudit<T>(
  ctx: { user: SessionUser; ip: string; ua: string },
  action: string,
  entityType: string,
  entityIdResolver: (result: T) => string,
  before: unknown,
  fn: () => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await fn();
    const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' } });
    const prevHash = last?.rowHash ?? '0'.repeat(64);
    const payload = canonicalJSON({ action, entityType,
      entityId: entityIdResolver(result), actorId: ctx.user.id,
      before, after: result, ip: ctx.ip, ua: ctx.ua, prevHash });
    const rowHash = sha256Hex(payload);
    await tx.auditLog.create({ data: { ...parse(payload), rowHash } });
    return result;
  });
}
```

DB role:
```sql
CREATE ROLE app LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
REVOKE UPDATE, DELETE ON audit_log FROM app;
```

### Components
- **`/app/(auth)/login`** — login formulář, povinný first-time password change.
- **`/app/admin/users`** — BOSS: seznam, vytvoření (modal s generovaným heslem zobrazeným 1×), deaktivace.
- **`/app/projects`** — seznam zakázek (BOSS vytváří, WORKER/INSPECTOR/INVESTOR vidí přiřazené).
- **`/app/projects/[id]`** — detail zakázky + záložky: Záznamy (kalendář + sekvenční seznam) / Předání staveniště / Pověřené osoby / Členové / Údaje.
- **`/app/projects/[id]/reports/[date]`** — denní záznam: formulář s SO combo-boxem, kontrolní den / přerušení flagy, fotky, počasí (snapshot), připomínky (INSPECTOR_REMARK / INVESTOR_NOTE), checklist materiálu, acknowledge pro INVESTOR, tlačítko „Podepsat a uzamknout" pro BOSS.
- **`/app/projects/[id]/handovers/new`** — formulář předání staveniště (BOSS-only): typ combo-box, účastníci, dynamická tabulka měřidel, fotky, poznámky.
- **`/app/admin/audit`** — BOSS-only: prohlížeč audit logu + tlačítko „Ověřit integritu řetězu".
- **`/app/print/project/[id]`** — server-rendered HTML pro Playwright PDF (vč. úvodních listů).
- **API**: `POST /api/photos/upload`, `GET /photos/[id]`, `GET /api/weather?lat&lon&date`, `POST /api/reports/[id]/sign`, `POST /api/reports/[id]/acknowledge`, `POST /api/projects/[id]/export-zip`.

### File Structure
```
repo-root/
├─ prisma/
│  ├─ schema.prisma
│  └─ migrations/
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/page.tsx
│  │  ├─ admin/users/page.tsx
│  │  ├─ admin/audit/page.tsx
│  │  ├─ projects/page.tsx
│  │  ├─ projects/[id]/page.tsx
│  │  ├─ projects/[id]/reports/[date]/page.tsx
│  │  ├─ projects/[id]/handovers/new/page.tsx
│  │  ├─ print/project/[id]/page.tsx
│  │  └─ api/
│  │     ├─ photos/upload/route.ts
│  │     ├─ photos/[id]/route.ts
│  │     ├─ reports/[id]/sign/route.ts
│  │     ├─ reports/[id]/acknowledge/route.ts
│  │     └─ projects/[id]/export-zip/route.ts
│  ├─ server/
│  │  ├─ auth.ts            // Auth.js config + argon2
│  │  ├─ audit.ts           // withAudit + verifyChain
│  │  ├─ rbac.ts            // assertCan
│  │  ├─ weather.ts         // Open-Meteo client
│  │  ├─ images.ts          // sharp pipeline
│  │  ├─ pdf.ts             // Playwright wrapper
│  │  ├─ export.ts          // async ZIP generátor + semaphore
│  │  └─ services/{users,projects,reports,photos,handovers,authorized-persons}.ts
│  ├─ components/ui/...     // shadcn/ui
│  ├─ components/forms/...
│  └─ lib/{db.ts, crypto.ts, password-gen.ts, dates.ts}
├─ scripts/
│  ├─ verify-audit.ts        // cron entry-point
│  ├─ cleanup-exports.ts     // TTL úklid ZIP souborů (48h)
│  └─ seed.ts
├─ Dockerfile
├─ fly.toml
├─ .env.example
└─ README.md
```

### Risks
- **Tamper přes DB admina**: hash chain pomůže detekovat, ale neuchrání. Mitigace — denní externí archivace `row_hash` posledního řádku (např. e-mailem BOSSovi a do druhého úložiště).
- **Ztráta fotek při pádu volume**: Fly volume je single-host. Mitigace — nightly `tar | restic` snapshot na R2/B2 v rámci zálohovacího jobu (i když primárně chceme jen volume, záloha je nutná).
- **Open-Meteo nedostupné**: fallback — uložit `weather = {error, fetchedAt}`, ruční doplnění s flagem `manuallyEntered=true` v auditu.
- **Diakritika v PDF**: Playwright + systémové fonty (Liberation Sans / Inter) ji zvládají, ale je třeba ověřit v CI screenshot testem.
- **Kvalifikace ČKAIT a elektronický podpis**: aktuální verze nenahrazuje QES; výstup je „elektronicky vedený deník“ s vlastní integritou. Pro plné nahrazení v budoucnu lze doplnit eIDAS/QES.
- **ZIP export OOM / Disk Full**: asynchronní ZIP může na 1 GB stroji sežrat RAM nebo místo. Mitigace — semaphore (max 1 běžící job), TTL úklid (smazat exporty po 48h), quota check před startem (<20 % free → odmítnout).

# Testing

### Validation Approach
Každá stage v Delivery Plan obsahuje vlastní testy. Důraz je na **audit log integritu** a **RBAC**, protože jsou bezpečnostně kritické. Použijeme Vitest pro unit/integration testy server kódu a Playwright pro pár end-to-end happy-path scénářů. Pro DB testy se spouští Postgres v Dockeru přes `testcontainers`.

### Key Scenarios
- **Login & first password change**: nový uživatel se přihlásí vygenerovaným heslem → je donucen ho změnit → nové heslo se ověří argon2.
- **BOSS přidá WORKERa**: heslo se vygeneruje, zobrazí přesně jednou, hash se uloží, v audit logu je `user.create` s `before=null`, `after={...bez hashe}`.
- **WORKER vytvoří denní záznam**: formulář projde validací (zod), počasí se snapshotuje z Open-Meteo (v testu mock), audit log obsahuje `report.create`.
- **Upload fotky**: 5 MB JPEG → resize na 1920 px + thumb 400 px, EXIF strippován (kromě GPS), audit log `photo.upload` s velikostí a hash.
- **INSPECTOR přidá připomínku, ale nemůže editovat**: `assertCan(inspector, 'report.update')` → 403; `assertCan(inspector, 'remark.create')` → ok.
- **INVESTOR bere na vědomí**: INVESTOR potvrdí den, vytvoří se záznam `acknowledgedAt`, přidá `INVESTOR_NOTE`, ale nemůže smazat historii.
- **Podpis & lock**: BOSS podepíše den → `signedAt`, `lockedAt` se nastaví → pokus o `report.update` → 403 i pro BOSSa, lze jen `addendum.create`.
- **PDF export**: vygeneruje PDF s českou diakritikou + tabulkou počasí + fotkami + hash chain footerem.
- **Audit verify**: `pnpm run verify-audit` projde celou tabulku a vrátí `OK` na čerstvé DB; po umělé úpravě jednoho řádku přes superuser session detekuje break a vrátí ID problémového řádku.

### Edge Cases
- Pokus o vytvoření 2 záznamů pro stejný den a zakázku → unique constraint `@@unique([projectId, date])` → 409.
- Nahrání souboru, který není obrázek → sharp throws → 400 + nic v audit logu (mimo `withAudit` blok).
- Open-Meteo timeout 5 s → fallback `weather.error = 'timeout'`, UI upozorní BOSSa že je třeba doplnit ručně, ruční hodnoty mají `manuallyEntered=true`.
- Pokus o smazání uživatele, který má záznamy → blokujeme; lze jen deaktivovat (`isActive=false`).
- Soft-deleted entita se nezobrazí v běžných listech, ale v BOSS archivu ano.
- Concurrent edit denního záznamu dvěma WORKERy → optimistic locking přes `updatedAt` token; druhý dostane 409 s diff.
- Login brute-force → rate limit 5 pokusů / 15 min na nickname + 20 / 15 min na IP.

### Test Changes
- **Unit (Vitest)**: `password-gen`, `audit hash chain`, `rbac.assertCan`, `weather client` (s `msw` mockem), `images.resize` (golden file).
- **Integration (Vitest + testcontainers Postgres)**: services CRUD scénáře, `withAudit` v transakci, ověření hash chainu po každé operaci, role grants.
- **E2E (Playwright)**: 3 happy paths — onboarding uživatele, vytvoření a podpis denního záznamu s fotkou, PDF export.
- **CI**: GitHub Actions — lint → typecheck → unit → integration → e2e → build. Sekret `OPEN_METEO_BASE` mockován.

# Delivery Steps

### ✓ Step 1: Bootstrap, infra a deploy-skeleton
Zelená louka Next.js projektu v `/Users/saymoon/Work-GIT/slack/stavebni-denik`, který se po dokončení této fáze nasadí na Fly.io s prázdnou databází a perzistentním volume a vrací `200 OK` na `/healthz`.

- Vytvořit adresář `/Users/saymoon/Work-GIT/slack/stavebni-denik`, inicializovat git repozitář (`git init`, `main` branch) a v něm inicializovat **Next.js 15** (App Router, TypeScript, ESLint, Prettier) s **Tailwind 4** a **shadcn/ui** baseline.
- Nastavit **Prisma 5** s Postgres datasource, prvotní `schema.prisma` (jen `User` a `Session`) a `prisma migrate`.
- `Dockerfile` (multi-stage, Node 22, Playwright deps) + `fly.toml` s volumem mountovaným na `/data`.
- `.env.example` (DATABASE_URL, AUTH_SECRET, OPEN_METEO_BASE, DATA_DIR).
- Healthcheck endpoint `/healthz` (DB ping + volume write probe).
- Layout `app/layout.tsx` s českou lokalizací, Europe/Prague timezone, globálním Toaster.
- GitHub Actions CI: install, lint, typecheck, build.

### ✓ Step 2: Autentizace a správa uživatelů s generovaným heslem
BOSS se umí přihlásit, vytvoří přes UI WORKERa/GUESTa, dostane vygenerované heslo zobrazené přesně 1×, uživatel se přihlásí a je donucen změnit heslo.

- Auth.js v5 **Credentials provider** + `@node-rs/argon2` (argon2id), session uložená v Postgresu (`Session` model).
- HTTP-only secure cookie, CSRF token, security headers (CSP, HSTS, X-Frame-Options).
- Rate limit na `/api/auth/...` přes `iron-session`-style sliding window v Postgresu.
- `lib/password-gen.ts` — 12+ znaků, mix tříd; `mustChangePwd=true` po vytvoření.
- Stránky `/login`, `/first-password-change`, redirect přes proxy (`src/proxy.ts`).
- Stránky `/admin/users` (BOSS-only): list, modal „Nový uživatel“ (nickname, displayName, role, ČKAIT u BOSS), po vytvoření zobrazí heslo + tlačítko „Zkopírovat“, deaktivace přes `isActive`.
- Soft delete only, žádné tvrdé mazání uživatelů.
- Unit testy pro `password-gen` a `argon2` wrapper, integration test pro flow `create → first login → change password`.

### * Step 3: RBAC a tamper-evident audit log (hash chain)
Každá mutace v aplikaci prochází `withAudit` wrapperem, který vloží řádek do append-only `audit_log` s hash chainem; admin UI umí zobrazit log a spustit verifikaci celého řetězu.

- Migrace `audit_log` tabulky + Postgres role `app` s `REVOKE UPDATE, DELETE ON audit_log`.
- `src/server/audit.ts` — `withAudit()` v Prisma transakci, `canonicalJSON()` + `sha256Hex()`, `prevHash` ze `findFirst orderBy id desc`.
- `src/server/rbac.ts` — `assertCan(user, action, resource)`, matice oprávnění pro BOSS/WORKER/INSPECTOR/INVESTOR.
- Zpětně zabalit user/session mutace ze Stage 2 do `withAudit`.
- Stránka `/admin/audit` (BOSS-only): filtry (actor, entity, datum), detail řádku s diffem before/after.
- Tlačítko + scripts/verify-audit.ts (`pnpm verify:audit`) — projde celou tabulku, vrátí `OK` nebo ID prvního porušeného řádku; výsledek jde i do souboru `/data/audit-verify.log`.
- Cron job (`fly machine schedule` nebo GitHub Actions) spouští verifikaci 1× denně a posílá e-mail na BOSS při selhání.
- Integration testy: simulovaná manipulace přes raw SQL → verifikace detekuje break.

###   Step 4: Zakázky, pověřené osoby a předání staveniště
BOSS umí založit zakázku s identifikačními údaji (vč. SoD a PD), spravovat pověřené osoby a zapsat předání staveniště.
- Prisma modely `Project`, `ProjectMember`, `SiteHandover`, `AuthorizedPerson`.
- Service metody pro zakázky, auto-sync pověřených osob, a handovery. Vše přes `withAudit`.
- Validace přes zod (parcelní čísla, volitelná data, JSON pro měřidla).
- Stránky `/projects` (scope filtr dle role), `/projects/new`, `/projects/[id]` se záložkami (Údaje, Pověřené osoby, Předání, Členové).
- RBAC: BOSS = full, WORKER = read přiřazené + write reports, INSPECTOR = read přiřazené + write remarks, INVESTOR = read-only + acknowledge.
- E2E test: BOSS založí zakázku, přiřadí WORKERa a INSPECTORa. Otestování neviditelnosti pro nepřiřazené.

###   Step 5: Denní záznamy, připomínky, fotky a počasí
WORKER vytvoří denní záznam (se sekvenčním číslem), nahraje fotky, počasí se snapshotuje. Záznam může být "kontrolní den" nebo označit "přerušení stavby".
- Prisma modely `DailyReport`, `Photo`, `Remark`, `MaterialNeed`, `Addendum` + migrace.
- Vytváření `DailyReport` v transakci `SELECT MAX+1 FOR UPDATE` pro přidělení `sequenceNumber`.
- Formulář s dynamickými poli (SO našeptávač, sekce pro kontrolní den / přerušení, checklist materiálu).
- `src/server/weather.ts` a `src/server/images.ts` integrace.
- UI sekce „Připomínky a poznámky" (INSPECTOR píše `INSPECTOR_REMARK`, INVESTOR píše `INVESTOR_NOTE` a může kliknout na Acknowledge).
- Všechny mutace přes `withAudit`.
- Integration testy: souběžné vytváření záznamů (ověření locku a sequenceNumber), RBAC pro připomínky vs. poznámky.

###   Step 6: Podpisy, exporty (PDF/ZIP) a produkční hardening
BOSS podepíše denní záznam a tím ho uzamkne. Generování PDF a offline ZIP archivů.
- `POST /api/reports/[id]/sign` (BOSS-only), lock záznamu pro editaci.
- Playwright PDF: server-rendered HTML (vč. úvodních listů a předání staveniště), patička s hash chainem.
- ZIP archiv (`src/server/export.ts`): asynchronní generátor běžící na pozadí chráněný semaphorem (max 1 concurrency). Kontrola volného místa na disku. Zabalí PDF a složku s originálními fotkami.
- Cron script (`cleanup-exports.ts`) pro smazání ZIP souborů po 48 hodinách.
- Backup job (nightly): `pg_dump | gzip | restic` na B2/R2 vč. `/data/photos`.
- Monitoring: health probe, Fly alerty.
- Smoke E2E v CI: onboarding → projekt → report → upload fotky → podpis → PDF.
- Aktualizace README.