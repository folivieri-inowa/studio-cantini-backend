FROM node:20-alpine

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
ENV PORT=9000

# Copia il resto dei file dell'applicazione
COPY --chown=node:node . .

# Esponi la porta
EXPOSE 9000

# Avvia l'applicazione
CMD ["yarn", "start"]