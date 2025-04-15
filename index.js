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
  UploadRoutes,
} from './routes/index.js';

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

if (process.env.PROD) {
  console.log('Run in production');
  fastify.listen({ port: process.env.PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Server listening on ${address}`);
  });
} else {
  console.log('Run in development');
  fastify.listen({ port: process.env.PORT }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Server listening on ${address}`);
  });
}