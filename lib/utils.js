import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { DateTime } from 'luxon';

export async function checkUserLogin(fastify, header) {
  try {
    const token = header.split(' ')[1]; // recuperare il token dalla richiesta
    const decoded = await fastify.jwt.verify(token); // decodificare il token
    const userId = decoded.id; // recuperare l'id del cliente dal payload del token

    // Fetch the user from the PostgreSQL database
    const query = 'SELECT id, email, firstname, lastname, dbrole FROM users WHERE id = $1';
    const { rows } = await fastify.pg.query(query, [userId]);

    if (rows.length === 0) {
      return { message: 'User not found' };
    }

    return rows[0];
  }catch(err) {
    console.error(err);
    return { message: 'Invalid token' };
  }
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const str = value.trim();

    // Formato italiano con separatore migliaia (punto) e decimale (virgola)
    // es. "-1.234,56" oppure "1.234,00"
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) {
      const cleaned = str.replace(/\./g, '').replace(',', '.');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }

    // Formato con solo virgola decimale, senza punti migliaia
    // es. "-32,49" oppure "100,00"
    if (/^-?\d+(,\d+)?$/.test(str)) {
      const cleaned = str.replace(',', '.');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }

    // Formato standard con punto decimale: "-32.49"
    const parsed = parseFloat(str);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export async function ConvertExcelToJson(fileBuffer) {
  console.log('🔍 ConvertExcelToJson - Buffer info:', {
    length: fileBuffer.length,
    isBuffer: Buffer.isBuffer(fileBuffer),
    type: typeof fileBuffer
  });
  
  let workbook;
  
  try {
    // Usa xlsx (SheetJS) che supporta sia .xls che .xlsx
    workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    console.log('✅ Workbook caricato, fogli trovati:', workbook.SheetNames.length);
    console.log('📋 Nomi fogli:', workbook.SheetNames);
  } catch (error) {
    console.error('❌ Errore caricamento workbook:', error.message);
    throw error;
  }

  // Cerca il foglio "Lista Movimenti"
  const sheetName = workbook.SheetNames.find(name => name === 'Lista Movimenti');
  if (!sheetName) {
    console.error('❌ Foglio "Lista Movimenti" non trovato. Fogli disponibili:', workbook.SheetNames);
    
    // Fallback: usa il primo foglio disponibile se esiste
    if (workbook.SheetNames.length > 0) {
      const firstSheet = workbook.SheetNames[0];
      console.log('ℹ️ Utilizzo il primo foglio disponibile:', firstSheet);
      const worksheet = workbook.Sheets[firstSheet];
      return processWorksheet(worksheet);
    }
    
    return [];
  }
  
  const worksheet = workbook.Sheets[sheetName];
  return processWorksheet(worksheet);
}

function processWorksheet(worksheet) {
  // Converti il foglio in una matrice di righe
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  const rawRows = [];

  for (let rowNum = range.s.r; rowNum <= range.e.r; rowNum++) {
    const rowData = {};

    // Leggi le prime 4 colonne (A, B, C, D)
    for (let colNum = 0; colNum < 4; colNum++) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowNum, c: colNum });
      const cell = worksheet[cellAddress];
      const colLetter = String.fromCharCode(65 + colNum); // A, B, C, D
      rowData[colLetter] = cell ? getCellValue(cell) : null;
    }

    rawRows.push(rowData);
  }

  console.log('📊 Righe lette:', rawRows.length);

  // Determina il formato:
  // - "alternate": A vuota, B=data, C=descrizione, D=importo con segno (es. estratto conto banca)
  // - "single":    A=data, B=descrizione, C=importo con segno, D=null (colonna unica)
  // - "standard":  A=data, B=descrizione, C=dare, D=avere (due colonne separate)
  let format = 'standard';
  if (rawRows.length > 0) {
    const firstRow = rawRows[0];

    // Formato alternativo: A è vuota, B contiene la data
    if (!firstRow.A && firstRow.B && typeof firstRow.B === 'string' &&
        (/\d{2}\/\d{2}\/\d{4}/.test(firstRow.B) || /\d{1,2}\s+\w+\s+\d{4}/.test(firstRow.B))) {
      console.log('📋 Rilevato formato alternativo (B=data, C=descrizione, D=importo)');
      format = 'alternate';
    } else {
      // Campiona tutte le righe con data per capire se D è sempre vuota
      const sampleRows = rawRows.filter(r => r.A);
      const hasAnyD = sampleRows.some(r => r.D !== null && r.D !== '' && r.D !== 0);
      if (!hasAnyD && sampleRows.length > 0) {
        console.log('📋 Rilevato formato colonna singola (A=data, B=descrizione, C=importo con segno)');
        format = 'single';
      } else {
        console.log('📋 Rilevato formato standard (A=data, B=descrizione, C=dare, D=avere)');
      }
    }
  }

  const movements = [];
  let lastValidRow = null;

  for (const raw of rawRows) {
    const dateField = format === 'alternate' ? raw.B : raw.A;
    const description = format === 'alternate' ? raw.C : raw.B;

    if (dateField) {
      let negativeAmount = null;
      let positiveAmount = null;

      if (format === 'alternate' || format === 'single') {
        // Colonna importo con segno: negativo=uscita, positivo=entrata
        const amountCol = format === 'alternate' ? raw.D : raw.C;
        const amount = parseAmount(amountCol);
        if (amount !== null && amount !== 0) {
          if (amount < 0) negativeAmount = amount;
          else positiveAmount = amount;
        }
      } else {
        // standard: C=dare (uscita), D=avere (entrata)
        if (raw.C !== null && raw.C !== '') negativeAmount = parseAmount(raw.C);
        if (raw.D !== null && raw.D !== '') positiveAmount = parseAmount(raw.D);
      }

      lastValidRow = {
        date: dateField,
        description: description ? String(description).trim() : '',
        negativeAmount,
        positiveAmount,
      };
      movements.push(lastValidRow);
    } else if (lastValidRow) {
      // Riga senza data → aggiungi testo alla descrizione dell'ultimo movimento valido
      lastValidRow.description += ' ' + (description ? String(description).trim() : '');
    }
  }

  console.log(`✅ Estratti ${movements.length} movimenti dal file`);
  return movements;
}

