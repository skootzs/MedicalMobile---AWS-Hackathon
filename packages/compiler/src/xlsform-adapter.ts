import { zip } from './zip.ts';

export type XlsFormRow = Record<string, string>;

export interface XlsFormSheet {
  columns: string[];
  rows: XlsFormRow[];
}

export interface XlsForm {
  survey: XlsFormSheet;
  choices: XlsFormSheet;
  settings: XlsFormSheet;
}

const SHEETS = ['survey', 'choices', 'settings'] as const;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

function escapeXml(text: string): string {
  if (INVALID_XML_CHARS.test(text)) throw new Error(`Cell text contains a character that XML cannot hold: ${JSON.stringify(text)}`);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function sheetXml(sheet: XlsFormSheet): string {
  const lines = [sheet.columns, ...sheet.rows.map((row) => sheet.columns.map((c) => row[c] ?? ''))];
  const rows = lines.map((cells, r) => {
    const xmlCells = cells
      .map((value, c) =>
        value === ''
          ? ''
          : `<c r="${columnLetter(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`,
      )
      .join('');
    return `<row r="${r + 1}">${xmlCells}</row>`;
  });
  return `${XML_HEADER}<worksheet xmlns="${MAIN_NS}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

// Writes an .xlsx with inline strings only. Output bytes depend only on the input.
export function xlsFormToXlsx(form: XlsForm): Uint8Array {
  for (const name of SHEETS) {
    const sheet = form[name];
    for (const row of sheet.rows) {
      const unknown = Object.keys(row).filter((k) => !sheet.columns.includes(k));
      if (unknown.length > 0) throw new Error(`Sheet '${name}' row uses undeclared columns: ${unknown.join(', ')}`);
    }
  }
  const enc = (s: string) => new TextEncoder().encode(s);
  const contentTypes =
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    SHEETS.map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join('') +
    '</Types>';
  const rootRels = `${XML_HEADER}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_REL}"><sheets>` +
    SHEETS.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const workbookRels =
    `${XML_HEADER}<Relationships xmlns="${REL_NS}">` +
    SHEETS.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    '</Relationships>';

  return zip([
    { name: '[Content_Types].xml', data: enc(contentTypes) },
    { name: '_rels/.rels', data: enc(rootRels) },
    { name: 'xl/workbook.xml', data: enc(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(workbookRels) },
    ...SHEETS.map((name, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(form[name])) })),
  ]);
}
