import Fastify from 'fastify';
import dotenv from 'dotenv';
import cors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart';
import fastifyPostgres from '@fastify/postgres';
// Routes
import {
  AuthRoutes,
  CategoryRoutes,
  DetailRoutes,
  FileManagerRoutes,
  OwnerRoutes,
  ReportRoutes,
  SubjectRoutes,
  TransactionRoutes,
  TransactionImportAssociatedRoutes,
  UploadRoutes,
} from './routes/index.js';
// Migrazione database
import { runMigrations } from './lib/migrations.js';

// Load environment variables from .env file
dotenv.config();

// Require the framework and instantiate it
const fastify = Fastify({ logger: false });

fastify.register(fastifyPostgres, {
  promise: true, // Usa le promise invece dei callback
  connectionString: process.env.POSTGRES_URL,
})

// CORS
fastify.register(cors, {
  origin: '*',
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// Multipart form data
fastify.register(fastifyMultipart);

// Declare a routes
fastify.register(AuthRoutes, { prefix: '/v1/auth' })
fastify.register(OwnerRoutes, { prefix: '/v1/owner' })
fastify.register(CategoryRoutes, { prefix: '/v1/category' })
fastify.register(SubjectRoutes, { prefix: '/v1/subject' })
fastify.register(DetailRoutes, { prefix: '/v1/detail' })
fastify.register(TransactionRoutes, { prefix: '/v1/transaction' })
fastify.register(TransactionImportAssociatedRoutes, { prefix: '/v1/transaction' })
fastify.register(ReportRoutes, { prefix: '/v1/report' })
fastify.register(UploadRoutes, { prefix: '/v1/upload' })
fastify.register(FileManagerRoutes, { prefix: '/v1/file-manager' })

fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Hello World' });
})

// Middleware di gestione degli errori
fastify.setErrorHandler(function (error, request, reply) {
  fastify.log.error(error); // Logga l'errore
  reply.status(500).send({ error: 'Internal Server Error' });
});

/**
 * Run the server!
*/

const start = async () => {
  try {
    // Attendi che tutti i plugin siano registrati prima di eseguire le migrazioni
    await fastify.ready();
    
    // Esegui le migrazioni del database prima di avviare il server
    console.log('Esecuzione delle migrazioni del database...');
    await runMigrations(fastify);
    
    // Avvia il server dopo aver completato le migrazioni
    if (process.env.PROD) {
      console.log('Run in production');
      await fastify.listen({ port: process.env.PORT, host: '0.0.0.0' });
    } else {
      console.log('Run in development');
      await fastify.listen({ port: process.env.PORT });
    }
    console.log(`Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    console.error('Errore durante l\'avvio del server:', err);
    process.exit(1);
  }
};

start();