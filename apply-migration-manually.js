import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Ottieni il percorso assoluto del file di migrazione
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.join(__dirname, 'migrations', '20250516_001_add_is_credit_card_to_owners.sql');

// Carica le variabili d'ambiente
dotenv.config();

const { Pool } = pg;

async function applyMigration() {
  // Crea un pool di connessione
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
  });

  // Connessione al database
  const client = await pool.connect();

  try {
    console.log('Verifico prima la struttura attuale della tabella owners...');
    
    // Query per ottenere la struttura della tabella prima della migrazione
    const beforeResult = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'owners'
      ORDER BY ordinal_position
    `);
    
    console.log('Struttura della tabella owners prima:');
    beforeResult.rows.forEach(row => {
      console.log(`${row.column_name} - ${row.data_type} - Default: ${row.column_default} - Nullable: ${row.is_nullable}`);
    });

    console.log('\nApplico la migrazione manualmente...');
    
    // Leggi il file SQL di migrazione
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    console.log('Contenuto del file di migrazione:');
    console.log(migrationSql);
    
    // Inizia una transazione
    await client.query('BEGIN');
    
    // Esegui la migrazione
    await client.query(migrationSql);
    
    // Registra la migrazione (se non già registrata)
    const checkResult = await client.query(
      'SELECT migration_name FROM migrations WHERE migration_name = $1',
      ['20250516_001_add_is_credit_card_to_owners.sql']
    );
    
    if (checkResult.rows.length === 0) {
      await client.query(
        'INSERT INTO migrations (migration_name, executed_at) VALUES ($1, NOW())',
        ['20250516_001_add_is_credit_card_to_owners.sql']
      );
      console.log('Migrazione registrata nella tabella migrations');
    } else {
      console.log('Migrazione già presente nella tabella migrations');
    }
    
    // Commit della transazione
    await client.query('COMMIT');
    
    // Verifica la struttura della tabella dopo la migrazione
    console.log('\nVerifica della struttura della tabella owners dopo la migrazione:');
    const afterResult = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'owners'
      ORDER BY ordinal_position
    `);
    
    console.log('Struttura della tabella owners dopo:');
    afterResult.rows.forEach(row => {
      console.log(`${row.column_name} - ${row.data_type} - Default: ${row.column_default} - Nullable: ${row.is_nullable}`);
    });

    console.log('\nMigrazione applicata con successo!');
  } catch (error) {
    // Rollback in caso di errore
    await client.query('ROLLBACK');
    console.error('Errore durante l\'applicazione della migrazione:', error);
  } finally {
    // Rilascia il client
    client.release();
    
    // Chiudi il pool
    await pool.end();
  }
}

// Esegui la funzione
applyMigration();
