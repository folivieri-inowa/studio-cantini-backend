import excelToJson from 'convert-excel-to-json';
import fs from 'fs';

try {
  console.log('Tentativo di lettura del file 4945.xlsx...');
  
  // Leggi il file come buffer
  const fileBuffer = fs.readFileSync('../4945.xlsx');
  
  // Prova a leggere con il metodo standard
  const result1 = excelToJson({
    sourceFile: '../4945.xlsx'
  });
  
  console.log('\n=== Metodo 1: sourceFile ===');
  console.log('Fogli disponibili:', Object.keys(result1));
  
  for (const sheetName of Object.keys(result1)) {
    console.log(`\n--- Foglio: ${sheetName} ---`);
    console.log('Numero di righe:', result1[sheetName].length);
    console.log('Prime 3 righe:', JSON.stringify(result1[sheetName].slice(0, 3), null, 2));
  }
  
  // Prova con il metodo usato dall'applicazione
  console.log('\n\n=== Metodo 2: source (buffer) con mapping colonne ===');
  const result2 = excelToJson({
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
  
  console.log('Fogli disponibili:', Object.keys(result2));
  
  if (result2['Lista Movimenti']) {
    console.log('Righe in "Lista Movimenti":', result2['Lista Movimenti'].length);
    console.log('Prime 5 righe:', JSON.stringify(result2['Lista Movimenti'].slice(0, 5), null, 2));
  } else {
    console.log('⚠️ Il foglio "Lista Movimenti" non è stato trovato!');
    console.log('Fogli disponibili nel file:', Object.keys(result1));
  }
  
} catch (error) {
  console.error('❌ Errore:', error.message);
  console.error('Stack:', error.stack);
}
