// Builds a real, editable Word document: headings use Word's Heading style,
// notes are ordinary text, and each screenshot is a normal inline picture.
import { createZip } from './zip.js';
import { flatten } from './render.js';

const EMU_PER_INCH = 914400;
const TWIPS_PER_INCH = 1440;
const PAGE = { width: 11906, height: 16838, margin: 1080 }; // A4, 0.75" margins
const CONTENT_W = (PAGE.width - PAGE.margin * 2) / TWIPS_PER_INCH;
const CONTENT_H = (PAGE.height - PAGE.margin * 2) / TWIPS_PER_INCH;
const HEADER_ROOM = 0.8; // inches for the title and source line above a picture
const NOTE_LINE = 0.21; // inches per line of notes
const NOTE_CHARS_PER_LINE = 95;
const TITLE_BLOCK = 1.1; // inches used by the document title on the first page

function esc(text) {
  return String(text ?? '')
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const run = (text) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const paragraph = (style, text, extra = '') =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${run(text)}</w:p>`;

function notesParagraph(text, keepNext) {
  const runs = text.split('\n').map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + run(line)).join('');
  return `<w:p><w:pPr><w:pStyle w:val="Notes"/>${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${runs}</w:p>`;
}

function picture(image, index, altText) {
  const cx = Math.round(image.displayW * EMU_PER_INCH);
  const cy = Math.round(image.displayH * EMU_PER_INCH);
  const name = `Screenshot ${index}`;
  return `<w:p><w:pPr><w:pStyle w:val="Screenshot"/></w:pPr><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index}" name="${name}" descr="${esc(altText)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="6350"><a:solidFill><a:srgbClr val="BFC5CE"/></a:solidFill></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline>
</w:drawing></w:r></w:p>`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// How busy each row is: a row of plain background scores near zero, a row
// through text or pictures scores high.
function rowScores(canvas, from, to) {
  const rows = to - from;
  const sampleW = Math.min(canvas.width, 600);
  const probe = new OffscreenCanvas(sampleW, rows);
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, from, canvas.width, rows, 0, 0, sampleW, rows);
  const { data } = ctx.getImageData(0, 0, sampleW, rows);
  const scores = new Float64Array(rows);
  for (let row = 0; row < rows; row++) {
    let score = 0;
    const offset = row * sampleW * 4;
    for (let x = 4; x < sampleW * 4; x += 4) {
      score += Math.abs(data[offset + x] - data[offset + x - 4]);
      score += Math.abs(data[offset + x + 1] - data[offset + x - 3]);
    }
    scores[row] = score;
  }
  return { scores, quiet: (value, min) => value <= min * 1.15 + sampleW * 2 };
}

// The lowest calm row in the bottom quarter of a part, so a cut falls in a gap
// between rows of content whenever there is one.
function findCutRow(canvas, top, idealBottom) {
  const band = Math.max(1, Math.min(Math.round((idealBottom - top) * 0.25), 900));
  const start = idealBottom - band;
  const { scores, quiet } = rowScores(canvas, start, idealBottom);
  const min = Math.min(...scores);
  for (let row = band - 1; row >= 0; row--) if (quiet(scores[row], min)) return start + row;
  return idealBottom;
}

// Where the next part starts: the last calm row at or above the previous cut.
// If the cut went through a picture or text, the next part starts above it, so
// that content appears whole, even though some of it repeats.
function findRestartRow(canvas, top, bottom) {
  const earliest = Math.round(Math.max(top + (bottom - top) * 0.5, bottom - (bottom - top) * 0.35));
  if (bottom - earliest < 2) return bottom;
  const { scores, quiet } = rowScores(canvas, earliest, bottom + 1);
  const min = Math.min(...scores);
  for (let row = scores.length - 1; row >= 0; row--) if (quiet(scores[row], min)) return earliest + row;
  return bottom;
}

async function toBytes(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function imagesForStep(step, options, firstPageRoom) {
  const canvas = await flatten(step);
  const naturalWidth = canvas.width / (step.scale || 1) / 96;
  const displayW = Math.min(CONTENT_W, naturalWidth);
  const inchesPerPixel = displayW / canvas.width;
  const displayH = canvas.height * inchesPerPixel;

  const screenRows = options.splitLong && options.splitMode === 'screen' ? onScreenRows(step) : 0;
  if (screenRows) return screenParts(canvas, step, options, screenRows, displayW, inchesPerPixel, firstPageRoom);

  if (displayH <= firstPageRoom) {
    return [{ bytes: await toBytes(canvas), displayW, displayH }];
  }
  if (!options.splitLong) {
    const shrink = firstPageRoom / displayH;
    return [{ bytes: await toBytes(canvas), displayW: displayW * shrink, displayH: firstPageRoom }];
  }

  // The browser bar above the page and the taskbar below it, repeated on every part when asked.
  const fits = (rows) => rows > 0 && rows < canvas.height / 3;
  const header = options.repeatTaskbar && fits(step.headerHeight) ? Math.round(step.headerHeight) : 0;
  const footer = options.repeatTaskbar && fits(step.footerHeight) ? Math.round(step.footerHeight) : 0;
  const contentEnd = canvas.height - footer;
  const frameInches = (header + footer) * inchesPerPixel;

  const slices = [];
  let top = 0;
  let room = firstPageRoom;
  while (top < contentEnd) {
    const extraTop = top === 0 ? 0 : header; // the first part already starts with the browser bar
    const idealBottom = top + Math.floor((room - frameInches) / inchesPerPixel) + (top === 0 ? header : 0);
    const bottom = idealBottom >= contentEnd ? contentEnd : findCutRow(canvas, top, idealBottom);
    const slice = new OffscreenCanvas(canvas.width, extraTop + bottom - top + footer);
    const ctx = slice.getContext('2d');
    if (extraTop) ctx.drawImage(canvas, 0, 0, canvas.width, header, 0, 0, canvas.width, header);
    ctx.drawImage(canvas, 0, top, canvas.width, bottom - top, 0, extraTop, canvas.width, bottom - top);
    if (footer) ctx.drawImage(canvas, 0, contentEnd, canvas.width, footer, 0, extraTop + bottom - top, canvas.width, footer);
    slices.push({ bytes: await toBytes(slice), displayW, displayH: slice.height * inchesPerPixel });
    top = bottom >= contentEnd ? contentEnd : findRestartRow(canvas, top, bottom);
    room = CONTENT_H - 0.25;
  }
  return slices;
}

// How many rows of the page one screen shows, or 0 if the capture can't tell.
function onScreenRows(step) {
  if (step.screenHeight) return step.screenHeight - (step.headerHeight || 0) - (step.footerHeight || 0);
  return step.viewHeight || 0;
}

// Cuts a long screenshot into parts the size of the screen, as if each had been
// taken while scrolling. The last part lines up with the bottom of the page.
async function screenParts(canvas, step, options, rows, displayW, inchesPerPixel, firstPageRoom) {
  const H0 = Math.round(step.headerHeight || 0);
  const F0 = Math.round(step.footerHeight || 0);
  const header = options.repeatTaskbar ? H0 : 0;
  const footer = options.repeatTaskbar ? F0 : 0;
  const view = Math.round(rows);
  const contentStart = H0;
  const contentEnd = canvas.height - F0;
  const fit = (height) => {
    const maxH = Math.max(firstPageRoom, CONTENT_H - 0.4);
    const h = height * inchesPerPixel;
    return h <= maxH ? { displayW, displayH: h } : { displayW: displayW * (maxH / h), displayH: maxH };
  };
  if (view < 50 || contentEnd - contentStart <= view * 1.02) {
    return [{ bytes: await toBytes(canvas), ...fit(canvas.height) }];
  }

  const tops = [];
  for (let t = contentStart; t < contentEnd - view; t += view) tops.push(t);
  tops.push(contentEnd - view);

  const parts = [];
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i];
    const above = i === 0 ? H0 : header; // the first part always has its real browser bar
    const below = i === tops.length - 1 ? F0 : footer; // the last part always has its real taskbar
    const slice = new OffscreenCanvas(canvas.width, above + view + below);
    const ctx = slice.getContext('2d');
    if (above) ctx.drawImage(canvas, 0, 0, canvas.width, above, 0, 0, canvas.width, above);
    ctx.drawImage(canvas, 0, t, canvas.width, view, 0, above, canvas.width, view);
    if (below) ctx.drawImage(canvas, 0, contentEnd, canvas.width, below, 0, above + view, canvas.width, below);
    parts.push({ bytes: await toBytes(slice), ...fit(slice.height) });
  }
  return parts;
}

function roomOnFirstPage(step, options) {
  const notes = (step.notes || '').trim();
  const noteLines = notes
    ? notes.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / NOTE_CHARS_PER_LINE)), 0)
    : 0;
  const header = HEADER_ROOM + (options.includeSource ? 0.2 : 0);
  return Math.max(3, CONTENT_H - header - Math.min(noteLines, 16) * NOTE_LINE);
}

const NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const FOOTER = `${XML}<w:ftr ${NAMESPACES}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

const style = (id, name, based, next, pPr, rPr, extra = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"${extra}><w:name w:val="${name}"/>${based ? `<w:basedOn w:val="${based}"/>` : ''}${next ? `<w:next w:val="${next}"/>` : ''}<w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;

const STYLES = `${XML}<w:styles ${NAMESPACES}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${
  style('Normal', 'Normal', '', '', '', '', ' w:default="1"')
}${style('Title', 'Title', 'Normal', 'Subtitle', '<w:spacing w:after="60"/>', '<w:b/><w:color w:val="1F2937"/><w:sz w:val="48"/><w:szCs w:val="48"/>')
}${style('Subtitle', 'Subtitle', 'Normal', 'Normal', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="240"/>', '<w:color w:val="6B7280"/>')
}${style('Heading1', 'heading 1', 'Normal', 'Normal', '<w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="60"/><w:outlineLvl w:val="0"/>', '<w:b/><w:color w:val="1F2937"/><w:sz w:val="28"/><w:szCs w:val="28"/>')
}${style('Source', 'Source', 'Normal', 'Normal', '<w:keepNext/><w:spacing w:after="80"/>', '<w:color w:val="6B7280"/><w:sz w:val="17"/><w:szCs w:val="17"/>')
}${style('Notes', 'Notes', 'Normal', 'Normal', '<w:spacing w:after="100"/>', '')
}${style('Screenshot', 'Screenshot', 'Normal', 'Normal', '<w:spacing w:before="40" w:after="120" w:line="240" w:lineRule="auto"/>', '')
}${style('Footer', 'footer', 'Normal', '', '<w:spacing w:after="0"/><w:jc w:val="right"/>', '<w:color w:val="6B7280"/><w:sz w:val="17"/><w:szCs w:val="17"/>')
}</w:styles>`;

function coreProps(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>QAssistant</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

export function stepTitle(step, index) {
  return (step.title || '').trim() || `Step ${index + 1}`;
}

export async function buildDocx(meta, steps, onProgress = () => {}) {
  const title = meta.title.trim() || 'Test document';
  const count = `${steps.length} screenshot${steps.length === 1 ? '' : 's'}`;
  const today = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
  const body = [paragraph('Title', title), paragraph('Subtitle', `${today} · ${count}`)];
  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
  ];
  const media = [];

  for (let i = 0; i < steps.length; i++) {
    onProgress(i + 1, steps.length);
    const step = steps[i];
    const heading = stepTitle(step, i);
    const notes = (step.notes || '').trim();
    body.push(paragraph('Heading1', heading));
    if (meta.includeSource) {
      const source = [formatDate(step.capturedAt), step.url].filter(Boolean).join(' · ');
      body.push(paragraph('Source', source));
    }
    if (notes) body.push(notesParagraph(notes, notes.length < 400));

    const room = roomOnFirstPage(step, meta) - (i === 0 ? TITLE_BLOCK : 0);
    const images = await imagesForStep(step, meta, room);
    images.forEach((image, part) => {
      const number = media.length + 1;
      const rId = `rId${number + 2}`;
      const file = `image${number}.png`;
      media.push({ name: `word/media/${file}`, data: image.bytes });
      rels.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${file}"/>`);
      const alt = images.length > 1 ? `${heading} (part ${part + 1} of ${images.length})` : heading;
      body.push(picture({ ...image, rId }, number, alt));
    });
  }

  const section = `<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/><w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>`;

  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'docProps/core.xml', data: coreProps(title) },
    { name: 'word/document.xml', data: `${XML}<w:document ${NAMESPACES}><w:body>${body.join('')}${section}</w:body></w:document>` },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/footer1.xml', data: FOOTER },
    { name: 'word/_rels/document.xml.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` },
    ...media,
  ]);
}

export function docxFilename(title) {
  const safe = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${safe || 'Test document'}.docx`;
}
