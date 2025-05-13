FROM node:20-alpine

# Installa le dipendenze necessarie per wait-for-it.sh
RUN apk add --no-cache bash postgresql-client

# Creazione della directory dell'applicazione e impostazione delle permissions
RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

# Imposta la directory di lavoro
WORKDIR /home/node/app

# Copia i file package.json e package-lock.json
COPY package*.json ./

# Passa all'utente node per una maggiore sicurezza
USER node

# Installa le dipendenze
RUN yarn install

# Imposta le variabili d'ambiente
ENV PROD=true
ENV NODE_ENV=production

# Copia il resto dei file dell'applicazione
COPY --chown=node:node . .

# Crea uno script per attendere il database
USER root
RUN echo '#!/bin/bash \n\
echo "Attesa per il database PostgreSQL..." \n\
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER"; do \n\
  echo "Database non ancora disponibile. Attendo 2 secondi..." \n\
  sleep 2 \n\
done \n\
echo "Database disponibile, avvio dell\'applicazione..." \n\
su node -c "yarn start"' > /wait-for-postgres.sh

# Rendi lo script eseguibile
RUN chmod +x /wait-for-postgres.sh

# Esponi la porta
EXPOSE 9001

# Avvia l'applicazione
CMD ["/wait-for-postgres.sh"]
