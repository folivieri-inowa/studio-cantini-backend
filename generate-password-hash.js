// Script per generare hash delle password per la tabella users
// Utilizza bcrypt come il sistema di autenticazione del backend

import bcrypt from 'bcrypt';

// Configurazione
const SALT_ROUNDS = 12; // Stesso valore usato nel backend per sicurezza
const email = 'm.depietri@inowa.it';
const password = 'ACMilan86!';

async function generatePasswordHash() {
  try {
    console.log('🔐 Generazione hash password...\n');
    
    // Genera l'hash della password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    
    console.log('📧 Email:', email);
    console.log('🔑 Password originale:', password);
    console.log('🔒 Password hashata:', hashedPassword);
    
    // Verifica che l'hash sia corretto
    const isValid = await bcrypt.compare(password, hashedPassword);
    console.log('✅ Verifica hash:', isValid ? 'VALIDO' : 'ERRORE');
    
    console.log('\n📋 Query SQL per inserire l\'utente:');
    console.log('='.repeat(70));
    
    const insertQuery = `INSERT INTO users (email, password, name, role, is_active, created_at, updated_at) 
VALUES ('${email}', '${hashedPassword}', 'Marco De Pietri', 'admin', true, NOW(), NOW());`;
    
    console.log(insertQuery);
    
    console.log('\n📋 Query SQL per verificare l\'inserimento:');
    console.log('='.repeat(70));
    console.log(`SELECT id, email, name, role, is_active, created_at FROM users WHERE email = '${email}';`);
    
    console.log('\n💡 Note:');
    console.log('   • L\'hash è generato con 12 salt rounds per sicurezza');
    console.log('   • Il ruolo è impostato come "admin" - modificare se necessario');
    console.log('   • L\'utente è attivo per default');
    console.log('   • Il nome può essere modificato nella query');
    
  } catch (error) {
    console.error('❌ Errore durante la generazione dell\'hash:', error);
    process.exit(1);
  }
}

// Genera l'hash
generatePasswordHash();
