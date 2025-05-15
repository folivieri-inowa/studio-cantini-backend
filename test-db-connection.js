// test-db-connection.js
import { Pool } from 'pg';
import dotenv from 'dotenv';

// Carica le variabili d'ambiente
dotenv.config();

async function testConnection() {
  // Stampa l'URL di connessione (nascondendo credenziali)
  const connectionString = process.env.POSTGRES_URL || '';
  const maskedUrl = connectionString.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
  console.log('Connessione a:', maskedUrl);

  // Crea un pool di connessione
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
  });

  try {
    console.log('Provo a connettermi al database...');
    
    // Prova una semplice query per verificare la connessione
    const result = await pool.query('SELECT NOW() as time');
    
    console.log('Connessione riuscita!');
    console.log('Ora del server:', result.rows[0].time);
    
    // Verifica se la tabella owners esiste
    console.log('\nVerifica esistenza tabella owners...');
    const tableResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'owners'
      );
    `);
    
    if (tableResult.rows[0].exists) {
      console.log('La tabella owners esiste!');
      
      // Verifica colonne della tabella
      const columnsResult = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'owners'
        ORDER BY ordinal_position;
      `);
      
      console.log('\nColonne della tabella owners:');
      columnsResult.rows.forEach(row => {
        console.log(`- ${row.column_name} (${row.data_type})`);
      });
    } else {
      console.log('La tabella owners non esiste!');
    }
  } catch (error) {
    console.error('Errore di connessione:', error.message);
  } finally {
    // Chiudi il pool
    await pool.end();
  }
}

// Esegui il test
testConnection();
