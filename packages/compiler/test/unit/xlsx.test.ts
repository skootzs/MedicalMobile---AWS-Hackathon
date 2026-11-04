import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { xlsFormToXlsx, type XlsForm } from '../../src/xlsform-adapter.ts';

const form: XlsForm = {
  survey: {
    columns: ['type', 'name', 'label::en', 'calculation'],
    rows: [
      { type: 'integer', name: 'rate', 'label::en': 'Breaths < 50 & "calm"' },
      { type: 'calculate', name: 'fast', calculation: "if(${rate} >= 50, 'yes', 'no')" },
    ],
  },
  choices: { columns: ['list_name', 'name', 'label::en'], rows: [{ list_name: 'yes_no', name: 'yes', 'label::en': 'Yes' }] },
  settings: { columns: ['form_id'], rows: [{ form_id: 'demo' }] },
};

// Reads entries back from the central directory of a zip produced by our writer.
function readZip(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes);
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(offset + 26);
    const data = buf.subarray(offset + 30 + localNameLen, offset + 30 + localNameLen + size);
    entries.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen;
  }
  return entries;
}

describe('xlsFormToXlsx', () => {
  it('is byte-for-byte reproducible', () => {
    assert.deepEqual(Buffer.from(xlsFormToXlsx(form)), Buffer.from(xlsFormToXlsx(form)));
  });

  it('writes the three XLSForm sheets in order', () => {
    const entries = readZip(xlsFormToXlsx(form));
    assert.deepEqual([...entries.keys()], [
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml',
    ]);
    const workbook = entries.get('xl/workbook.xml')!;
    assert.ok(workbook.indexOf('name="survey"') < workbook.indexOf('name="choices"'));
    assert.ok(workbook.indexOf('name="choices"') < workbook.indexOf('name="settings"'));
  });

  it('escapes cell text and keeps expressions intact', () => {
    const survey = readZip(xlsFormToXlsx(form)).get('xl/worksheets/sheet1.xml')!;
    assert.ok(survey.includes('Breaths &lt; 50 &amp; &quot;calm&quot;'));
    assert.ok(survey.includes("if(${rate} &gt;= 50, 'yes', 'no')"));
    assert.ok(survey.includes('<c r="D3" t="inlineStr">'));
  });

  it('refuses rows with undeclared columns', () => {
    const bad = structuredClone(form);
    bad.survey.rows.push({ type: 'note', name: 'x', relevant: 'true()' });
    assert.throws(() => xlsFormToXlsx(bad), /undeclared columns: relevant/);
  });

  it('refuses characters XML cannot hold', () => {
    const bad = structuredClone(form);
    bad.survey.rows[0]!['label::en'] = 'bell\u0007';
    assert.throws(() => xlsFormToXlsx(bad), /character that XML cannot hold/);
  });
});
