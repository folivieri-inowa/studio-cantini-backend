// Script per verificare il tipo della colonna parent_transaction_id

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function checkParentTransactionIdType() {
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL
  });

  try {
    console.log('🔍 Verificando il tipo della colonna parent_transaction_id...');
    
    const query = `
      SELECT table_name, column_name, data_type, udt_name 
      FROM information_schema.columns 
      WHERE column_name = 'parent_transaction_id' AND 
            table_name IN ('transactions', 'import_batches');
    `;
    
    const result = await pool.query(query);
    
    console.log('Risultato:', result.rows);
    
  } catch (error) {
    console.error('❌ Errore durante la verifica del tipo della colonna:', error);
  } finally {
    await pool.end();
  }
}

checkParentTransactionIdType();
