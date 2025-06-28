// Script per verificare gli utenti nel database

import pkg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pkg;
dotenv.config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

async function checkUsers() {
  try {
    const res = await pool.query('SELECT email, firstname, lastname, dbrole FROM users');
    
    console.log('👤 Utenti nel database:');
    if (res.rows.length === 0) {
      console.log(' - Nessun utente trovato');
    } else {
      res.rows.forEach(row => {
        console.log(` - ${row.email} (${row.firstname} ${row.lastname})`);
        console.log(`   Ruoli: ${JSON.stringify(row.dbrole)}`);
      });
    }
  } catch (err) {
    console.error('Errore:', err);
  } finally {
    await pool.end();
  }
}

checkUsers();
