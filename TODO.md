# Vize pro Refactoring a DevOps

Tento dokument slouží jako backlog technického dluhu, nápadů na refactoring a vylepšení infrastruktury (DevOps), které by měly být výhledově implementovány pro zefektivnění vývoje a údržby projektu.

## 💡 1. Refactoring (Codebase)

- [ ] **Rozbití monolitických UI panelů**
  - _Kde:_ `HandoversPanel.tsx`, `AuthorizedPersonsPanel.tsx`
  - _Problém:_ Soubory začínají příliš bobtnat (přes 300 řádků). Spojují zobrazení tabulky, state management a modální okna.
  - _Řešení:_ Vyčlenit formulářové modaly (např. `<CreateHandoverModal />`, `<AddAuthorizedPersonModal />`) do samostatných souborů pro lepší čitelnost a znovupoužitelnost.

- [ ] **Dekompozice PDF šablony**
  - _Kde:_ `print/project/[id]/page.tsx`
  - _Problém:_ Generování PDF sestává z obrovského JSX bloku, který míchá logiku deníku i hlaviček.
  - _Řešení:_ Rozdělit do menších, čistě prezentačních tiskových komponent (např. `<PrintCoverPage />`, `<PrintDailyRecord />`, `<PrintFooter />`), což usnadní přidávání případných dalších legislativních dokumentů v budoucnu.

- [ ] **Striktní Error Handling & Types (Server Actions)**
  - _Kde:_ Globálně v Server Actions a chytání chyb v UI komponentách.
  - _Problém:_ Občasné spoléhání na `unknown`/`any` při `try/catch`.
  - _Řešení:_ Zavést jednotnou třídu (např. `AppError`) a vytvořit wrapper typu `safeAction` pro Server Actions. Tím se zajistí, že akce budou na frontend vracet jasně definovaný a silně typovaný výsledek/chybu, což eliminuje nutnost odchytávat a typovat obecné výjimky.

## 🚀 2. DevOps a Pull Request Flow

- [x] **Kompletní GitHub Actions CI Pipeline**
  - _Kde:_ `.github/workflows/ci.yml`
  - _Úkol:_ Nastavit automatické CI běhy pro každý nový Pull Request.
  - _Kroky:_
    1. Typová kontrola (`pnpm typecheck`).
    2. ESLint linter.
    3. Spuštění unit a integračních testů (např. Vitest). Využít vestavěnou podporu pro Testcontainers/Docker k natočení PostgreSQL.
    4. Zablokování merge tlačítka, pokud testy neprojdou.

- [x] **E2E testy (Playwright) v Pipeline**
  - _Kde:_ Integrace do GitHub Actions
  - _Úkol:_ Zahrnout plný build aplikace (`pnpm build`) a proti němu spustit sadu E2E testů, abychom zaručili, že se nerozbijí uživatelská flow typu přihlašování, vyplňování formulářů a potvrzování.

- [x] **Pre-commit Hooky (Husky & lint-staged)**
  - _Úkol:_ Zamezit commitnutí špatně formátovaného nebo nevalidního kódu rovnou na lokálním stroji.
  - _Řešení:_ Nastavit `husky` spouštějící `lint-staged` pro rychlou Prettier/ESLint kontrolu pouze těch souborů, které jsou součástí commitu. Ušetří se tím čekání na CI/CD.

- [x] **Šablona pro Pull Requesty**
  - _Kde:_ `.github/pull_request_template.md`
  - _Úkol:_ Vytvořit standardizovaný PR popis obsahující checklist (např. "Byly přidány testy?", "Funguje export?", atd.), aby se nezapomínalo na klíčové aspekty kvality.
