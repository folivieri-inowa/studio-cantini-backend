// Script per validare tutte le migrazioni prima dell'applicazione
// Controlla la sintassi SQL e la coerenza dei file di migrazione

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica le variabili d'ambiente
dotenv.config();

// Inizializza Fastify
const fastify = Fastify({ logger: false });

// Configura la connessione al database
fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

/**
 * Valida un singolo file di migrazione
 * @param {string} filePath - Percorso del file di migrazione
 * @param {string} fileName - Nome del file
 * @returns {Object} Risultato della validazione
 */
function validateMigrationFile(filePath, fileName) {
  const result = {
    fileName,
    valid: true,
    errors: [],
    warnings: []
  };

  try {
    // Verifica che il file esista
    if (!fs.existsSync(filePath)) {
      result.valid = false;
      result.errors.push('File non trovato');
      return result;
    }

    // Verifica il formato del nome del file
    const namePattern = /^\d{8}_\d{3}_[a-zA-Z0-9_]+\.sql$/;
    if (!namePattern.test(fileName)) {
      result.valid = false;
      result.errors.push('Il nome del file non rispetta il formato: YYYYMMDD_NNN_description.sql');
    }

    // Leggi il contenuto del file
    const content = fs.readFileSync(filePath, 'utf8');

    // Verifica che il file non sia vuoto
    if (!content.trim()) {
      result.valid = false;
      result.errors.push('Il file è vuoto');
      return result;
    }

    // Verifica la presenza di caratteri non validi
    if (content.includes('\0')) {
      result.valid = false;
      result.errors.push('Il file contiene caratteri null');
    }

    // Verifica la codifica (controllo basic)
    try {
      const decoded = Buffer.from(content, 'utf8').toString('utf8');
      if (decoded !== content) {
        result.warnings.push('Possibili problemi di codifica del file');
      }
    } catch (e) {
      result.warnings.push('Impossibile verificare la codifica del file');
    }

    // Controlli specifici per SQL
    const lowerContent = content.toLowerCase();

    // Verifica la presenza di comandi potenzialmente pericolosi
    const dangerousCommands = [
      'drop database',
      'drop schema',
      'truncate table',
      'delete from users',
      'delete from migrations'
    ];

    for (const cmd of dangerousCommands) {
      if (lowerContent.includes(cmd)) {
        result.warnings.push(`Comando potenzialmente pericoloso rilevato: ${cmd}`);
      }
    }

    // Verifica la presenza di transazioni esplicite (non dovrebbero esserci)
    if (lowerContent.includes('begin;') || lowerContent.includes('commit;') || lowerContent.includes('rollback;')) {
      result.warnings.push('La migrazione contiene comandi di transazione espliciti (BEGIN/COMMIT/ROLLBACK). Le transazioni sono gestite automaticamente.');
    }

    // Controllo della sintassi di base
    const statements = content.split(';').filter(stmt => stmt.trim());
    if (statements.length === 0) {
      result.warnings.push('Nessun statement SQL valido trovato');
    }

    // Verifica che ci siano statement SQL validi
    const validSqlPattern = /\b(create|alter|insert|update|delete|drop|grant|revoke)\b/i;
    const hasValidSql = statements.some(stmt => validSqlPattern.test(stmt.trim()));
    
    if (!hasValidSql) {
      result.warnings.push('Nessun statement SQL riconosciuto trovato');
    }

  } catch (error) {
    result.valid = false;
    result.errors.push(`Errore durante la lettura del file: ${error.message}`);
  }

  return result;
}

/**
 * Valida tutte le migrazioni
 */
async function validateMigrations() {
  try {
    console.log('🔍 Avvio validazione delle migrazioni...\n');

    // Leggi la directory delle migrazioni
    const migrationsDir = path.join(__dirname, 'migrations');
    
    if (!fs.existsSync(migrationsDir)) {
      console.error('❌ Directory migrations non trovata:', migrationsDir);
      process.exit(1);
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('⚠️  Nessun file di migrazione trovato');
      return;
    }

    console.log(`📂 Trovati ${files.length} file di migrazione da validare\n`);

    let totalErrors = 0;
    let totalWarnings = 0;
    const results = [];

    // Valida ogni file
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const result = validateMigrationFile(filePath, file);
      results.push(result);

      if (!result.valid) {
        console.log(`❌ ${file}`);
        result.errors.forEach(error => {
          console.log(`   ❌ Errore: ${error}`);
          totalErrors++;
        });
      } else {
        console.log(`✅ ${file}`);
      }

      if (result.warnings.length > 0) {
        result.warnings.forEach(warning => {
          console.log(`   ⚠️  Avviso: ${warning}`);
          totalWarnings++;
        });
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`📊 Risultati della validazione:`);
    console.log(`   ✅ File validi: ${results.filter(r => r.valid).length}/${files.length}`);
    console.log(`   ❌ Errori totali: ${totalErrors}`);
    console.log(`   ⚠️  Avvisi totali: ${totalWarnings}`);

    // Controllo della sequenza temporale
    console.log('\n🕐 Verifica della sequenza temporale...');
    let previousDate = '';
    let sequenceErrors = 0;

    for (const file of files) {
      const dateMatch = file.match(/^(\d{8})/);
      if (dateMatch) {
        const currentDate = dateMatch[1];
        if (previousDate && currentDate < previousDate) {
          console.log(`❌ Errore di sequenza: ${file} ha una data precedente al file precedente`);
          sequenceErrors++;
        }
        previousDate = currentDate;
      }
    }

    if (sequenceErrors === 0) {
      console.log('✅ Sequenza temporale corretta');
    } else {
      console.log(`❌ ${sequenceErrors} errori di sequenza temporale trovati`);
      totalErrors += sequenceErrors;
    }

    // Test di connessione al database
    console.log('\n🔗 Test di connessione al database...');
    try {
      await fastify.ready();
      await fastify.pg.query('SELECT 1');
      console.log('✅ Connessione al database riuscita');
    } catch (error) {
      console.log(`❌ Errore di connessione al database: ${error.message}`);
      console.log('💡 Le migrazioni potrebbero fallire se il database non è accessibile');
      totalWarnings++;
    }

    console.log('\n' + '='.repeat(70));

    if (totalErrors > 0) {
      console.log('❌ VALIDAZIONE FALLITA');
      console.log(`   Trovati ${totalErrors} errori che devono essere corretti prima di applicare le migrazioni`);
      process.exit(1);
    } else {
      console.log('✅ VALIDAZIONE COMPLETATA CON SUCCESSO');
      if (totalWarnings > 0) {
        console.log(`   ${totalWarnings} avvisi trovati, ma le migrazioni possono essere applicate`);
      }
      console.log('🚀 Le migrazioni sono pronte per essere applicate');
    }

  } catch (error) {
    console.error('❌ Errore durante la validazione:', error);
    process.exit(1);
  } finally {
    await fastify.close();
  }
}

// Avvia la validazione
validateMigrations();