function getCellValue(cell) {
  if (!cell) return null;

  // Gestisci i diversi tipi di cella
  if (cell.t === 's') return cell.v; // stringa
  if (cell.t === 'n') {
    // Se la cella è una data (cell.w contiene "/" come in "01/03/2026"),
    // restituiamo la stringa formattata invece del numero seriale Excel.
    // Altrimenti per gli importi restituiamo cell.v (numero float grezzo),
    // perché cell.w avrebbe separatori localizzati (es. "-1,255.00") che
    // causerebbero errori in parseAmount.
    if (cell.w && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(cell.w)) {
      return cell.w;
    }
    return cell.v;
  }
  if (cell.t === 'b') return cell.v; // booleano
  if (cell.t === 'd') return cell.v; // data
  if (cell.w) return cell.w; // valore formattato

  return cell.v;
}

export function detectPaymentMethod(description) {
  if (!description) return "Sconosciuto";

  const lowerDesc = description.toLowerCase().replace(/[^a-z0-9]/g, " ");

  if (lowerDesc.includes("pos")) return "POS"; // Cerca "POS" come parte della stringa
  if (lowerDesc.includes("disposizione") || lowerDesc.includes("bonif") || lowerDesc.includes("bonifico") || lowerDesc.includes("giroconto")) return "Bonifico";
  if (lowerDesc.includes("f24")) return "F24";
  if (lowerDesc.includes("cbill")) return "Cbill";
  if (lowerDesc.includes("paypal")) return "PayPal";
  if (lowerDesc.includes("sepa")) return "Addebito Diretto SEPA";
  if (lowerDesc.includes("nexi")) return "Carte di Credito";

  return "Altro";
}

export function parseDate(dateString) {
  if (!dateString) {
    console.error("Invalid input for parseDate:", dateString);
    return null;
  }

  // Se l'input è un oggetto Date, convertilo in stringa ISO
  if (dateString instanceof Date) {
    dateString = dateString.toISOString();
  }

  // Assicurati che l'input sia una stringa
  if (typeof dateString !== 'string') {
    console.error("Invalid input for parseDate (not a string):", dateString);
    return null;
  }

  // Gestione del formato ISO 8601 (es. "2024-06-19T22:00:00.000Z")
  if (DateTime.fromISO(dateString).isValid) {
    return DateTime.fromISO(dateString).toFormat('yyyy-MM-dd');
  }

  // Formato testuale italiano (es. "27 febbraio 2026", "1 marzo 2025")
  const italianMonths = {
    gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
    luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12
  };
  const italianMatch = dateString.trim().match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
  if (italianMatch) {
    const day = parseInt(italianMatch[1], 10);
    const monthName = italianMatch[2].toLowerCase();
    const year = parseInt(italianMatch[3], 10);
    const month = italianMonths[monthName];
    if (month) {
      const d = DateTime.fromObject({ year, month, day });
      if (d.isValid) return d.toFormat('yyyy-MM-dd');
    }
  }

  // Rimuovi l'ora se presente (es. "20/06/2024 00:00:00" → "20/06/2024")
  dateString = dateString.split(' ')[0];

  // Prova il formato europeo (es. 19/06/2024 o 8/11/2025)
  let date = DateTime.fromFormat(dateString, 'dd/MM/yyyy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  date = DateTime.fromFormat(dateString, 'd/MM/yyyy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  date = DateTime.fromFormat(dateString, 'd/M/yyyy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  // Prova formati con anno a 2 cifre (es. 13/11/25, 8/11/25)
  date = DateTime.fromFormat(dateString, 'dd/MM/yy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  date = DateTime.fromFormat(dateString, 'd/MM/yy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  date = DateTime.fromFormat(dateString, 'd/M/yy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  // Prova il formato americano (es. 06/19/2024)
  date = DateTime.fromFormat(dateString, 'MM/dd/yyyy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  // Prova senza separatori (es. 19062024)
  date = DateTime.fromFormat(dateString, 'ddMMyyyy');
  if (date.isValid) return date.toFormat('yyyy-MM-dd');

  // Se nessun formato funziona, restituisci null
  console.error("❌ Data non valida:", dateString);
  return null;
}

export function sanitizeFileName(filename) {
  // Sostituisce gli spazi con _
  let sanitized = filename.replace(/\s+/g, '_');
  // Rimuove tutti i caratteri speciali eccetto _
  sanitized = sanitized.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  return sanitized;
}