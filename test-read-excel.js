import ExcelJS from 'exceljs';
import fs from 'fs';

try {
  console.log('Tentativo di lettura del file 4945.xlsx...');
  
  // Leggi il file come buffer
  const fileBuffer = fs.readFileSync('../4945.xlsx');
  
  // Prova a leggere con ExcelJS
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);
  
  console.log('\n=== Metodo 1: ExcelJS ===');
  console.log('Fogli disponibili:', workbook.worksheets.map(ws => ws.name));
  
  for (const worksheet of workbook.worksheets) {
    console.log(`\n--- Foglio: ${worksheet.name} ---`);
    console.log('Numero di righe:', worksheet.rowCount);
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= 3) {
        const values = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const colLetter = String.fromCharCode(64 + colNumber);
          values[colLetter] = cell.value;
        });
        rows.push(values);
      }
    });
    console.log('Prime 3 righe:', JSON.stringify(rows, null, 2));
  }
  
  // Prova con il mappaggio colonne (foglio "Lista Movimenti")
  console.log('\n\n=== Metodo 2: Foglio "Lista Movimenti" con mapping colonne ===');
  const ws = workbook.getWorksheet('Lista Movimenti');
  
  if (ws) {
    console.log('Righe in "Lista Movimenti":', ws.rowCount);
    const mappedRows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= 5) {
        mappedRows.push({
          date: row.getCell(1).value,
          description: row.getCell(2).value,
          negativeAmount: row.getCell(3).value,
          positiveAmount: row.getCell(4).value,
        });
      }
    });
    console.log('Prime 5 righe:', JSON.stringify(mappedRows, null, 2));
  } else {
    console.log('⚠️ Il foglio "Lista Movimenti" non è stato trovato!');
    console.log('Fogli disponibili nel file:', workbook.worksheets.map(ws => ws.name));
  }
  
} catch (error) {
  console.error('❌ Errore:', error.message);
  console.error('Stack:', error.stack);
}
