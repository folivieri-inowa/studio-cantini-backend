// Script per inserire un nuovo utente nel database
// Genera automaticamente l'hash della password e inserisce l'utente

import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const fastify = Fastify({ logger: false });

fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

// Configurazione utente
const userData = {
  email: 'm.depietri@inowa.it',
  password: 'ACMilan86',
  name: 'Marco De Pietri',
  role: 'admin', // 'admin', 'manager', 'user'
  isActive: true
};

const SALT_ROUNDS = 12;

async function createUser() {
  try {
    await fastify.ready();
    console.log('🔗 Connesso al database\n');
    
    // Verifica se l'utente esiste già
    const existingUserQuery = 'SELECT id, email FROM users WHERE email = $1';
    const { rows: existingUsers } = await fastify.pg.query(existingUserQuery, [userData.email]);
    
    if (existingUsers.length > 0) {
      console.log(`❌ L'utente con email ${userData.email} esiste già!`);
      console.log(`   ID: ${existingUsers[0].id}`);
      console.log('\n🔄 Per aggiornare la password, utilizzare lo script di update');
      await fastify.close();
      return;
    }
    
    console.log('🔐 Generazione hash password...');
    const hashedPassword = await bcrypt.hash(userData.password, SALT_ROUNDS);
    
    console.log('👤 Inserimento nuovo utente...');
    const insertQuery = `
      INSERT INTO users (email, password, name, role, is_active, created_at, updated_at) 
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING id, email, name, role, is_active, created_at;
    `;
    
    const { rows } = await fastify.pg.query(insertQuery, [
      userData.email,
      hashedPassword,
      userData.name,
      userData.role,
      userData.isActive
    ]);
    
    const newUser = rows[0];
    
    console.log('✅ Utente creato con successo!\n');
    console.log('📄 Dettagli utente:');
    console.log('='.repeat(50));
    console.log(`   ID: ${newUser.id}`);
    console.log(`   Email: ${newUser.email}`);
    console.log(`   Nome: ${newUser.name}`);
    console.log(`   Ruolo: ${newUser.role}`);
    console.log(`   Attivo: ${newUser.is_active}`);
    console.log(`   Creato: ${new Date(newUser.created_at).toLocaleString('it-IT')}`);
    
    // Verifica che il login funzioni
    console.log('\n🔍 Verifica credenziali...');
    const loginQuery = 'SELECT id, email, password, name, role FROM users WHERE email = $1';
    const { rows: loginUsers } = await fastify.pg.query(loginQuery, [userData.email]);
    
    if (loginUsers.length > 0) {
      const isPasswordValid = await bcrypt.compare(userData.password, loginUsers[0].password);
      console.log(`✅ Test login: ${isPasswordValid ? 'SUCCESSO' : 'FALLITO'}`);
    }
    
    console.log('\n🎉 Operazione completata!');
    console.log(`💡 L'utente può ora fare login con:`);
    console.log(`   Email: ${userData.email}`);
    console.log(`   Password: ${userData.password}`);
    
  } catch (error) {
    console.error('❌ Errore durante la creazione dell\'utente:', error);
    
    if (error.code === '23505') {
      console.log('💡 Errore: Email già esistente nel database');
    }
  } finally {
    await fastify.close();
  }
}

createUser();
