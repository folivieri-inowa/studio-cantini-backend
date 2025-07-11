/**
 * Sistema di migrazione del database
 * 
 * Questo script esegue automaticamente tutte le migrazioni nella directory delle migrazioni
 * in modo sequenziale e tiene traccia delle migrazioni già eseguite.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Esegue le migrazioni del database
 * @param {Object} fastify - Istanza di Fastify
 */
export async function runMigrations(fastify) {
  try {
    console.log('🔄 Inizio verifica e applicazione delle migrazioni...');
    
    // Verifica la connessione al database prima di procedere
    console.log('🔗 Verifica della connessione al database...');
    try {
      await fastify.pg.query('SELECT 1');
      console.log('✅ Connessione al database verificata');
    } catch (dbError) {
      console.error('❌ Errore di connessione al database:', dbError.message);
      throw new Error(`Impossibile connettersi al database: ${dbError.message}`);
    }
    
    // Verifica se esiste la tabella delle migrazioni
    await ensureMigrationsTableExists(fastify);
    
    // Leggi la directory delle migrazioni
    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Ordina alfabeticamente per assicurare l'ordine di esecuzione
    
    console.log(`📂 Trovate ${files.length} migrazioni nella directory: ${migrationsDir}`);
    
    // Recupera le migrazioni già eseguite
    const { rows } = await fastify.pg.query('SELECT migration_name FROM migrations');
    const executedMigrations = new Set(rows.map(row => row.migration_name));
    
    console.log(`✅ ${executedMigrations.size} migrazioni già eseguite`);
    
    // Verifica se la migrazione consolidata è già stata eseguita
    const consolidatedMigrationName = '20250700_001_consolidated_schema.sql';
    const isConsolidatedMigrationExecuted = executedMigrations.has(consolidatedMigrationName);
    
    // Se il database è vuoto (nessuna migrazione eseguita), esegui solo la migrazione consolidata
    const isDatabaseEmpty = executedMigrations.size === 0;
    const consolidatedMigrationExists = files.includes(consolidatedMigrationName);
    
    if (isDatabaseEmpty && consolidatedMigrationExists) {
      console.log('🔄 Database vuoto rilevato e migrazione consolidata disponibile');
      console.log('🔄 Verrà eseguita solo la migrazione consolidata');
      
      // Esegui solo la migrazione consolidata
      const migrationPath = path.join(migrationsDir, consolidatedMigrationName);
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');
      
      const client = await fastify.pg.connect();
      try {
        await client.query('BEGIN');
        
        // Esegui la migrazione
        await client.query(migrationSql);
        
        // Registra l'esecuzione della migrazione consolidata
        await client.query(
          'INSERT INTO migrations (migration_name, executed_at) VALUES ($1, NOW())',
          [consolidatedMigrationName]
        );
        
        // Registra anche tutte le migrazioni precedenti come eseguite
        for (const file of files) {
          if (file < consolidatedMigrationName) {
            await client.query(
              'INSERT INTO migrations (migration_name, executed_at) VALUES ($1, NOW())',
              [file]
            );
            console.log(`🔄 Registrazione automatica della migrazione: ${file}`);
          }
        }
        
        await client.query('COMMIT');
        console.log(`✅ Migrazione consolidata completata: ${consolidatedMigrationName}`);
        
        // Esegui le eventuali migrazioni successive alla consolidata
        for (const file of files) {
          if (file > consolidatedMigrationName && !executedMigrations.has(file)) {
            console.log(`⚙️ Esecuzione migrazione successiva alla consolidata: ${file}`);
            const subMigrationPath = path.join(migrationsDir, file);
            const subMigrationSql = fs.readFileSync(subMigrationPath, 'utf8');
            
            const subClient = await fastify.pg.connect();
            try {
              await subClient.query('BEGIN');
              await subClient.query(subMigrationSql);
              await subClient.query(
                'INSERT INTO migrations (migration_name, executed_at) VALUES ($1, NOW())',
                [file]
              );
              await subClient.query('COMMIT');
              console.log(`✅ Migrazione completata: ${file}`);
            } catch (error) {
              await subClient.query('ROLLBACK');
              console.error(`❌ Errore durante l'esecuzione della migrazione ${file}:`, error);
              throw error;
            } finally {
              subClient.release();
            }
          }
        }
        
        // Esci dalla funzione, non eseguire il ciclo normale delle migrazioni
        return;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`❌ Errore durante l'esecuzione della migrazione consolidata:`, error);
        throw error;
      } finally {
        client.release();
      }
    }
    
    // Esegui le migrazioni mancanti (procedura standard)
    for (const file of files) {
      // Se la migrazione consolidata è stata eseguita, ignora le migrazioni precedenti
      if (isConsolidatedMigrationExecuted && 
          file < consolidatedMigrationName &&
          !executedMigrations.has(file)) {
        console.log(`⏩ Migrazione ignorata (precedente alla consolidata): ${file}`);
        // Registra comunque come eseguita per evitare problemi in futuro
        const client = await fastify.pg.connect();
        try {
          await client.query(
            'INSERT INTO migrations (migration_name, executed_at) VALUES ($1, NOW())',
            [file]
          );
        } catch (error) {
          // Ignora eventuali errori di duplicazione
        } finally {
          client.release();
        }
        continue;
      }
      
      if (!executedMigrations.has(file)) {
        console.log(`⚙️ Esecuzione migrazione: ${file}`);
        
        // Leggi il contenuto della migrazione
        const migrationPath = path.join(migrationsDir, file);
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        
        // Esegui la migrazione all'interno di una transazione
        const client = await fastify.pg.connect();
        try {
          await client.query('BEGIN');
          
          // Esegui la migrazione
          await client.query(migrationSql);
          
          // Registra l'esecuzione della migrazione
          await client.query(
            'INSERT INTO migrations (migration_name, executed_at) VALUES ($1, NOW())',
            [file]
          );
          
          await client.query('COMMIT');
          console.log(`✅ Migrazione completata: ${file}`);
        } catch (error) {
          await client.query('ROLLBACK');
          console.error(`❌ Errore durante l'esecuzione della migrazione ${file}:`, error);
          throw error;
        } finally {
          client.release();
        }
      } else {
        console.log(`⏭️ Migrazione già eseguita: ${file}`);
      }
    }
    
    console.log('✅ Tutte le migrazioni sono state applicate!');
  } catch (error) {
    console.error('❌ Errore durante l\'esecuzione delle migrazioni:', error);
    throw error;
  }
}

