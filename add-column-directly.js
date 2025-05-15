// Questo script esegue direttamente la query ALTER TABLE per aggiungere il campo is_credit_card alla tabella owners
import pg from 'pg';
import dotenv from 'dotenv';

// Carica le variabili d'ambiente
dotenv.config();

async function addColumn() {
  console.log('Inizio script per aggiungere la colonna is_credit_card...');
  
  if (!process.env.POSTGRES_URL) {
    console.error('ERRORE: Variabile d\'ambiente POSTGRES_URL non definita!');
    console.log('Assicurati che il file .env contenga la variabile POSTGRES_URL.');
    process.exit(1);
  }
  
  console.log('URL di connessione definito, provo a connettermi...');
  
  const client = new pg.Client({
    connectionString: process.env.POSTGRES_URL
  });
  
  try {
    await client.connect();
    console.log('Connessione al database stabilita con successo!');
    
    // Verifica se la colonna esiste già
    const checkQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'owners' AND column_name = 'is_credit_card';
    `;
    
    const checkResult = await client.query(checkQuery);
    
    if (checkResult.rows.length > 0) {
      console.log('La colonna is_credit_card esiste già nella tabella owners.');
    } else {
      console.log('La colonna is_credit_card non esiste, la aggiungo...');
      
      // Aggiungi la colonna
      await client.query('ALTER TABLE owners ADD COLUMN is_credit_card BOOLEAN DEFAULT FALSE;');
      await client.query(`COMMENT ON COLUMN owners.is_credit_card IS 'Indica se il record è riferito ad una carta di credito (TRUE) o no (FALSE)';`);
      
      console.log('Colonna is_credit_card aggiunta con successo!');
    }
    
    // Verifica la struttura finale della tabella
    const columnsQuery = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'owners'
      ORDER BY ordinal_position;
    `;
    
    const columnsResult = await client.query(columnsQuery);
    
    console.log('\nStruttura attuale della tabella owners:');
    columnsResult.rows.forEach(row => {
      console.log(`- ${row.column_name} (${row.data_type})`);
    });
    
  } catch (err) {
    console.error('ERRORE durante l\'esecuzione:', err);
  } finally {
    await client.end();
    console.log('Script completato.');
  }
}

// Esegui la funzione
addColumn();
