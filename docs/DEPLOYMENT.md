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

# 3. Dvě databázové role. Vlastník (owner) schéma vytváří a mění, role "app" jen čte a zapisuje data.
#    Aplikace dostane jen heslo role "app"; heslo vlastníka na Fly nikdy není.
psql -v ON_ERROR_STOP=1 -v app_password="<heslo pro app>" -d stavebni_denik -f scripts/sql/bootstrap-app-role.sql   # jako superuser / vlastník

# 4. Schéma se migruje PŘED nasazením, s údaji vlastníka, z vašeho počítače nebo z CI (ne z aplikace):
DB_MIGRATE_USER=<owner> DB_MIGRATE_PASSWORD=<heslo vlastníka> DB_APP_ROLE=app \
JDBC_URL="jdbc:postgresql://<host>:5432/stavebni_denik?sslmode=require" \
  java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt migrate     # po ./gradlew :backend:shadowJar

# 5. Tajemství aplikace (nikdy se necommitují)
fly secrets set --app stavebni-denik \
  JWT_SECRET="$(openssl rand -base64 32)" \
  JDBC_URL="jdbc:postgresql://<host>:5432/stavebni_denik?sslmode=require" \
  DB_USER="app" DB_PASSWORD="<heslo pro app>" \
  ALLOW_UNRELEASED_BUILD=true          # jen pro testovací data, dokud není sestavení uvolněné

# 6. Nasazení
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

`audit-verify` skončí kódem `0` (řetěz je v pořádku), `1` (poškozený nebo useknutý) nebo `3` (kontrolu nešlo provést). Hlavu zaznamenává každou noc workflow `.github/workflows/audit-anchor.yml` (skript `scripts/audit/record-anchor.sh`): ověří řetěz proti poslední zaznamenané hlavě, zapíše novou hlavu do **soukromého repozitáře** a nechá ji časově orazítkovat nezávislou autoritou (RFC 3161). Když kterákoli kontrola selže, nic se nezapíše a běh skončí chybou. **Selže také, dokud není nastavené**, aby nikdo nevěřil, že se řetěz hlídá, když se nehlídá; do té doby ho lze v záložce Actions vypnout.

Jednorázové nastavení (dělá člověk, ne kód):

1. Vytvořte **soukromý repozitář** pro kotvy (např. `stavebni-denik-audit-anchors`) a pravidlo větve, které zakazuje force-push a mazání.
2. Od provozovatele autority (výchozí je `https://freetsa.org/tsr`) získejte její certifikát, **porovnejte otisk s druhým zdrojem** a commitněte ho do repozitáře kotev jako `tsa/ca.pem` (a `tsa/tsa.pem`, pokud ho token nenese). Certifikát se nikdy nestahuje při každém běhu: token ověřený certifikátem stáhnutým při běhu nic nedokazuje.
3. V hlavním repozitáři nastavte tajemství `AUDIT_JDBC_URL`, `AUDIT_DB_USER` (role, která smí jen `SELECT` z `audit_log`), `AUDIT_DB_PASSWORD` a `AUDIT_ANCHOR_TOKEN` (token s právem zápisu jen do repozitáře kotev) a proměnnou `AUDIT_ANCHOR_REPO` (`vlastnik/nazev`); volitelně `AUDIT_TSA_URL`. Databáze musí být dosažitelná z GitHubu.
4. Spusťte workflow ručně (`workflow_dispatch`); první běh zapíše první kotvu (useknutý konec lze poznat až od ní).

Co kotvy nechrání: zápisy po poslední kotvě (až den, déle po neúspěšné noci). Workflow také **nepozná, že přestal běžet**: neúspěšná noc pošle upozornění, ale GitHub plánované workflowy v repozitáři bez aktivity po 60 dnech potichu vypne. Stáří nejnovějšího záznamu `anchors/anchor-….txt` proto hlídejte něčím mimo toto workflow (externí monitor, ruční kontrola). Když autorita vymění certifikát, přidejte nový do `tsa/ca.pem` (lze spojit víc certifikátů); staré tokeny se ověřují k času svého vydání.

Později lze kotvu ověřit nezávisle na databázi: `openssl ts -verify -data anchors/anchor-….txt -in anchors/anchor-….tsr -CAfile tsa/ca.pem` dokazuje, že záznam existoval v daném čase, a `audit-verify <hlava>` dokazuje, že databáze ten řádek stále obsahuje beze změny.

## Zálohy

