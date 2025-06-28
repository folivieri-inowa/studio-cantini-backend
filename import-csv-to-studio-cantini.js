import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

/**
 * Parse CSV file and return rows as objects
 */
function parseCSV(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Use proper CSV parser that handles quoted fields correctly
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true
    });
    
    return records;
  } catch (error) {
    console.error(`⚠️ Errore nel leggere il file ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Map CSV fields to database columns
 */  function mapOwnerFields(ownerRecord) {
  return {
    id: ownerRecord.id,
    name: ownerRecord.name,
    cc: ownerRecord.cc,
    iban: ownerRecord.iban,
    email: ownerRecord.email || `${ownerRecord.name.toLowerCase().replace(/\s/g, '.')}@example.com`,
    initialbalance: parseFloat(ownerRecord.initialbalance) || 0,
    date: ownerRecord.date ? new Date(ownerRecord.date) : null,
    db: ownerRecord.db,
    is_credit_card: ownerRecord.cc === 'true' || ownerRecord.cc === '1' || false
  };
}

/**
 * Parse JSON string safely, return null if invalid
 */
function safeParseJSON(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Errore nel parsing del JSON:', error.message);
    return null;
  }
}

/**
 * Clear existing data and import from CSV
 */
async function importData() {
  const client = await pool.connect();
  
  try {
    console.log('🧹 Pulizia dei dati esistenti...');
    
    // Disabilita temporaneamente i vincoli di foreign key
    await client.query('SET session_replication_role = replica');
    
    // Svuota le tabelle in ordine corretto
    await client.query('TRUNCATE TABLE transactions CASCADE');
    await client.query('TRUNCATE TABLE import_batches CASCADE');
    await client.query('TRUNCATE TABLE details CASCADE');
    await client.query('TRUNCATE TABLE subjects CASCADE');
    await client.query('TRUNCATE TABLE categories CASCADE');
    // Non svuotiamo la tabella owners e users, in modo da mantenere gli utenti esistenti
    
    // Riabilita i vincoli di foreign key
    await client.query('SET session_replication_role = DEFAULT');
    
    console.log('📁 Lettura dei file CSV...');
    
    // Read CSV files from classificatore/data/export
    const dataDir = path.join(__dirname, '..', 'classificatore', 'data', 'export');
    const categories = parseCSV(path.join(dataDir, 'categories.csv'));
    const subjects = parseCSV(path.join(dataDir, 'subjects.csv'));
    const details = parseCSV(path.join(dataDir, 'details.csv'));
    const owners = parseCSV(path.join(dataDir, 'owners.csv'));
    const transactions = parseCSV(path.join(dataDir, 'transactions.csv'));
    const users = parseCSV(path.join(dataDir, 'users.csv'));
    
    console.log(`📊 Riepilogo dati:
    - Categorie: ${categories.length}
    - Soggetti: ${subjects.length}
    - Dettagli: ${details.length}
    - Proprietari: ${owners.length}
    - Transazioni: ${transactions.length}
    - Utenti: ${users.length}`);
    
    // Import users
    console.log('👤 Importazione utenti...');
    let importedUsers = 0;
    for (const user of users) {
      try {
        // Parse JSON dbrole field
        const dbrole = safeParseJSON(user.dbrole) || [];
        
        // Prima verifica se l'utente esiste già
        const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [user.email]);
        
        if (existingUser.rowCount > 0) {
          console.log(`⚠️ Utente con email ${user.email} già esistente, aggiornamento non effettuato`);
          importedUsers++; // Consideriamo importato perché esiste già
          continue;
        }
        
        await client.query(
          'INSERT INTO users (id, email, password, created_at, updated_at, firstname, lastname, dbrole) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ' +
          'ON CONFLICT (id) DO NOTHING', // Modifichiamo con DO NOTHING per evitare conflitti
          [
            user.id,
            user.email,
            user.password,
            user.created_at ? new Date(user.created_at) : new Date(),
            user.updated_at ? new Date(user.updated_at) : new Date(),
            user.firstname,
            user.lastname,
            JSON.stringify(dbrole)
          ]
        );
        importedUsers++;
      } catch (err) {
        console.error(`❌ Errore nell'importazione dell'utente ${user.id}:`, err.message);
      }
    }
    console.log(`✅ Importati ${importedUsers}/${users.length} utenti`);
    
    // Import owners first
    console.log('👥 Importazione proprietari...');
    for (const ownerRecord of owners) {
      const owner = mapOwnerFields(ownerRecord);
      
      await client.query(
        'INSERT INTO owners (id, name, cc, iban, db, initialbalance, "date", email, is_credit_card) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ' +
        'ON CONFLICT (id) DO NOTHING',
        [
          owner.id, owner.name, owner.cc, owner.iban, owner.db, 
          owner.initialbalance, owner.date, owner.email, owner.is_credit_card
        ]
      );
    }
    
    // Import categories
    console.log('📂 Importazione categorie...');
    for (const category of categories) {
      await client.query(
        'INSERT INTO categories (id, name, db) ' +
        'VALUES ($1, $2, $3) ' +
        'ON CONFLICT (id) DO NOTHING',
        [
          category.id, 
          category.name, 
          category.db
        ]
      );
    }
    
    // Import subjects
    console.log('👤 Importazione soggetti...');
    for (const subject of subjects) {
      await client.query(
        'INSERT INTO subjects (id, name, category_id, db) ' +
        'VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (id) DO NOTHING',
        [
          subject.id, 
          subject.name, 
          subject.category_id, 
          subject.db
        ]
      );
    }
    
    // Import details
    console.log('🔍 Importazione dettagli...');
    for (const detail of details) {
      await client.query(
        'INSERT INTO details (id, name, subject_id, db) ' +
        'VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (id) DO NOTHING',
        [
          detail.id, 
          detail.name, 
          detail.subject_id, 
          detail.db
        ]
      );
    }
    
    // Import transactions
    console.log('💰 Importazione transazioni...');
    let importedTransactions = 0;
    for (const transaction of transactions) {
      try {
        // Parse date correctly
        let transactionDate = null;
        if (transaction.date) {
          // Try to parse date in format YYYY-MM-DD
          transactionDate = new Date(transaction.date);
          if (isNaN(transactionDate.getTime())) {
            // Try to parse Italian format DD/MM/YYYY
            const parts = transaction.date.split('/');
            if (parts.length === 3) {
              transactionDate = new Date(parts[2], parts[1] - 1, parts[0]);
            }
          }
        }
        
        // Ensure date is valid
        if (!transactionDate || isNaN(transactionDate.getTime())) {
          transactionDate = new Date();
        }
        
        await client.query(
          'INSERT INTO transactions (id, db, date, amount, categoryid, subjectid, detailid, description, ' +
          'note, ownerid, paymenttype, status) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ' +
          'ON CONFLICT (id) DO NOTHING',
          [
            transaction.id,
            transaction.db,
            transactionDate,
            parseFloat(transaction.amount) || 0,
            transaction.categoryid || null,
            transaction.subjectid || null,
            transaction.detailid || null,
            transaction.description || '',
            transaction.note || '',
            transaction.ownerid,
            transaction.paymenttype || 'cash',
            transaction.status || 'pending'
          ]
        );
        
        importedTransactions++;
      } catch (err) {
        console.error(`❌ Errore nell'importazione della transazione ${transaction.id}:`, err.message);
      }
    }
    
    console.log(`✅ Importazione completata con successo!`);
    console.log(`📊 Statistiche importazione:
    - Transazioni importate: ${importedTransactions}/${transactions.length}`);
    
  } catch (error) {
    console.error('❌ Importazione fallita:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the import process
console.log('🚀 Avvio importazione dati CSV...');

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

importData()
  .then(() => {
    console.log('🎉 Processo completato!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Processo fallito:', error);
    process.exit(1);
  })
  .finally(() => {
    pool.end().catch(err => {
      console.error('Errore nella chiusura della connessione al pool:', err);
    });
  });
