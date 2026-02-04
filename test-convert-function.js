import { ConvertExcelToJson } from './lib/utils.js';
import fs from 'fs';

try {
  console.log('Test della funzione ConvertExcelToJson aggiornata...\n');
  
  // Leggi il file come buffer
  const fileBuffer = fs.readFileSync('../4945.xlsx');
  
  // Usa la funzione aggiornata
  const movements = ConvertExcelToJson(fileBuffer);
  
  console.log('\n=== Risultati ===');
  console.log('Numero totale di movimenti:', movements.length);
  console.log('\nPrimi 5 movimenti:');
  movements.slice(0, 5).forEach((mov, idx) => {
    console.log(`\n${idx + 1}.`);
    console.log('  Data:', mov.date);
    console.log('  Descrizione:', mov.description);
    console.log('  Importo negativo:', mov.negativeAmount);
    console.log('  Importo positivo:', mov.positiveAmount);
  });
  
} catch (error) {
  console.error('❌ Errore:', error.message);
  console.error('Stack:', error.stack);
}
