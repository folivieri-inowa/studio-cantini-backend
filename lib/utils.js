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
    const cleaned = String(value).replace(/\./g, '').replace(',', '.');
    const parsed = parseFloat(cleaned);
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
  
  // Determina il formato: standard (A,B,C,D) o alternativo (B,C,D)
  let useAlternateFormat = false;
  if (rawRows.length > 0) {
    const firstRow = rawRows[0];
    if (!firstRow.A && firstRow.B && typeof firstRow.B === 'string' && /\d{2}\/\d{2}\/\d{4}/.test(firstRow.B)) {
      console.log('📋 Rilevato formato alternativo (colonne B, C, D)');
      useAlternateFormat = true;
    }
  }

  const movements = [];
  let lastValidRow = null;

  for (const raw of rawRows) {
    const dateField = useAlternateFormat ? raw.B : raw.A;
    const description = useAlternateFormat ? raw.C : raw.B;

    if (dateField) {
      let amount;

      if (useAlternateFormat) {
        amount = parseAmount(raw.D);
      } else {
        if (raw.C) amount = parseAmount(raw.C);
        if (raw.D) amount = parseAmount(raw.D);
      }

      lastValidRow = {
        date: dateField,
        description: description ? String(description).trim() : '',
        negativeAmount: useAlternateFormat ? (amount < 0 ? amount : null) : (raw.C ? parseAmount(raw.C) : null),
        positiveAmount: useAlternateFormat ? (amount > 0 ? amount : null) : (raw.D ? parseAmount(raw.D) : null),
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
  if (cell.t === 'n') return cell.v; // numero
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

  // Rimuovi l'ora se presente (es. "20/06/2024 00:00:00" → "20/06/2024")
  dateString = dateString.split(' ')[0];

  // Prova il formato europeo (es. 19/06/2024)
  let date = DateTime.fromFormat(dateString, 'dd/MM/yyyy');
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