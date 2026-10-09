// Fixed template of the daily report PDF.
//
// User-controlled text (project name, address, work description, ...) is NEVER part of this
// file. It arrives in data.json and is shown as plain content, so it cannot be interpreted
// as typst markup or code (no `#read(...)`, no loops, no layout tricks).
#let d = json("data.json")

#set page(paper: "a4", margin: 2cm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "cs")

// Shows a string as plain text and keeps its line breaks. Windows line endings count as one
// break, and a tab becomes spaces (a tab character would otherwise render as nothing).
#let plain(s) = {
  let normalized = s.replace("\r\n", "\n").replace("\r", "\n")
  for (i, line) in normalized.split("\n").enumerate() {
    if i > 0 { linebreak() }
    line.replace("\t", "    ")
  }
}

= Denní záznam stavby #if d.sequenceNumber != none [č. #d.sequenceNumber] else [(rozpracovaný, zatím bez čísla)]

#table(
  columns: (auto, 1fr),
  stroke: none,
  [*Stavba:*], [#plain(d.projectName)],
  [*Adresa:*], [#plain(d.address)],
  // The identification of the diary as entered about the project: only rows that have a value.
  ..d.projectInfo.map(x => ([*#x.label:*], plain(x.value))).flatten(),
  [*Datum:*], [#d.date],
  [*Stav záznamu:*], [#if d.isSigned [podepsán a uzamčen] else [rozpracovaný]],
  // A late entry (written after the previous working day) says so, with the author's reason.
  ..if d.isLateEntry {
    ([*Pozdní zápis:*], [#plain(d.lateEntryReason)])
  } else {
    ()
  },
)

== Počasí

#plain(d.weather)

#if d.workers.len() > 0 [
  == Pracovníci na stavbě

  #table(
    columns: (auto, auto, 1fr),
    stroke: none,
    [*Profese*], [*Počet*], [*Jména*],
    ..d.workers.map(w => (plain(w.trade), [#w.count], plain(w.names))).flatten(),
  )
]

== Popis prací

#plain(d.workDescription)

// The other fields the vyhláška asks for (labels are fixed in the application, the text is plain content).
#for x in d.details [
  == #x.label

  #plain(x.text)
]

#if d.subcontractors != "" [
  == Poddodavatelé

  #plain(d.subcontractors)
]

#if d.supportingDocuments != "" [
  == Podklady stavby

  #plain(d.supportingDocuments)
]

// The signature: who signed, when, and the hash of the content that was signed (it can be checked in the application).
#if d.isSigned [
  == Podpis

  #table(
    columns: (auto, 1fr),
    stroke: none,
    [*Podepsal:*], [#plain(d.signedBy)],
    [*Čas podpisu (UTC):*], [#d.signedAt],
    ..if d.signatureHash != "" {
      ([*Otisk obsahu (SHA-256):*], [#text(font: "DejaVu Sans Mono", size: 8pt)[#d.signatureHash]])
    } else {
      ()
    },
  )
]

// Who took note of the signed entry.
#if d.acknowledgements.len() > 0 [
  == Seznámení se záznamem

  #for a in d.acknowledgements [
    - #plain(a.who), #a.at (UTC)
  ]
]

// Addenda: corrections and additions to the signed entry, each with its author and time. They are not part of the signed text.
#if d.addenda.len() > 0 [
  == Dodatky

  #for a in d.addenda [
    *#plain(a.author)*, #a.at (UTC)

    #plain(a.text)

    #v(0.6em)
  ]
]

// Entries of other parties (supervision, the client, authorities): each says who wrote it, and for an outside party who recorded it.
#if d.remarks.len() > 0 [
  == Zápisy dalších osob

  #for r in d.remarks [
    #if r.onBehalfOf != "" [
      *#plain(r.onBehalfOf)* (zapsal #plain(r.author)), #r.at (UTC)
    ] else [
      *#plain(r.author)*, #r.at (UTC)
    ]

    #plain(r.text)

    #v(0.6em)
  ]
]
