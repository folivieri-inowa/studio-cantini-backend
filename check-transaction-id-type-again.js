// Script per modificare il codice dell'endpoint per gestire l'UUID

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function checkTransactionIdType() {
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL
  });

  try {
    console.log('🔍 Verificando il tipo della colonna id della tabella transactions...');
    
    const query = `
      SELECT column_name, data_type, udt_name 
      FROM information_schema.columns 
      WHERE table_name = 'transactions' AND column_name = 'id';
    `;
    
    const result = await pool.query(query);
    
    console.log('Risultato:', result.rows);
    
  } catch (error) {
    console.error('❌ Errore durante la verifica del tipo della colonna:', error);
  } finally {
    await pool.end();
  }
}

checkTransactionIdType();