/**
 * Assicura che la tabella delle migrazioni esista
 * @param {Object} fastify - Istanza di Fastify
 */
async function ensureMigrationsTableExists(fastify) {
  try {
    // Prima verifica se la tabella esiste
    const checkTableQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'migrations'
      ) as table_exists;
    `;
    
    const { rows } = await fastify.pg.query(checkTableQuery);
    
    if (!rows[0].table_exists) {
      console.log('📋 Creazione della tabella migrations...');
      
      const createTableSql = `
        CREATE TABLE migrations (
          id SERIAL PRIMARY KEY,
          migration_name VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_migrations_name ON migrations(migration_name);
        CREATE INDEX IF NOT EXISTS idx_migrations_executed_at ON migrations(executed_at);
      `;
      
      await fastify.pg.query(createTableSql);
      console.log('✅ Tabella migrations creata con successo');
    } else {
      console.log('✅ Tabella migrations già esistente');
    }
    
    // Verifica l'integrità della tabella
    const integrityCheckQuery = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'migrations' 
      AND table_schema = 'public'
      ORDER BY ordinal_position;
    `;
    
    const { rows: columns } = await fastify.pg.query(integrityCheckQuery);
    const expectedColumns = ['id', 'migration_name', 'executed_at'];
    const actualColumns = columns.map(col => col.column_name);
    
    const missingColumns = expectedColumns.filter(col => !actualColumns.includes(col));
    if (missingColumns.length > 0) {
      throw new Error(`Tabella migrations corrotta. Colonne mancanti: ${missingColumns.join(', ')}`);
    }
    
    console.log('✅ Integrità della tabella migrations verificata');
    
  } catch (error) {
    console.error('❌ Errore durante la verifica/creazione della tabella migrations:', error);
    throw error;
  }
}
