# Nasazení na Fly.io

Architektura a pravidla jsou v [`../PROJECT.md`](../PROJECT.md). Tady je postup nasazení. **Sestavení zatím není uvolněné pro skutečná data deníku**: v produkčním režimu se aplikace bez `ALLOW_UNRELEASED_BUILD=true` nespustí (jen testovací data). Podmínky uvolnění jsou v `PROJECT.md`, kapitola „Release gate“.

## Co se nasazuje

Jeden Docker obraz (`Dockerfile`): Ktor backend + sestavené SPA (servíruje ho Ktor ze stejného původu) + `typst` pro PDF, na glibc Temurin JRE 21. Aplikace běží pod uživatelem `app`, ne jako root; vstupní skript při startu jen předá datový svazek tomuto uživateli a pak zahodí oprávnění. Heap JVM je omezený na 40 % paměti stroje; `fly.toml` žádá stroj `shared-cpu-1x` s **1 GB** (výchozí stroj Fly má 256 MB a nestačil by). Obraz je jediný artefakt, CI ho staví a spouští proti PostgreSQL 18.

## První nasazení

```bash
# 0. flyctl a účet na Fly.io
fly auth login

# 1. Aplikace a svazek pro fotky (musí odpovídat [mounts] ve fly.toml)
fly apps create stavebni-denik
fly volumes create stavebni_denik_data --region fra --size 3 --app stavebni-denik

# 2. PostgreSQL 18 (schéma používá uuidv7(), starší verze nestačí).
#    Libovolná spravovaná nebo vlastní databáze dosažitelná z aplikace.

# 3. Tajemství (nikdy se necommitují)
fly secrets set --app stavebni-denik \
  JWT_SECRET="$(openssl rand -base64 32)" \
  JDBC_URL="jdbc:postgresql://<host>:5432/stavebni_denik?sslmode=require" \
  DB_USER="<uživatel>" DB_PASSWORD="<heslo>" \
  ALLOW_UNRELEASED_BUILD=true          # jen pro testovací data, dokud není sestavení uvolněné

# 4. Nasazení
fly deploy --app stavebni-denik
```

`fly.toml` nastavuje `APP_ENV=production` (povinný `JWT_SECRET`, cookie `Secure`, HSTS, kontrola hesel proti uniklým databázím) a `CLIENT_IP_HEADER=Fly-Client-IP` (adresa klienta pro omezení pokusů o přihlášení; hlavičku Fly přepisuje, klient ji podvrhnout nemůže). Kontrola zdraví je `GET /api/health`.

## První administrátor

Nová databáze nemá uživatele. Příkaz běží uvnitř běžícího stroje:

```bash
fly ssh console --app stavebni-denik -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt create-admin alice 'Alice Nováková'"
```

Vypíše vygenerované heslo (jednou, jen na standardní výstup). Platí 7 dní a při prvním přihlášení se musí změnit. Zapomenuté heslo jediného administrátora obnoví `reset-password <přezdívka>`. Další uživatele zakládá administrátor v aplikaci.

## Ověření deníku

Audit log je řetěz hashů a databáze odmítá `UPDATE`, `DELETE` i `TRUNCATE`; kdo ale vlastní tabulku, může triggery vypnout. Proto se poslední řádek má zaznamenávat **mimo databázi**:

```bash
fly ssh console --app stavebni-denik -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-head"            # vypíše <id>:<hash>
fly ssh console --app stavebni-denik -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-verify 1234:ab12…"
```

`audit-verify` skončí kódem `0` (řetěz je v pořádku), `1` (poškozený nebo useknutý) nebo `3` (kontrolu nešlo provést). Pravidelné spouštění a zaznamenávání hlavy zatím není automatické: workflow `.github/workflows/audit-verify.yml` spouští kontrolu každou noc, ale **selže, dokud nejsou nastavená tajemství** `AUDIT_JDBC_URL`, `AUDIT_DB_USER`, `AUDIT_DB_PASSWORD` (a databáze dosažitelná z GitHubu); do té doby ho lze v záložce Actions vypnout.

## Zálohy

**Zatím nejsou nastavené.** Pokud databáze nemá vlastní zálohování a obnovu, je to první věc, kterou je potřeba před skutečnými daty vyřešit: zálohovat je nutné databázi (včetně `audit_log`) i svazek `/data/uploads/photos`, a obnovu je nutné vyzkoušet. Soubor `scripts/backup.sh` je starší skript s restic, **není součástí obrazu a není otestovaný**; je jen výchozí bod.

## Aktualizace

```bash
git checkout main && git pull
fly deploy --app stavebni-denik
```

Flyway doplní schéma při startu. Před nasazením migrace zkontrolujte, že běžící verze s novým schématem funguje (migrace se nevracejí zpět).
