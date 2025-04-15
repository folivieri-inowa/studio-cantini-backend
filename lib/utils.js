import excelToJson from 'convert-excel-to-json';
import { DateTime } from 'luxon';

export async function checkUserLogin(fastify, header) {
  try {
    const token = header.split(' ')[1]; // recuperare il token dalla richiesta
    const decoded = await fastify.jwt.verify(token); // decodificare il token
    const userId = decoded.id; // recuperare l'id del cliente dal payload del token

    // Fetch the user from the PostgreSQL database
    const query = 'SELECT id, email, firstName, lastName FROM users WHERE id = $1';
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

export function ConvertExcelToJson(fileBuffer) {
  const rawData = excelToJson({
    source: fileBuffer,
    sheets: [{
      header: { rows: 0 },
      name: 'Lista Movimenti',
      columnToKey: {
        A: 'date',
        B: 'description',
        C: 'negativeAmount',
        D: 'positiveAmount',
      }
    }]
  });

  const rows = rawData['Lista Movimenti'] || [];
  const movements = [];
  let lastValidRow = null;

  for (const row of rows) {
    if (row.date) {
      let amount
      if (row.negativeAmount){
        if (typeof row.negativeAmount === 'string') {
          console.log("Row negativeAmount:", row.negativeAmount);
          amount = isNaN(parseFloat(String(row.negativeAmount).replace(/\./g, '').replace(',', '.'))) ? 0 : parseFloat(String(row.negativeAmount).replace(/\./g, '').replace(',', '.'))
          console.log("Parsed negativeAmount:", amount);
        }else {
          amount = row.negativeAmount
        }
      }
      if (row.positiveAmount) {
        if (typeof row.positiveAmount === 'string') {
          console.log("Row positiveAmount:", row.positiveAmount);
          amount = isNaN(parseFloat(String(row.positiveAmount).replace(/\./g, '').replace(',', '.'))) ? 0 : parseFloat(String(row.positiveAmount).replace(/\./g, '').replace(',', '.'))
          console.log("Parsed positiveAmount:", amount);
        }else{
          amount = row.positiveAmount
        }
      }
      // Nuova riga con data → crea un nuovo movimento
      lastValidRow = {
        date: row.date,
        description: row.description ? row.description.trim() : '',
        negativeAmount: row.negativeAmount ? amount : null,
        positiveAmount: row.positiveAmount ? amount : null,
      };
      movements.push(lastValidRow);
    } else if (lastValidRow) {
      // Riga senza data → aggiungi testo alla descrizione dell'ultimo movimento valido
      lastValidRow.description += ' ' + (row.description ? row.description.trim() : '');
    }
  }
  return movements;
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