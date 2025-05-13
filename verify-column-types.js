// Script per verificare il tipo della colonna parent_transaction_id

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function checkColumnType() {
  const pool = new pg.Pool({
    connectionString: process.env.POSTGRES_URL
  });
  
  try {
    console.log('🔍 Verifica tipo colonna parent_transaction_id...');
    
    const result = await pool.query(`
      SELECT table_name, column_name, data_type, udt_name 
      FROM information_schema.columns 
      WHERE column_name = 'parent_transaction_id' AND 
            table_name IN ('transactions', 'import_batches');
    `);
    
    console.log('Risultato:', result.rows);
    
    for (const column of result.rows) {
      console.log(`Tabella ${column.table_name}, colonna ${column.column_name}, tipo: ${column.data_type}, udt_name: ${column.udt_name}`);
      
      if (column.data_type === 'uuid' || column.udt_name === 'uuid') {
        console.log(`✅ La colonna parent_transaction_id nella tabella ${column.table_name} è di tipo UUID.`);
      } else {
        console.log(`❌ La colonna parent_transaction_id nella tabella ${column.table_name} NON è di tipo UUID!`);
      }
    }
  } catch (error) {
    console.error('❌ Errore:', error);
  } finally {
    await pool.end();
  }
}

checkColumnType();

checkColumnType();
