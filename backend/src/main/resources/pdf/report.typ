// Fixed template of the daily report PDF.
//
// User-controlled text (project name, address, work description, ...) is NEVER part of this
// file. It arrives in data.json and is shown as plain content, so it cannot be interpreted
// as typst markup or code (no `#read(...)`, no loops, no layout tricks).
//
// What the document says, in order (the data model is `ReportPdfData` in ReportPdfData.kt, section by section):
//   title and status
//   part A  the identification of the diary: the project, the firms, the persons with a role, the documents (příloha 12, part A);
//           for an entry signed in format 3 as it stood on the day of signing (part of the signature), otherwise as it stands today
//   part B  the entry of the day: every field that the signature covers, with "bez záznamu" where it says nothing
//   the signature, and the end of the entry ("Konec denního záznamu č. N")
//   the handover of the site (příloha 12 B.2 a)): the protocols of handover and takeover, each with the signatures of its two parties.
//           They have signatures of their own and are not part of the signature of the entry, so they stand after its end.
//   what was added after the signature: acknowledgements, addenda, entries of other parties (not part of the signature)
// Every page has a footer (project, number, date, page of the total); a draft has a watermark across every page.
#let d = json("data.json")

#let grey = luma(105)
#let rule = 0.5pt + luma(140)
#let none-mark = text(fill: grey, style: "italic")[bez záznamu]

// Text without a space has nowhere to break and runs over the edge of its table cell (and of the page): a word longer than `max`
// characters is given a place to break after every `max` of them, a zero-width space that prints nothing (but is in the text that is
// copied out of the document, so `max` is long enough for an ordinary word to stay whole). Words that are shorter are left as they
// are, and a line is broken at a place like that only when it is full.
#let breakable(s, max: 16) = s.split(" ").map(word => {
  let cs = word.clusters()
  if cs.len() <= max { word } else {
    range(0, cs.len(), step: max).map(i => cs.slice(i, calc.min(i + max, cs.len())).join()).join("\u{200b}")
  }
}).join(" ")

// Shows a string as plain text and keeps its line breaks. Windows line endings count as one
// break, and a tab becomes spaces (a tab character would otherwise render as nothing). With `wrap`, a very long word may break (see breakable).
#let plain(s, wrap: false, max: 16) = {
  let normalized = s.replace("\r\n", "\n").replace("\r", "\n")
  for (i, line) in normalized.split("\n").enumerate() {
    if i > 0 { linebreak() }
    let spaced = line.replace("\t", "    ")
    if wrap { breakable(spaced, max: max) } else { spaced }
  }
}

// The text, or "bez záznamu" when there is none: an empty field is stated, never left out.
#let or-none(s, wrap: false, max: 16) = if s.trim() != "" { plain(s, wrap: wrap, max: max) } else { none-mark }

// The sentence that says how many lines of a text did not fit the budget of lines of the document (it is empty when nothing was left
// out): a text is never cut without saying so, and the sentence is not part of the text.
#let cut-note(s) = if s != "" { block(above: 0.4em, text(size: 9pt, style: "italic", fill: grey)[#plain(s)]) }

// A text on one line, cut with an ellipsis when it is long (for the footer, which has a fixed height).
#let one-line(s, max) = {
  let flat = s.replace(regex("\s+"), " ").trim()
  let cs = flat.clusters()
  if cs.len() > max { cs.slice(0, max).join() + "…" } else { flat }
}

// A hash, in a monospaced font small enough for 64 characters to fit on a line of a table.
#let hash(s) = text(font: "DejaVu Sans Mono", size: 7.5pt)[#s]

