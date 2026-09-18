export const PRINT_CSS = [
  "@page { size: A4; margin: 0; }",
  "html, body { background: #fff !important; }",
  "body { font-family: 'Liberation Sans', sans-serif; color: #222; font-size: 11pt; line-height: 1.35; margin: 0; padding: 0; }",
  "#print-root { padding: 10mm 12mm; max-width: none; }",
  "#print-root h1 { font-size: 18pt; margin: 0 0 8pt; }",
  "#print-root h2 { font-size: 14pt; margin: 0 0 4pt; }",
  "#print-root .project-card { border: 1pt solid #ccc; padding: 8pt; margin-bottom: 16pt; }",
  "#print-root .project-card dl { display: grid; grid-template-columns: 38mm 1fr; gap: 2pt 8pt; margin: 4pt 0 0; }",
  "#print-root .project-card dt { color: #555; }",
  "#print-root .project-card dd { margin: 0; }",
  "#print-root .day { padding-top: 6pt; }",
  "#print-root .day-break { page-break-before: always; padding-top: 0; }",
  "#print-root .day-header h2 { display: inline-block; margin-right: 8pt; }",
  "#print-root .day-meta { display: inline; color: #555; font-size: 9pt; }",
  "#print-root .weather, #print-root .workers { margin: 4pt 0; }",
  "#print-root .field { margin: 4pt 0; }",
  "#print-root .field-label { font-weight: 600; font-size: 10pt; color: #333; }",
  "#print-root .field-value { white-space: pre-wrap; }",
  "#print-root .block { margin: 6pt 0; }",
  "#print-root .block-title { font-weight: 600; font-size: 10pt; margin-bottom: 2pt; }",
  "#print-root .multiline { white-space: pre-wrap; margin-left: 8pt; }",
  "#print-root .remarks, #print-root .materials, #print-root .addenda { margin: 0; padding-left: 14pt; }",
  "#print-root .remarks li, #print-root .materials li, #print-root .addenda li { margin-bottom: 4pt; page-break-inside: avoid; }",
  "#print-root .dim { color: #777; font-size: 9pt; }",
  "#print-root .official { background: #fee; padding: 0 4pt; border-radius: 2pt; font-size: 9pt; }",
  "#print-root .photos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4pt; }",
  "#print-root .photo { width: 100%; height: 35mm; object-fit: cover; border: 0.5pt solid #ddd; page-break-inside: avoid; }",
  "#print-root .empty { color: #666; font-style: italic; }",
].join("\n");

export function PrintStyles() {
  return <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />;
}
