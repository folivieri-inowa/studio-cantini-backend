// Script per verificare il tipo della colonna parent_transaction_id in import_batches

import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

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
    
    let importBatchesNeedsUpdate = true;
    
    for (const column of result.rows) {
      console.log(`Tabella ${column.table_name}, colonna ${column.column_name}, tipo: ${column.data_type}, udt_name: ${column.udt_name}`);
      
      if (column.table_name === 'import_batches') {
        if (column.data_type === 'uuid' || column.udt_name === 'uuid') {
          console.log('✅ La colonna parent_transaction_id nella tabella import_batches è già di tipo UUID.');
          importBatchesNeedsUpdate = false;
        }
      }
    }
    
    if (importBatchesNeedsUpdate) {
      console.log('⚠️ La colonna parent_transaction_id nella tabella import_batches non è di tipo UUID o non è stata trovata!');
      
      // Creiamo una nuova migrazione
      const migrationDir = path.join(process.cwd(), 'migrations');
      const date = new Date();
      const formattedDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      const migrationName = `${formattedDate}_002_fix_import_batches_parent_transaction_id.sql`;
      const migrationPath = path.join(migrationDir, migrationName);
      
      const migrationContent = `
-- Cambia il tipo della colonna parent_transaction_id nella tabella import_batches da INTEGER a UUID
ALTER TABLE import_batches 
ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;

-- Aggiungi un commento alla migrazione
COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale a cui sono associate le transazioni importate (UUID)';
`;
      
      fs.writeFileSync(migrationPath, migrationContent);
      console.log(`✅ Nuova migrazione creata: ${migrationPath}`);
    }
    
  } catch (error) {
    console.error('❌ Errore durante la verifica del tipo della colonna:', error);
  } finally {
    await pool.end();
  }
}

checkParentTransactionIdType();

checkParentTransactionIdType();