Zálohu dělá `scripts/backup/backup.sh`, obnovu `scripts/backup/restore.sh` a `scripts/backup/drill.sh` obojí vyzkouší, **včetně toho, co musí obnova odmítnout**. CI ho spouští po E2E testech nad daty, která testy nechaly (podepsané záznamy, fotky, dodatky). Záloha, kterou nikdo nikdy neobnovil, je jen naděje; podrobnosti jsou v „Backups and the restore drill“ v `PROJECT.md`.

```bash
# záloha: adresář denik-<čas UTC>/ (db.dump, photos.tar.gz, manifest.json, SHA256SUMS)
BACKUP_ROOT=/mnt/zalohy UPLOADS_DIR=/data/uploads \
  PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=stavebni_denik \
  scripts/backup/backup.sh

# obnova: do PRÁZDNÉ databáze a prázdného adresáře (nic nepřepíše); s APP_JAR ověří i řetěz auditu a podpisy
RESTORE_UPLOADS_DIR=/data/uploads-obnova APP_JAR=backend-all.jar \
  PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=stavebni_denik_obnova \
  scripts/backup/restore.sh /mnt/zalohy/denik-20261009T120000Z
```

- Skript záloh na konci vypíše **hlavu audit řetězu** (`<id>:<hash>`): zapište ji mimo databázi, je to kotva pro `audit-verify` (viz výše).
- Obnova skončí „restore drill passed“, jen když sedí kontrolní součty záloh, `pg_restore` proběhne bez chyby, **každý soubor fotky odpovídá hashi zaznamenanému při nahrání**, řetěz auditu je neporušený a obsahuje řádek z manifestu a `verify-signatures` potvrdí, že podepsané záznamy jsou, jak byly podepsány. Po skutečné obnově spusťte `scripts/sql/bootstrap-app-role.sql` a příkaz `migrate` (krok 4), aby aplikační role dostala oprávnění, a teprve potom spusťte aplikaci.
- Záloha obsahuje osobní údaje i samotný důkazní materiál: kopírujte ji na **šifrované úložiště, ze kterého stroj aplikace nemůže mazat** (restic, age + objektové úložiště…); skript to nedělá.
- Je-li lokální `pg_dump` starší než server, nastavte `PG_DOCKER_IMAGE=postgres:18-alpine` (skripty pak pouští klienta z kontejneru).

**Zatím není nastavené:** pravidelné spouštění záloh, kopie mimo stroj a pravidelné zkušební obnovy nad produkčními daty. Je to provozní krok, který čeká na produkční databázi; bez něj skutečná data nepouštějte.

## Uchovávání IP adres a user agentů

IP adresa a user agent požadavku jsou osobní údaje, proto **nejsou součástí hashe audit logu** (řetěz je trvalý a nejde mazat). Ukládají se do postranních tabulek `audit_request_context` (k řádkům audit logu) a `access_log` (přihlášení, neúspěšná přihlášení a odhlášení; není součástí právního řetězu) a uchovávají se **12 měsíců**. Databáze odmítne takový řádek změnit nebo smazat dřív; starší maže příkaz:

```bash
fly ssh console --app stavebni-denik -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt prune-access-records"
```

**Spouštějte ho pravidelně** (např. týdně): lhůta je slib v zásadách ochrany osobních údajů. Pravidelné spouštění zatím není nastavené (čeká na produkční infrastrukturu, stejně jako zálohy). Zálohy obsahují tyto tabulky také, takže se na ně vztahuje stejná lhůta: zálohy starší než 12 měsíců je třeba mazat.

## Aktualizace

```bash
git checkout main && git pull
fly deploy --app stavebni-denik
```

V produkci aplikace **schéma sama nemigruje** (`MIGRATE_ON_START` je tam ve výchozím stavu vypnuté): pokud schéma není aktuální, odmítne nastartovat s hláškou „the database schema is out of date ... run the migrate command“. Postup je proto: `migrate` s údaji vlastníka (jako v kroku 4), potom `fly deploy`. Migrace se nevracejí zpět, takže před nasazením zkontrolujte, že předchozí verze aplikace s novým schématem funguje (nasazení a migrace se překrývají jen na dobu startu).

**Jednodušší, slabší varianta pro testovací data:** jedna role, `MIGRATE_ON_START=true` a `DB_USER` = vlastník. Funguje, ale aplikace pak vlastní tabulky a kdo získá její heslo, může vypnout triggery, které chrání záznamy (viz „Database roles“ v `PROJECT.md`). Pro skutečná data ji nepoužívejte.
