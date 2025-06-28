/**
 * Script per ripulire il progetto dopo l'importazione dei dati
 * Mantiene solo i file essenziali e archivia quelli temporanei
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Ottieni il percorso corrente
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory di archivio per i file temporanei
const archiveDir = path.join(__dirname, 'archive');

// Crea la directory di archivio se non esiste
if (!fs.existsSync(archiveDir)) {
  console.log(`✨ Creazione directory di archivio: ${archiveDir}`);
  fs.mkdirSync(archiveDir);
}

// File da mantenere (non spostare in archivio)
const filesToKeep = [
  // File principali
  'index.js',
  'package.json',
  'runMigrations.js',
  'Dockerfile',
  'import-csv-to-studio-cantini.js', // Script principale di importazione
  'clean-project.js', // Questo script
  
  // Migrazioni e lib
  'lib',
  'migrations',
  'routes',
  'ml',
  '.env'
];

// Funzione per determinare se un file/directory deve essere mantenuto
function shouldKeep(item) {
  if (filesToKeep.includes(item)) return true;
  if (item.startsWith('.')) return true; // Mantieni file nascosti (.gitignore, ecc.)
  if (item === 'node_modules') return true;
  if (item === 'archive') return true;
  return false;
}

// Funzione per spostare i file in archivio
function archiveFile(filePath) {
  const fileName = path.basename(filePath);
  const destPath = path.join(archiveDir, fileName);
  
  try {
    // Se il file di destinazione esiste già, aggiungi un suffisso
    if (fs.existsSync(destPath)) {
      const fileExt = path.extname(fileName);
      const fileBase = path.basename(fileName, fileExt);
      const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
      const newDestPath = path.join(archiveDir, `${fileBase}_${timestamp}${fileExt}`);
      fs.renameSync(filePath, newDestPath);
      console.log(`🔄 File spostato in archivio (rinominato): ${fileName} -> ${path.basename(newDestPath)}`);
    } else {
      fs.renameSync(filePath, destPath);
      console.log(`🔄 File spostato in archivio: ${fileName}`);
    }
  } catch (err) {
    console.error(`❌ Errore durante lo spostamento del file ${fileName}: ${err.message}`);
  }
}

// Leggi tutti i file nella directory backend
console.log('🔍 Scansione dei file nella directory backend...');
const items = fs.readdirSync(__dirname, { withFileTypes: true });

let archivedCount = 0;
let keptCount = 0;

// Processa ogni elemento
items.forEach(item => {
  const itemName = item.name;
  const itemPath = path.join(__dirname, itemName);
  
  // Controlla se il file/directory deve essere mantenuto
  if (shouldKeep(itemName)) {
    console.log(`✅ Mantenuto: ${itemName}`);
    keptCount++;
  } else {
    // Se è un file, spostalo nell'archivio
    if (item.isFile()) {
      archiveFile(itemPath);
      archivedCount++;
    } 
    // Nota: non archiviamo directory per semplicità e sicurezza
  }
});

console.log(`\n📊 Riepilogo pulizia:`);
console.log(`- File mantenuti: ${keptCount}`);
console.log(`- File archiviati: ${archivedCount}`);
console.log(`\n🎉 Pulizia completata! I file temporanei sono stati spostati in ${archiveDir}`);
console.log(`Per eliminare completamente i file archiviati, esegui: rm -rf ${archiveDir}`);
