// Script per verificare se la colonna import_batch_id esiste nella tabella transactions
// e aggiungerla se mancante

import pg from 'pg';
import dotenv from 'dotenv';

// Carica le variabili d'ambiente
dotenv.config();

const { Client } = pg;

async function checkColumn() {
  const client = new Client({
    connectionString: process.env.POSTGRES_URL
  });
  
  try {
    await client.connect();
    console.log('✅ Connesso al database');
    
    const result = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'transactions' 
        AND column_name = 'import_batch_id'
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ La colonna import_batch_id esiste nella tabella transactions');
    } else {
      console.log('❌ La colonna import_batch_id NON esiste nella tabella transactions');
      
      // Aggiungiamo la colonna manualmente
      console.log('🔄 Tentativo di aggiunta manuale della colonna...');
      await client.query(`
        ALTER TABLE transactions 
        ADD COLUMN IF NOT EXISTS import_batch_id INTEGER;
      `);
      console.log('✅ Colonna import_batch_id aggiunta manualmente');
      
      // Aggiungiamo la foreign key
      console.log('🔄 Aggiunta foreign key...');
      await client.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch'
            ) THEN
                ALTER TABLE transactions
                ADD CONSTRAINT fk_import_batch
                FOREIGN KEY (import_batch_id)
                REFERENCES import_batches(id)
                ON DELETE SET NULL;
            END IF;
        END $$;
      `);
      console.log('✅ Foreign key aggiunta');
      
      // Aggiungiamo l'indice
      console.log('🔄 Aggiunta indice...');
      await client.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_indexes WHERE indexname = 'idx_transactions_import_batch_id'
            ) THEN
                CREATE INDEX idx_transactions_import_batch_id ON transactions(import_batch_id);
            END IF;
        END $$;
      `);
      console.log('✅ Indice aggiunto');
      
      // Verifichiamo di nuovo
      const checkResult = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'transactions' 
          AND column_name = 'import_batch_id'
      `);
      
      if (checkResult.rows.length > 0) {
        console.log('✅ Verifica: la colonna import_batch_id ora esiste nella tabella transactions');
      } else {
        console.log('❌ La colonna import_batch_id non è stata aggiunta correttamente');
      }
    }
  } catch (err) {
    console.error('❌ Errore durante la verifica della colonna:', err);
  } finally {
    await client.end();
  }
}

checkColumn();
