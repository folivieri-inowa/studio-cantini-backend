// Script per creare facilmente nuove migrazioni
// Uso: node create-migration.js "nome_della_migrazione"

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Verifica che sia stato fornito un nome per la migrazione
if (process.argv.length < 3) {
  console.error('❌ Errore: Devi specificare un nome per la migrazione');
  console.log('Uso: node create-migration.js "nome_della_migrazione"');
  process.exit(1);
}

// Prendi il nome della migrazione dagli argomenti
const migrationName = process.argv[2].trim();

// Crea la struttura del nome file con timestamp
const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const migrationsDir = path.join(__dirname, 'migrations');

// Assicurati che la directory delle migrazioni esista
try {
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
    console.log(`✅ Creata directory delle migrazioni: ${migrationsDir}`);
  }
} catch (err) {
  console.error('❌ Errore durante la creazione della directory delle migrazioni:', err);
  process.exit(1);
}

// Leggi i file esistenti per determinare il numero di sequenza
let files;
try {
  files = fs.readdirSync(migrationsDir);
} catch (err) {
  console.error('❌ Errore durante la lettura della directory delle migrazioni:', err);
  process.exit(1);
}

// Filtra i file per la data corrente
const todayFiles = files.filter(file => file.startsWith(timestamp));
const sequence = (todayFiles.length + 1).toString().padStart(3, '0');

// Crea il nome del file
const safeFileName = migrationName.toLowerCase().replace(/[^a-z0-9]/g, '_');
const fileName = `${timestamp}_${sequence}_${safeFileName}.sql`;
const filePath = path.join(migrationsDir, fileName);

// Template per la migrazione
const template = `-- Migration: ${migrationName}
-- Created at: ${new Date().toISOString()}

-- Descrizione:
-- Aggiungi qui una descrizione dettagliata di cosa fa questa migrazione

-- Per aggiungere una tabella:
-- CREATE TABLE IF NOT EXISTS nome_tabella (
--   id SERIAL PRIMARY KEY,
--   campo1 VARCHAR(255) NOT NULL,
--   campo2 INTEGER,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- Per modificare una tabella esistente:
-- ALTER TABLE nome_tabella 
-- ADD COLUMN IF NOT EXISTS nome_colonna TIPO_DATO;

-- Per aggiungere una relazione:
-- ALTER TABLE nome_tabella
-- ADD CONSTRAINT fk_nome_relazione
-- FOREIGN KEY (campo_foreign_key)
-- REFERENCES tabella_riferimento(id)
-- ON DELETE SET NULL;
`;

// Scrivi il file
try {
  fs.writeFileSync(filePath, template, 'utf8');
  console.log(`✅ Creato nuovo file di migrazione: ${fileName}`);
  console.log(`📝 Path: ${filePath}`);
} catch (err) {
  console.error('❌ Errore durante la scrittura del file di migrazione:', err);
  process.exit(1);
}
