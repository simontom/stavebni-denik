# Bezpečnostní architektura (Security Architecture)

Tento dokument slouží jako **jediný zdroj pravdy** pro bezpečnostní mechanismy, ochranu dat a bezpečnostní invarianty aplikace Stavební deník.

---

## Obsah

1. [Autentizace a hesla](#1-autentizace-a-hesla)
2. [Autorizace a RBAC (Řízení přístupu)](#2-autorizace-a-rbac-řízen%C3%AD-p%C5%99%C3%ADstupu)
3. [Kryptografický Audit Log (Tamper-evident)](#3-kryptografick%C3%BD-audit-log-tamper-evident)
4. [Airlock pro Upload Obrázků (Photo Security)](#4-airlock-pro-upload-obr%C3%A1zk%C5%AF-photo-security)
5. [Ochrana před SSRF (Server-Side Request Forgery)](#5-ochrana-p%C5%99ed-ssrf)
6. [Rate Limiting a Ochrana před DoS](#6-rate-limiting-a-ochrana-p%C5%99ed-dos)
7. [Izolace Generování PDF (Sandbox & Queue)](#7-izolace-generov%C3%A1n%C3%AD-pdf-sandbox--queue)

---

## 1. Autentizace a hesla

* **Hasování hesel**: Používá **Argon2id** (prostřednictvím `@node-rs/argon2`), což je nejvyšší současný standard odolný vůči GPU/ASIC bruteforce útokům a side-channel analýze.
* **Politika hesel**: Vynucuje se minimální délka (12 znaků), kombinace malých/velkých písmen, čísel a speciálních znaků (`validatePasswordPolicy`).
* **Relace (Sessions)**: Zabezpečeno přes **Auth.js v5** (NextAuth).
  * Cookie jsou nastaveny s prázdným JavaScript přístupem (`HttpOnly`), šifrováním HTTPS (`Secure`) a laxním křížovým odesíláním (`SameSite=Lax`).
  * Relace obsahují kryptograficky podepsané JWT tokeny.

---

## 2. Autorizace a RBAC (Řízení přístupu)

* **Doménové role**:
  * `BOSS` (Stavbyvedoucí) — Správa projektů, zápis denních záznamů, ČKAIT číslo, **podpis záznamu** (uzamčení).
  * `ADMIN` — Správa uživatelů a projektů, přístup k auditním logům a verifikaci řetězce.
  * `USER` / `WORKER` — Omezený přístup pouze k přiřazeným projektům.
* **Service-layer autorizace**: Všechny serverové mutace a dotazy prochází přes servisní vrstvu s explicitní kontrolou oprávnění (`assertCan(user, permission, resource)`).
* **Nezměnitelnost podepsaných záznamů**: Jakmile je denní záznam podepsán stavbyvedoucím (`DailyReport.signedAt NOT NULL`), je databázově i na úrovni aplikační logiky zamknut proti úpravám. Jakékoliv pozdější změny musí jít formou oficiálního **dodatku (errata)** s evidencí autora a času.

---

## 3. Kryptografický Audit Log (Tamper-evident)

Zákonný požadavek na deník vyžaduje absolutní nezpochybnitelnost historie.

* **Append-only DB trigger**: Na úrovni PostgreSQL databáze je vytvořen trigger, který **striktně zakazuje `UPDATE` a `DELETE`** nad tabulkou `audit_log`. Ani uživatel s právy DB roota nemůže existující záznam změnit nebo smazat.
* **Kryptografický Hash Chain**: Každý řádek obsahuje `rowHash`, který se počítá jako SHA-256 hash z předchozího hashe (`prevHash`) + ID aktéra + akce + entity + payloadu + časového razítka:
  $$\text{rowHash} = \text{SHA256}(\text{prevHash} \mathbin{\Vert} \text{actorId} \mathbin{\Vert} \text{action} \mathbin{\Vert} \text{payload} \mathbin{\Vert} \text{ts})$$
* **Verifikace integrity**: V administraci (`/admin/audit`) je k dispozici tlačítko pro synchronní přepočet celého řetězce. Pokud by někdo přímo v DB pozměnil historická data, řetězec se rozpadne a systém vyvolá poplach.

---

## 4. Airlock pro Upload Obrázků (Photo Security)

Upload fotek ze staveb je navržen jako striktní **bezpečnostní airlock**, který znemožňuje spuštění kódů, XSS, polyglot soubory i DoS útoky.

### Hrozby a jejich mitigace

| Hrozba | Mitigace |
|---|---|
| **Polyglot soubory** (Obrázek + ZIP/PHP/JS) | **Nikdy neukládáme původní soubor.** `sharp` načte pixely do paměti a vygeneruje kompletně nový čistý JPEG. Všechna vložená spustitelná data jsou zničena. |
| **XSS přes SVG nebo EXIF** | SVG je odmítnuto už na úrovni hlavičky (XML text). EXIF metadata (Kamera, GPS) jsou při re-encode automaticky odstraněna. Výstup se servíruje s `Content-Type: image/jpeg`. |
| **Decompression Bombs (Zip bomb)** | Před alokací pixelů v paměti kontrolujeme metadata. Pokud obrázek přesahuje **8 Megapixelů** (`MAX_PIXELS`), upload je okamžitě zamítnut. Byte limit je max **5 MB** (`MAX_UPLOAD_BYTES`). |
| **Path Traversal & Overwrite** | Klientský název souboru se ignoruje. Ukládá se pod vygenerovaným `randomUUID().jpg`. Cesta je validována proti úniku z adresáře (`resolvePhotoAbsolutePath`). |

### Krok za krokem validace uploadu

```
1. Klientská před-úprava  ──> HTML5 Canvas zmenší fotku na max 1920px (šetří data)
2. HTTP Rate Limiter      ──> Max 60 uploadů / 5 minut per uživatel
3. Byte Size Check        ──> Odmítnutí souborů > 5 MB
4. Magic Byte Check (Fast)──> O(1) kontrola prvních 12 bytů (FF D8 FF, 89 50 4E 47, RIFF...WEBP, ftyp)
5. Sharp Format Check     ──> Autoritativní validace struktury kontejneru
6. Pixel Count Check      ──> Odmítnutí výstupu > 8 MP (ochrana RAM)
7. Re-encoding & Clean    ──> Zmenšení na 1920px, ořez EXIF, konverze do čistého JPEG
8. Safe Disk Write        ──> Zápis do /data/photos/... pod randomUUID().jpg
```

---

## 5. Ochrana před SSRF (Server-Side Request Forgery)

Aplikace stahuje automatická data o počasí ze staveniště.

* **Open-Meteo Whitelist**: Všechny odchozí HTTP požadavky na počasi se striktně omezují na doménu `api.open-meteo.com`.
* **Klientská izolace**: Vstupní souřadnice (zeměpisná šířka a délka) jsou před odesláním validovány číselnými rozsahy (Lat `-90..90`, Lon `-180..180`), což znemožňuje injection útoky do URL.

---

## 6. Rate Limiting a Ochrana před DoS

* **Přihlášení**: Omezeno na 5 neúspěšných pokusů za 15 minut na IP/účet (prevence brute-force).
* **Upload fotek**: 60 fotek za 5 minut na uživatele.
* **Reset hesla**: Omezení četnosti generování tokenů pro reset hesla.

---

## 7. Izolace Generování PDF (Sandbox & Queue)

Generování oficiálních exportů deníku do PDF využívá headless Chromium (Playwright).

* **In-process Fronta (`pdf-queue.ts`)**: Běh Chromia je sériovalizován přes frontu slotů, aby současné požadavky od více uživatelů nezpůsobily přetížení CPU/RAM serveru.
* **Izolovaný kontext**: Každé generování probíhá v samostatném, čistém browser kontextu, který je po dokončení okamžitě zničen.
