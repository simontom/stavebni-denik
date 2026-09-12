# Vize pro Refactoring a DevOps

Tento dokument slouží jako backlog technického dluhu, nápadů na refactoring a vylepšení infrastruktury (DevOps), které by měly být výhledově implementovány pro zefektivnění vývoje a údržby projektu.

## 💡 1. Refactoring (Codebase)

- [ ] **Rozbití monolitických UI panelů**
  - *Kde:* `HandoversPanel.tsx`, `AuthorizedPersonsPanel.tsx`
  - *Problém:* Soubory začínají příliš bobtnat (přes 300 řádků). Spojují zobrazení tabulky, state management a modální okna.
  - *Řešení:* Vyčlenit formulářové modaly (např. `<CreateHandoverModal />`, `<AddAuthorizedPersonModal />`) do samostatných souborů pro lepší čitelnost a znovupoužitelnost.

- [ ] **Dekompozice PDF šablony**
  - *Kde:* `print/project/[id]/page.tsx`
  - *Problém:* Generování PDF sestává z obrovského JSX bloku, který míchá logiku deníku i hlaviček.
  - *Řešení:* Rozdělit do menších, čistě prezentačních tiskových komponent (např. `<PrintCoverPage />`, `<PrintDailyRecord />`, `<PrintFooter />`), což usnadní přidávání případných dalších legislativních dokumentů v budoucnu.

- [ ] **Striktní Error Handling & Types (Server Actions)**
  - *Kde:* Globálně v Server Actions a chytání chyb v UI komponentách.
  - *Problém:* Občasné spoléhání na `unknown`/`any` při `try/catch`. 
  - *Řešení:* Zavést jednotnou třídu (např. `AppError`) a vytvořit wrapper typu `safeAction` pro Server Actions. Tím se zajistí, že akce budou na frontend vracet jasně definovaný a silně typovaný výsledek/chybu, což eliminuje nutnost odchytávat a typovat obecné výjimky.

## 🚀 2. DevOps a Pull Request Flow

- [ ] **Kompletní GitHub Actions CI Pipeline**
  - *Kde:* `.github/workflows/ci.yml`
  - *Úkol:* Nastavit automatické CI běhy pro každý nový Pull Request.
  - *Kroky:*
    1. Typová kontrola (`pnpm typecheck`).
    2. ESLint linter.
    3. Spuštění unit a integračních testů (např. Vitest). Využít vestavěnou podporu pro Testcontainers/Docker k natočení PostgreSQL.
    4. Zablokování merge tlačítka, pokud testy neprojdou.

- [ ] **E2E testy (Playwright) v Pipeline**
  - *Kde:* Integrace do GitHub Actions
  - *Úkol:* Zahrnout plný build aplikace (`pnpm build`) a proti němu spustit sadu E2E testů, abychom zaručili, že se nerozbijí uživatelská flow typu přihlašování, vyplňování formulářů a potvrzování.

- [ ] **Pre-commit Hooky (Husky & lint-staged)**
  - *Úkol:* Zamezit commitnutí špatně formátovaného nebo nevalidního kódu rovnou na lokálním stroji.
  - *Řešení:* Nastavit `husky` spouštějící `lint-staged` pro rychlou Prettier/ESLint kontrolu pouze těch souborů, které jsou součástí commitu. Ušetří se tím čekání na CI/CD.

- [ ] **Šablona pro Pull Requesty**
  - *Kde:* `.github/pull_request_template.md`
  - *Úkol:* Vytvořit standardizovaný PR popis obsahující checklist (např. "Byly přidány testy?", "Funguje export?", atd.), aby se nezapomínalo na klíčové aspekty kvality.

- [ ] **Auto-Update indexu pro AI (Graft)**
  - *Úkol:* Udržovat kontext repozitáře (Graft index) aktuální pro AI agenty bez nutnosti manuálních zásahů.
  - *Řešení:* Vytvořit GitHub Action, která se spustí po každém mergi do `main`, zavolá `graft build` a commitne aktualizovaný kontextový graf (je-li třeba).
