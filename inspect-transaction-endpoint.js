// Script per verificare la struttura attuale del file transaction.js
import fs from 'fs';
import path from 'path';

const filePath = '/Users/francescoolivieri/Desktop/Sviluppo inowa/studio_cantini/backend/routes/transaction.js';

// Legge il contenuto del file
const fileContent = fs.readFileSync(filePath, 'utf8');

// Cerca l'endpoint specifico che ci interessa
const endpointMarker = "fastify.post('/import/associated'";
const endpointStartIndex = fileContent.indexOf(endpointMarker);

if (endpointStartIndex === -1) {
  console.error('Endpoint non trovato!');
  process.exit(1);
}

// Trova la funzione completa
let braceCount = 0;
let endpointEndIndex = endpointStartIndex;

// Cerca il punto di inizio della funzione dopo il marker
const functionStartIndex = fileContent.indexOf('{', endpointStartIndex);

// Inizia a contare le parentesi graffe per trovare la fine della funzione
for (let i = functionStartIndex; i < fileContent.length; i++) {
  if (fileContent[i] === '{') {
    braceCount++;
  } else if (fileContent[i] === '}') {
    braceCount--;
    if (braceCount === 0) {
      endpointEndIndex = i + 1;
      break;
    }
  }
}

// Estrai la funzione completa
const endpointFunction = fileContent.substring(endpointStartIndex, endpointEndIndex);

// Salva in un file temporaneo per l'ispezione
fs.writeFileSync('endpoint-function.js', endpointFunction);

console.log('Funzione estratta e salvata in endpoint-function.js');

// Analizza anche solo la parte della risposta
const replyMarker = "console.log('✅ Importazione associativa completata con successo!'";
const replyStartIndex = endpointFunction.indexOf(replyMarker);

if (replyStartIndex === -1) {
  console.error('Parte della risposta non trovata!');
  process.exit(1);
}

// Estrai solo la parte della risposta
const responseSection = endpointFunction.substring(replyStartIndex, endpointFunction.indexOf('} catch (err) {', replyStartIndex));

fs.writeFileSync('response-section.js', responseSection);

console.log('Sezione della risposta estratta e salvata in response-section.js');