// A table of "label: value" rows with a shaded label column. `rows` is an array of (label, value) pairs.
#let facts(rows) = table(
  columns: (5.2cm, 1fr),
  stroke: rule,
  inset: (x: 6pt, y: 5pt),
  fill: (x, y) => if x == 0 { luma(243) },
  ..rows.map(r => (strong[#r.at(0):], r.at(1))).flatten(),
)

// "Entry no. 5", or the words for an entry that has no number yet.
#let entry-label = if d.sequenceNumber != none [Záznam č. #d.sequenceNumber] else [Záznam bez čísla]

#set document(title: "Denní záznam stavby")
#set page(
  paper: "a4",
  margin: (x: 2cm, top: 2cm, bottom: 2.4cm),
  footer-descent: 0.5cm,
  footer: context {
    set text(size: 8.5pt, fill: grey)
    line(length: 100%, stroke: 0.4pt + luma(160))
    v(0.1em)
    grid(
      columns: (1fr, auto),
      column-gutter: 1em,
      [#one-line(d.projectName, 70) · #entry-label · #d.date],
      [Strana #counter(page).display() z #counter(page).final().first()],
    )
  },
  // An entry that is not signed is a draft: every page says so, across the text. It is drawn over the page (translucent), so
  // the shaded cells of the tables do not hide it.
  foreground: if d.isSigned { none } else {
    // The box is wider than the words, so that the line is never wrapped.
    place(
      center + horizon,
      rotate(-40deg, box(width: 720pt, align(center, text(size: 42pt, weight: "bold", fill: rgb(190, 30, 30, 50))[KONCEPT – NEPODEPSÁNO]))),
    )
  },
)
#set text(font: "Libertinus Serif", size: 10.5pt, lang: "cs")

// level 1: the title; level 2: a part of the document; level 3: a field of the entry. A heading stays with what follows it.
#show heading.where(level: 1): it => block(sticky: true, above: 0pt, below: 0.7em, text(size: 18pt, weight: "bold", it.body))
#show heading.where(level: 2): it => block(
  sticky: true,
  above: 1.6em,
  below: 0.8em,
  width: 100%,
  stroke: (bottom: 0.8pt + luma(60)),
  inset: (bottom: 3pt),
  text(size: 13pt, weight: "bold", it.body),
)
#show heading.where(level: 3): it => block(sticky: true, above: 1.1em, below: 0.5em, text(size: 10.5pt, weight: "bold", it.body))

// ---- title and status ---------------------------------------------------------------------------

= Denní záznam stavby #if d.sequenceNumber != none [č. #d.sequenceNumber] else [(rozpracovaný, zatím bez čísla)]

#text(size: 11pt)[
  #strong[#plain(d.projectName)] · #d.weekday #d.date ·
  #if d.isSigned [podepsán a uzamčen] else [rozpracovaný, nepodepsáno]
]

// ---- part A: the identification of the diary --------------------------------------------------------

== Část A – Údaje o stavbě (identifikace deníku)

#facts((
  ([Stavba], plain(d.projectName)),
  ([Adresa], plain(d.address)),
  // The identification as entered about the project: only rows that have a value.
  ..d.projectInfo.map(x => ([#x.label], plain(x.value))),
  ..if d.subcontractors != "" { (([Poddodavatelé], plain(d.subcontractors)),) } else { () },
  ..if d.supportingDocuments != "" { (([Podklady stavby], plain(d.supportingDocuments)),) } else { () },
))

// The persons of part A (příloha 12 A d), e), f)): who ensures the technical management of the works and for what, the
// supervision, and the persons who may make entries. A table that has no row is not printed.
#let people(rows) = table(
  columns: (1fr, 3.2cm, 1.4fr),
  stroke: rule,
  inset: (x: 6pt, y: 5pt),
  fill: (x, y) => if y == 0 { luma(243) },
  table.header([*Jméno*], [*Číslo ČKAIT*], [*Rozsah oprávnění a odpovědnosti*]),
  ..rows.map(m => (
    [#plain(m.name, wrap: true)#if m.siteManager [ (stavbyvedoucí)]],
    // A narrow column: a number of up to seven characters (the usual one) is never broken, and seven of the widest letters fit.
    if m.ckait != "" { plain(m.ckait, wrap: true, max: 7) } else [—],
    or-none(m.scope, wrap: true),
  )).flatten(),
)

#if d.managers.len() > 0 [
  === Osoby zajišťující odborné vedení provádění stavby

  #people(d.managers)
]

#if d.supervisors.len() > 0 [
  === Dozor (technický dozor stavebníka, autorský dozor)

  #people(d.supervisors)
]

