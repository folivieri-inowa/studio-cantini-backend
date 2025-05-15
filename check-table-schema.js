import pg from 'pg';
import dotenv from 'dotenv';

// Carica le variabili d'ambiente
dotenv.config();

const { Pool } = pg;

async function checkTableSchema() {
  // Crea un pool di connessione
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
  });

  try {
    console.log('Verifico la struttura della tabella owners...');
    
    // Query per ottenere la struttura della tabella
    const tableResult = await pool.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'owners'
      ORDER BY ordinal_position
    `);
    
    console.log('Struttura della tabella owners:');
    tableResult.rows.forEach(row => {
      console.log(`${row.column_name} - ${row.data_type} - Default: ${row.column_default} - Nullable: ${row.is_nullable}`);
    });

    // Verifico anche le migrazioni eseguite
    console.log('\nMigrazioni eseguite:');
    const migrationResult = await pool.query('SELECT migration_name, executed_at FROM migrations ORDER BY executed_at');
    migrationResult.rows.forEach(row => {
      console.log(`${row.migration_name} - ${row.executed_at}`);
    });
  } catch (error) {
    console.error('Errore durante la verifica della struttura della tabella:', error);
  } finally {
    // Chiudi il pool di connessione
    await pool.end();
  }
}

// Esegui la funzione
checkTableSchema();
