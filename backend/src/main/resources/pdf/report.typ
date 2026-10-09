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

= Denní záznam stavby č. #d.sequenceNumber

#table(
  columns: (auto, 1fr),
  stroke: none,
  [*Stavba:*], [#plain(d.projectName)],
  [*Adresa:*], [#plain(d.address)],
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

== Popis prací

#plain(d.workDescription)

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
