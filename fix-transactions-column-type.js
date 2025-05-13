// Script per correggere direttamente il tipo di colonna parent_transaction_id

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL
});

async function fixColumnType() {
  try {
    console.log('🔄 Correzione del tipo di colonna parent_transaction_id...');
    
    // 1. Verifica lo stato attuale
    const checkResult = await pool.query(`
      SELECT data_type, udt_name 
      FROM information_schema.columns 
      WHERE table_name = 'transactions' 
      AND column_name = 'parent_transaction_id'
    `);
    
    if (checkResult.rows.length > 0) {
      const { data_type, udt_name } = checkResult.rows[0];
      console.log(`📊 Stato attuale: parent_transaction_id è di tipo ${data_type} (${udt_name})`);
      
      if (data_type !== 'uuid' && udt_name !== 'uuid') {
        console.log('⚙️ Modifico direttamente la colonna...');
        
        // 2. Elimina eventuali vincoli
        await pool.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
            ) THEN
              ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
            END IF;
          END $$;
        `);
        
        // 3. Modifica il tipo
        await pool.query(`
          ALTER TABLE transactions 
          ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;
        `);
        
        console.log('✅ Colonna modificata in UUID');
        
        // 4. Ricrea il vincolo
        await pool.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
            ) THEN
              ALTER TABLE transactions
              ADD CONSTRAINT fk_transaction_parent
              FOREIGN KEY (parent_transaction_id)
              REFERENCES transactions(id)
              ON DELETE SET NULL;
            END IF;
          END $$;
        `);
        
        console.log('✅ Vincolo ricreato');
      } else {
        console.log('✅ Il tipo è già UUID');
      }
    } else {
      console.log('❌ Colonna non trovata!');
    }
  } catch (error) {
    console.error('❌ Errore:', error);
  } finally {
    await pool.end();
  }
}

fixColumnType();

fixColumnType();