#if d.authorizedPersons.len() > 0 [
  === Pověřené osoby (osoby oprávněné zapisovat do deníku, § 166 odst. 2)

  #table(
    columns: (1fr, 1fr, 1.4fr),
    stroke: rule,
    inset: (x: 6pt, y: 5pt),
    fill: (x, y) => if y == 0 { luma(243) },
    table.header([*Jméno*], [*Organizace*], [*Funkce, rozsah pověření*]),
    ..d.authorizedPersons.map(p => (plain(p.name, wrap: true), or-none(p.company, wrap: true), or-none(p.function, wrap: true))).flatten(),
  )
]

#if d.projectInfoNote != "" [
  #v(0.3em)
  #text(size: 9pt, style: "italic", fill: grey)[#plain(d.projectInfoNote)]
]

// ---- part B: the entry of the day ----------------------------------------------------------------------

== Část B – Záznam za den

#facts((
  ([Datum], [#d.weekday #d.date]),
  ([Číslo záznamu], if d.sequenceNumber != none [č. #d.sequenceNumber] else [zatím bez čísla (číslo se přidělí při podpisu)]),
  ([Stav záznamu], if d.isSigned [podepsán a uzamčen] else [rozpracovaný, nepodepsáno]),
  ([Autor záznamu], or-none(d.author, wrap: true)),
  // A late entry (written after the previous working day) says so, with the author's reason.
  ..if d.isLateEntry { (([Pozdní zápis], plain(d.lateEntryReason)),) } else { () },
  ([Kontrolní den], if d.isControlDay [ano (proběhla stavební kontrola)] else [ne]),
  ([Stavební objekt (SO)], [#or-none(d.constructionObj)#cut-note(d.constructionObjCut)]),
))

=== Počasí

#plain(d.weather)

=== Pracovníci na stavbě

#if d.workers.len() > 0 [
  #table(
    columns: (auto, auto, 1fr),
    stroke: rule,
    inset: (x: 6pt, y: 5pt),
    fill: (x, y) => if y == 0 { luma(243) },
    table.header([*Profese*], [*Počet*], [*Jména*]),
    ..d.workers.map(w => (plain(w.trade), [#w.count], plain(w.names))).flatten(),
    // The total is printed once, under the last row (not repeated on every page of a long table).
    table.footer(repeat: false, [*Celkem*], [*#d.workers.map(w => w.count).sum(default: 0)*], []),
  )
  #cut-note(d.workersCut)
] else [#none-mark]

=== Popis prací

#or-none(d.workDescription)
#cut-note(d.workDescriptionCut)

// The other fields the vyhláška asks for: every one has its heading (the labels are fixed in the application, the text is plain content).
#for x in d.details [
  === #x.label

  #or-none(x.text)
  #cut-note(x.cut)
]

=== Fotografie

#if d.photos.len() > 0 [
  Počet fotografií: #d.photos.len(). Fotografie samotné jsou v aplikaci; zde je otisk (SHA-256) každého souboru, a ty jsou součástí obsahu, který podpis pokrývá.

  #table(
    columns: (auto, 1fr),
    stroke: rule,
    inset: (x: 6pt, y: 5pt),
    fill: (x, y) => if y == 0 { luma(243) },
    table.header([*Č.*], [*Nahrál(a), čas, otisk souboru (SHA-256)*]),
    ..d.photos.enumerate().map(((i, p)) => (
      [#(i + 1)],
      [#plain(p.uploadedBy, wrap: true), #p.at \ #if p.sha256 != "" [#hash(p.sha256)] else [otisk neuložen]],
    )).flatten(),
  )
] else [#none-mark]

// ---- the signature and the end of the entry ---------------------------------------------------------------
// One block that is never split between two pages: the signature, and the line that closes the entry, stay together.

#block(breakable: false, width: 100%)[
  == Podpis

  #if d.isSigned [
    #facts((
      ([Podepsal], plain(d.signedBy)),
      ([Čas podpisu], [#d.signedAt]),
      ([Číslo záznamu], [č. #d.sequenceNumber]),
      ([ID záznamu], hash(d.entryId)),
      // The hash of the content as it was signed; it can be checked in the application ("Ověřit podpis").
      // Only an entry of the first signature format can be old enough to have no hash (and, in test data, no audit row); a
      // missing hash or row in a later format is a failure of the check, and is said so, not explained away.
      ([Otisk obsahu (SHA-256)], if d.signatureHash != "" { hash(d.signatureHash) } else if d.signatureFormat == 1 [neuložen (záznam byl podepsán před zavedením otisků)] else [otisk podpisu chybí: záznam nelze ověřit]),
      // From format 3 on the identification of the diary as it stood is stored with the signature, and its hash is part of what is signed.
      ..if d.signatureFormat != none and d.signatureFormat >= 3 {
        (([Otisk údajů o stavbě (SHA-256)], if d.partASha256 != "" { hash(d.partASha256) } else [údaje o stavbě platné ke dni podpisu nejsou uloženy: záznam nelze ověřit]),)
      } else { () },
      // The audit row that recorded the signature: its `after` holds the hash above, so it ties this entry to the chain.
      ([Podpis v auditním řetězci (SHA-256 řádku)], if d.auditRowHash != "" { hash(d.auditRowHash) } else if d.signatureFormat == 1 [nenalezen (záznam byl podepsán před zavedením auditního deníku)] else [záznam o podpisu v auditním řetězci chybí: záznam nelze ověřit]),
    ))
    #v(0.3em)
    #text(size: 8.5pt, style: "italic", fill: grey)[Otisk obsahu lze ověřit v aplikaci (Ověřit podpis). Řádek auditního řetězce, který podpis zapsal, obsahuje týž otisk, a váže tak vytištěný záznam k řetězci.#if d.signatureFormat != none and d.signatureFormat >= 3 [ Jméno a číslo ČKAIT podepisujícího a údaje o stavbě (část A) se uložily při podpisu a podpis je pokrývá.]]
  ] else [
    #rect(width: 100%, stroke: rule, inset: 8pt)[
      Záznam není podepsán. Dokud není podepsán, může se měnit; číslo mu bude přiděleno při podpisu.
    ]
  ]

  #v(1.2em)
  #align(center)[
    #line(length: 55%, stroke: 0.6pt)
    #v(0.1em)
    #strong[
      #if d.sequenceNumber != none [Konec denního záznamu č. #d.sequenceNumber] else [Konec rozpracovaného denního záznamu (zatím bez čísla; číslo bude přiděleno při podpisu)]
    ]
    #v(0.1em)
    #line(length: 55%, stroke: 0.6pt)
  ]
]

// ---- the handover of the site (příloha 12 B.2 a)) ---------------------------------------------------------
// The protocols of handover and takeover of the site. They have the signatures of their own two parties, not the signature of this
// entry, which is why they come after its end; the note says so, and which state of the protocols it describes. Each protocol is a table
// of its content and, below it, ONE block with the signatures of its two sides that is never split between two pages.

#let party(label, s) = (
  label,
  if s == none [zatím nepodepsáno] else [#plain(s.signedBy, wrap: true) \ #s.at \ #hash(s.signatureHash)],
)

== Předání a převzetí staveniště

// The note stays with the heading above it and with the first protocol below it (a sticky block is never the last thing on a page).
#block(sticky: true, text(size: 9pt, style: "italic", fill: grey)[#plain(d.handoversNote)])

#if d.handovers.len() == 0 [
  #none-mark
]

#for (i, h) in d.handovers.enumerate() [
  === Protokol č. #(i + 1)

  // Text of a protocol is free text up to 5 000 characters: a word without a space breaks inside its cell (a column of 11 cm: 28 letters).
  #facts((
    ([Typ předání], plain(h.type, wrap: true, max: 28)),
    ([Datum předání], [#h.date]),
    ([Účastníci], or-none(h.participants, wrap: true, max: 28)),
    ([Poznámky], or-none(h.notes, wrap: true, max: 28)),
    ([Stav protokolu], [#h.state]),
  ))

  #v(0.4em)
  #strong[Stavy měřidel]
  #v(0.2em)

  #if h.meters.len() > 0 [
    #table(
      columns: (1fr, 1fr, 1fr),
      stroke: rule,
      inset: (x: 6pt, y: 4pt),
      fill: (x, y) => if y == 0 { luma(243) },
      table.header([*Médium*], [*Výrobní číslo*], [*Stav*]),
      // A cell is 148 pt wide, and the widest capital (W, M) is 10 pt: a word breaks after 12 characters, which are 119 pt of the widest letters.
      ..h.meters.map(m => (
        if m.medium.trim() != "" { plain(m.medium, wrap: true, max: 12) } else [—],
        if m.serialNumber.trim() != "" { plain(m.serialNumber, wrap: true, max: 12) } else [—],
        if m.state.trim() != "" { plain(m.state, wrap: true, max: 12) } else [—],
      )).flatten(),
    )
  ] else [#none-mark]
  #cut-note(h.cut)

  #v(0.4em)
  #block(breakable: false, width: 100%)[
    // The block may land on a page of its own (it is never split), so it says whose signatures these are.
    #strong[Podpisy protokolu č. #(i + 1)]
    #v(0.2em)
    #facts((
      party([Podpis strany zhotovitele], h.contractor),
      party([Podpis strany stavebníka], h.client),
      ..if h.contentHash != "" { (([Otisk obsahu protokolu (SHA-256)], hash(h.contentHash)),) } else { () },
    ))
  ]
  #v(0.6em)
]

#cut-note(d.handoversLeftOutNote)

// ---- what was added after the signature -----------------------------------------------------------------------
// These are separate records with their own author and time; they are not part of what the signature covers. An entry of
// another party can also be made on a draft, which has no signature to come after: its heading says so in neutral words.

#if d.acknowledgements.len() > 0 or d.addenda.len() > 0 or d.remarks.len() > 0 or d.recordsLeftOutNote != "" [
  #if d.isSigned [
    == Připojeno po podpisu záznamu

    #text(size: 9pt, style: "italic", fill: grey)[Následující zápisy vznikly samostatně, s vlastním autorem a časem; nejsou součástí podpisu záznamu.]
  ] else [
    == Zápisy připojené k záznamu (záznam ještě není podepsán)

    #text(size: 9pt, style: "italic", fill: grey)[Následující zápisy vznikly samostatně, s vlastním autorem a časem.]
  ]

  // Who took note of the signed entry.
  #if d.acknowledgements.len() > 0 [
    === Seznámení se záznamem

    #for a in d.acknowledgements [
      - #plain(a.who, wrap: true), #a.at
    ]
  ]

  // Addenda: corrections and additions to the signed entry, each with its author and time.
  #if d.addenda.len() > 0 [
    === Dodatky

    #for a in d.addenda [
      *#plain(a.author, wrap: true)*, #a.at

      #plain(a.text)
      #cut-note(a.cut)

      #v(0.6em)
    ]
  ]

  // Entries of other parties (supervision, the client, authorities): each says who wrote it, and for an outside party who recorded it.
  #if d.remarks.len() > 0 [
    === Zápisy dalších osob

    #for r in d.remarks [
      #if r.onBehalfOf != "" [
        *#plain(r.onBehalfOf, wrap: true)* (zapsal #plain(r.author, wrap: true)), #r.at
      ] else [
        *#plain(r.author, wrap: true)*, #r.at
      ]

      #plain(r.text)
      #cut-note(r.cut)

      #v(0.6em)
    ]
  ]

  #cut-note(d.recordsLeftOutNote)
]
